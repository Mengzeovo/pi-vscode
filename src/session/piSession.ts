import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import type { MessageConnection } from "vscode-jsonrpc/node";
import {
	CopilotInvoke,
	EditorDefinition,
	EditorDiagnostics,
	EditorReferences,
	ENV_IPC_PATH,
	ENV_IPC_TOKEN,
	FileCommit,
	FileReadBase,
	RecordRequest,
	type ReferenceRecord,
	REWIND_COMMAND,
	SetTurnTools,
} from "../../shared/protocol";
import { ExtensionUiBridge } from "../chat/extensionUi";
import { userMessageText } from "../chat/historyRenderer";
import { StreamRenderer } from "../chat/streamRenderer";
import { FileGate } from "../edits/fileGate";
import type { SnapshotStore } from "../edits/snapshotStore";
import { IpcServer } from "../ipc/ipcServer";
import type { ThinkingLevel } from "../pi/catalog";
import type { PiRuntime } from "../pi/piRuntime";
import { describeExit, PiRpcProcess, type PiProcessExit } from "../pi/rpcProcess";
import { WriteLock } from "../sessions/writeLock";
import { availableCopilotTools, invokeCopilotTool } from "../tools/copilotTools";
import { findDefinitions, findReferences, readDiagnostics } from "../tools/editorTools";
import { Deferred, delay } from "../util/deferred";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const YIELD_POLL_MS = 100;

export interface SessionLocation {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionDir: string;
	/** Pi 尚未写入会话文件时为 Pi 计划使用的路径或 undefined */
	sessionFile: string | undefined;
}

export interface ModelSelection {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string | undefined;
}

export interface SessionServices {
	readonly runtime: PiRuntime;
	readonly piExtensionPath: string;
	readonly snapshots: SnapshotStore;
	readonly log: (line: string) => void;
	/** 会话标题变化（Pi 扩展的 setTitle） */
	readonly onTitle: (sessionId: string, title: string) => void;
	/** 会话进程退出、写入权限释放后通知 */
	readonly onReleased: (sessionId: string) => void;
	/** Pi 写入会话文件后通知（用于刷新列表） */
	readonly onSessionFile: (location: SessionLocation) => void;
	/** Pi 空闲多久后结束进程 */
	readonly idleShutdownMs: () => number;
}

interface Binding {
	readonly kind: "participant" | "callback";
	readonly stream: vscode.ChatResponseStream;
	readonly token: vscode.CancellationToken;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	readonly settled: Deferred<RunOutcome>;
}

export interface RunOutcome {
	readonly aborted: boolean;
	readonly error: string | undefined;
	readonly interrupted: boolean;
}

interface PendingRequest {
	readonly requestId: string;
	readonly userText: string;
	readonly references: readonly ReferenceRecord[];
	readonly mode: "first" | "steer";
	expectedText: string | undefined;
}

export interface PromptInput {
	readonly requestId: string;
	readonly promptText: string;
	readonly userText: string;
	readonly references: readonly ReferenceRecord[];
	readonly images: readonly ImageContent[];
	readonly enabledCopilotTools: readonly string[];
	readonly selection: ModelSelection | undefined;
}

export class CancelledByUser extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Canceled";
	}
}

/** 一个 Pi 会话在本窗口中的运行状态：子进程、写入权限、IPC 和当前承接输出的响应流 */
export class PiSession implements vscode.Disposable {
	private process: PiRpcProcess | undefined;
	private ipc: IpcServer | undefined;
	private lock: WriteLock | undefined;
	private externalWritersConfirmed = false;
	private busy = false;
	private binding: Binding | undefined;
	private renderer: StreamRenderer | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private buffered: JsonAgentSessionEvent[] = [];
	private unpersisted: JsonAgentSessionEvent[] = [];
	private discardUntilSettled = false;
	private stopping: Promise<void> | undefined;
	private readonly pending: PendingRequest[] = [];
	private lastSteering: readonly string[] = [];
	private readonly shownCopilotCalls = new Set<string>();
	private readonly ui: ExtensionUiBridge;
	readonly fileGate: FileGate;
	readonly requestEntries = new Map<string, string>();
	private appliedSelection: string | undefined;
	private idleWaiters: Array<() => void> = [];
	private contentReleased = false;
	private pendingChatDialogs = 0;
	private starting: Promise<void> | undefined;
	private exitSubscriptions: Array<() => void> = [];
	/** 本窗口中由扩展创建（还没有文件的新会话或分叉出的会话），首次写入时不需要确认其他写入方 */
	createdHere: boolean;

	constructor(
		readonly location: SessionLocation,
		private readonly services: SessionServices,
		createdHere: boolean,
	) {
		this.createdHere = createdHere;
		this.fileGate = new FileGate(services.snapshots, () => (this.binding?.kind === "participant" ? this.binding.stream : undefined));
		this.ui = new ExtensionUiBridge({
			participantStream: () => {
				const binding = this.binding;
				if (binding?.kind !== "participant") {
					return undefined;
				}
				return {
					stream: {
						...binding.stream,
						questionCarousel: async (questions: vscode.ChatQuestion[], allowSkip?: boolean) => {
							this.pendingChatDialogs++;
							try {
								return await binding.stream.questionCarousel(questions, allowSkip);
							} finally {
								this.pendingChatDialogs--;
							}
						},
					} as vscode.ChatResponseStream,
					token: binding.token,
				};
			},
			respond: (response) => this.requireProcess().respondUi(response),
			setTitle: (title) => services.onTitle(location.sessionId, title),
			sessionLabel: () => `Pi ${location.sessionId.slice(0, 8)}`,
		});
	}

	get isBusy(): boolean {
		return this.busy;
	}

	get isRunning(): boolean {
		return this.process !== undefined && !this.process.hasExited;
	}

	get holdsWritePermission(): boolean {
		return this.lock !== undefined;
	}

	get processId(): number | undefined {
		return this.process?.pid;
	}

	copilotCallShownByVsCode(toolCallId: string): boolean {
		return this.shownCopilotCalls.has(toolCallId);
	}

	/** 取得写入权限；其他窗口持有时报错，尚未持有的已有会话需要用户确认已关闭其他写入方 */
	async ensureWritePermission(): Promise<void> {
		if (this.lock) {
			return;
		}
		const lock = await WriteLock.acquire(this.location.cwd, this.location.sessionId);
		if (!lock) {
			throw new Error("这个 Pi 会话正在另一个 VS Code 窗口中运行，请在那个窗口中继续，或先在那个窗口中把它交给终端。");
		}
		const hasFile = this.location.sessionFile !== undefined && existsSync(this.location.sessionFile);
		if (hasFile && !this.createdHere && !this.externalWritersConfirmed) {
			const choice = await vscode.window.showWarningMessage(
				"继续这个 Pi 会话之前，请先关闭终端或其他程序中打开的同一个会话。两个 Pi 进程同时写入同一个会话文件会损坏历史。",
				{ modal: true },
				"已关闭，继续",
			);
			if (choice !== "已关闭，继续") {
				await lock.release();
				throw new CancelledByUser("用户取消了继续该会话");
			}
			this.externalWritersConfirmed = true;
		}
		this.lock = lock;
	}

	/** 启动 Pi 进程并完成 IPC 握手；已运行时直接返回 */
	ensureStarted(): Promise<void> {
		if (this.process && !this.process.hasExited) {
			return Promise.resolve();
		}
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async start(): Promise<void> {
		if (!this.lock) {
			throw new Error("启动 Pi 进程前需要取得写入权限");
		}
		const ipc = await IpcServer.listen(
			() => ({ copilotTools: availableCopilotTools() }),
			(connection) => this.configureConnection(connection),
		);
		const hasFile = this.location.sessionFile !== undefined && existsSync(this.location.sessionFile);
		const args = [
			...(hasFile ? ["--session", this.location.sessionFile as string] : ["--session-id", this.location.sessionId]),
			"--session-dir",
			this.location.sessionDir,
			"--extension",
			this.services.piExtensionPath,
		];
		const process = new PiRpcProcess({
			runtime: this.services.runtime,
			cwd: this.location.cwd,
			args,
			env: { [ENV_IPC_PATH]: ipc.endpoint.path, [ENV_IPC_TOKEN]: ipc.endpoint.token },
			label: `会话 ${this.location.sessionId.slice(0, 8)}`,
			log: this.services.log,
		});
		this.process = process;
		this.ipc = ipc;
		this.appliedSelection = undefined;
		this.exitSubscriptions = [
			process.onEvent((event) => this.onEvent(event)),
			process.onExtensionUiRequest((request) => this.ui.handle(request)),
			process.onExit((exit) => this.onExit(process, exit)),
		];
		const exited = process.whenExited.then((exit) => {
			throw new Error(`Pi 进程在完成握手前退出，${describeExit(exit)}`);
		});
		const timeout = delay(HANDSHAKE_TIMEOUT_MS).then(() => {
			throw new Error(`Pi 扩展在 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒内没有完成 IPC 握手`);
		});
		try {
			await Promise.race([ipc.whenConnected(), exited, timeout]);
			const state = await process.send({ type: "get_state" });
			if (state.sessionId !== this.location.sessionId) {
				throw new Error(`Pi 打开的会话 ${state.sessionId} 与预期的 ${this.location.sessionId} 不一致`);
			}
			if (hasFile && (state.sessionFile === undefined || resolve(state.sessionFile).toLowerCase() !== resolve(this.location.sessionFile as string).toLowerCase())) {
				throw new Error(`Pi 打开的会话文件 ${state.sessionFile ?? "无"} 与预期的 ${this.location.sessionFile} 不一致`);
			}
			this.location.sessionFile = state.sessionFile;
			this.scheduleIdleShutdown();
		} catch (error) {
			process.kill();
			await ipc.close();
			throw error;
		}
	}

	private configureConnection(connection: MessageConnection): void {
		const cwd = this.location.cwd;
		connection.onRequest(EditorDefinition, (params) => findDefinitions(cwd, params));
		connection.onRequest(EditorReferences, (params) => findReferences(cwd, params));
		connection.onRequest(EditorDiagnostics, (params) => readDiagnostics(cwd, params));
		connection.onRequest(FileReadBase, (params) => this.fileGate.readBase(params));
		connection.onRequest(FileCommit, (params) => this.fileGate.commit(params));
		connection.onRequest(CopilotInvoke, async (params, token) => {
			const binding = this.binding;
			if (binding?.kind !== "participant" || binding.toolInvocationToken === undefined) {
				throw new Error("当前没有正在处理的 VS Code 请求，Copilot 工具需要等待用户的下一个请求");
			}
			this.shownCopilotCalls.add(params.toolCallId);
			const source = new vscode.CancellationTokenSource();
			const subscriptions = [token.onCancellationRequested(() => source.cancel()), binding.token.onCancellationRequested(() => source.cancel())];
			try {
				return await invokeCopilotTool(params.name, params.input, binding.toolInvocationToken, source.token);
			} finally {
				for (const subscription of subscriptions) {
					subscription.dispose();
				}
				source.dispose();
			}
		});
	}

	private requireProcess(): PiRpcProcess {
		if (!this.process || this.process.hasExited) {
			throw new Error("Pi 进程没有运行");
		}
		return this.process;
	}

	private requireConnection(): MessageConnection {
		const connection = this.ipc?.current;
		if (!connection) {
			throw new Error("与 Pi 扩展的 IPC 连接不可用");
		}
		return connection;
	}

	/** 把发送前的模型和思考级别选择应用到会话进程：先 set_model，再 set_thinking_level */
	private async applySelection(selection: ModelSelection | undefined): Promise<void> {
		if (!selection) {
			return;
		}
		const key = `${selection.provider}/${selection.modelId}:${selection.thinkingLevel ?? ""}`;
		if (key === this.appliedSelection) {
			return;
		}
		const process = this.requireProcess();
		const state = await process.send({ type: "get_state" });
		if (state.model?.provider !== selection.provider || state.model?.id !== selection.modelId) {
			await process.send({ type: "set_model", provider: selection.provider, modelId: selection.modelId });
		}
		if (selection.thinkingLevel !== undefined) {
			await process.send({ type: "set_thinking_level", level: selection.thinkingLevel as ThinkingLevel });
		}
		this.appliedSelection = key;
	}

	/** 已运行会话中用户在输入区切换模型或思考级别时立即应用 */
	async applySelectionNow(selection: ModelSelection): Promise<void> {
		if (this.isRunning) {
			await this.applySelection(selection);
		}
	}

	/** 处理一条 participant 请求，直到 Pi 结束自动执行、用户发送引导消息或请求被取消 */
	async runPrompt(input: PromptInput, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, toolInvocationToken: vscode.ChatParticipantToolToken): Promise<RunOutcome> {
		// 上一次停止还在等待 Pi 回到空闲时，等它完成后再发送
		await this.stopping;
		const process = this.requireProcess();
		const binding: Binding = { kind: "participant", stream, token, toolInvocationToken, settled: new Deferred<RunOutcome>() };
		const cancelSubscription = token.onCancellationRequested(() => this.stopFrom(binding));
		try {
			if (this.busy) {
				// 引导消息携带的模型选择在 Pi 的下一次模型调用时生效
				await this.applySelection(input.selection);
				this.pending.push({ requestId: input.requestId, userText: input.userText, references: input.references, mode: "steer", expectedText: undefined });
				this.attach(binding);
				const result = await process.send({ type: "prompt", message: input.promptText, images: [...input.images], streamingBehavior: "steer" });
				if (result.disposition === "handled") {
					this.removePending(input.requestId);
				}
			} else {
				await this.applySelection(input.selection);
				await this.requireConnection().sendRequest(SetTurnTools, { enabledCopilotTools: input.enabledCopilotTools });
				this.pending.push({ requestId: input.requestId, userText: input.userText, references: input.references, mode: "first", expectedText: undefined });
				this.attach(binding);
				this.busy = true;
				let disposition: string;
				try {
					disposition = (await process.send({ type: "prompt", message: input.promptText, images: [...input.images] })).disposition;
				} catch (error) {
					this.busy = false;
					this.removePending(input.requestId);
					this.detach(binding);
					throw error;
				}
				if (disposition === "handled") {
					this.busy = false;
					this.removePending(input.requestId);
					this.detach(binding);
					this.scheduleIdleShutdown();
					return { aborted: false, error: undefined, interrupted: false };
				}
			}
			return await this.waitForBinding(binding, context);
		} finally {
			cancelSubscription.dispose();
		}
	}

	/**
	 * activeResponseCallback：把正在运行的 Pi 输出接回重新打开的会话内容。
	 * tailParts 是本轮已经写入会话文件的响应部分，先行写入响应流，再重放尚未写入文件的事件。
	 */
	async attachCallback(stream: vscode.ChatResponseStream, token: vscode.CancellationToken, tailParts: ReadonlyArray<vscode.ChatResponseTurn2["response"][number]>): Promise<void> {
		if (!this.busy) {
			return;
		}
		for (const part of tailParts) {
			stream.push(part as vscode.ChatResponsePart);
		}
		const binding: Binding = { kind: "callback", stream, token, toolInvocationToken: undefined, settled: new Deferred<RunOutcome>() };
		const subscription = token.onCancellationRequested(() => {
			if (this.binding !== binding) {
				return;
			}
			if (this.contentReleased) {
				// VS Code 先释放了会话内容再取消：只停止向这个响应流输出
				this.detach(binding);
				binding.settled.resolve({ aborted: false, error: undefined, interrupted: true });
			} else {
				this.stopFrom(binding);
			}
		});
		const previous = this.binding;
		if (previous) {
			this.detach(previous);
			previous.settled.resolve({ aborted: false, error: undefined, interrupted: true });
		}
		this.renderer = this.createRenderer(stream);
		this.buffered = [];
		for (const event of this.unpersisted) {
			this.renderer.handle(event);
		}
		this.binding = binding;
		try {
			await binding.settled.promise;
		} finally {
			subscription.dispose();
		}
	}

	private async waitForBinding(binding: Binding, context: vscode.ChatContext): Promise<RunOutcome> {
		while (!binding.settled.settled) {
			const tick = await Promise.race([binding.settled.promise.then(() => "settled" as const), delay(YIELD_POLL_MS).then(() => "tick" as const)]);
			if (tick === "settled") {
				break;
			}
			if (context.yieldRequested && this.pendingChatDialogs === 0 && this.binding === binding) {
				// 用户发送了引导消息：结束当前请求，Pi 继续运行，后续输出由下一个请求承接
				this.detach(binding);
				binding.settled.resolve({ aborted: false, error: undefined, interrupted: false });
			}
		}
		return binding.settled.promise;
	}

	private createRenderer(stream: vscode.ChatResponseStream): StreamRenderer {
		return new StreamRenderer(stream, {
			sessionId: this.location.sessionId,
			cwd: this.location.cwd,
			shownByVsCode: (toolCallId) => this.copilotCallShownByVsCode(toolCallId),
		});
	}

	/** 用户停止了该响应：VS Code 已关闭响应流，立即解除绑定，丢弃本次运行剩余的事件，并让 Pi 中止 */
	private stopFrom(binding: Binding): void {
		if (this.binding !== binding) {
			return;
		}
		this.detach(binding);
		this.discardUntilSettled = this.busy;
		binding.settled.resolve({ aborted: true, error: undefined, interrupted: false });
		void this.stop();
	}

	private attach(binding: Binding): void {
		const previous = this.binding;
		if (previous && previous !== binding) {
			previous.settled.resolve({ aborted: false, error: undefined, interrupted: false });
		}
		this.binding = binding;
		if (this.renderer) {
			this.renderer.retarget(binding.stream);
		} else {
			this.renderer = this.createRenderer(binding.stream);
		}
		const buffered = this.buffered;
		this.buffered = [];
		for (const event of buffered) {
			this.renderer.handle(event);
		}
	}

	private detach(binding: Binding): void {
		if (this.binding === binding) {
			this.binding = undefined;
		}
	}

	private removePending(requestId: string): void {
		const index = this.pending.findIndex((item) => item.requestId === requestId);
		if (index >= 0) {
			this.pending.splice(index, 1);
		}
	}

	private onEvent(event: JsonAgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.cancelIdleShutdown();
				break;
			case "queue_update":
				this.onQueueUpdate(event.steering);
				break;
			case "message_end":
				if (event.message.role === "user") {
					this.onUserMessage(userMessageText(event.message.content));
				}
				break;
			default:
				break;
		}
		this.trackUnpersisted(event);
		if (this.discardUntilSettled) {
			// 用户已停止本次运行，剩余事件不再显示
		} else if (this.binding && this.renderer) {
			this.renderer.handle(event);
		} else {
			this.buffered.push(event);
		}
		if (event.type === "agent_settled") {
			this.busy = false;
			this.discardUntilSettled = false;
			this.unpersisted = [];
			const binding = this.binding;
			const outcome: RunOutcome = { aborted: event.aborted, error: this.renderer?.error, interrupted: false };
			this.renderer = undefined;
			this.buffered = [];
			if (binding) {
				this.binding = undefined;
				binding.settled.resolve(outcome);
			}
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const waiter of waiters) {
				waiter();
			}
			if (this.location.sessionFile && existsSync(this.location.sessionFile)) {
				this.services.onSessionFile(this.location);
			}
			if (this.contentReleased) {
				void this.shutdown();
			} else {
				this.scheduleIdleShutdown();
			}
		}
	}

	/**
	 * Pi 空闲超过设定时间后结束进程并释放写入权限，下一次发送时重新启动。
	 * 新建会话的内容在当前窗口中不会被 VS Code 释放（`chatServiceImpl.ts` 的 `_materializeUntitledSession` 保留了引用）。
	 */
	private scheduleIdleShutdown(): void {
		this.cancelIdleShutdown();
		if (!this.isRunning || this.busy) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.isRunning && !this.busy) {
				this.services.log(`[会话 ${this.location.sessionId.slice(0, 8)}] 空闲超时，结束 Pi 进程`);
				void this.shutdown();
			}
		}, this.services.idleShutdownMs());
	}

	private cancelIdleShutdown(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	/**
	 * 记录尚未写入会话文件的输出：正在生成的助手消息和还没有结果消息的工具调用。
	 * Pi 在消息的 message_end 时写入会话文件，之后这些内容由历史记录显示。
	 */
	private trackUnpersisted(event: JsonAgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.unpersisted.push(event);
				}
				return;
			case "message_update":
				// RPC 事件中的 message_update 只属于助手消息
				this.unpersisted.push(event);
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					this.unpersisted = this.unpersisted.filter((item) => item.type !== "message_start" && item.type !== "message_update");
				} else if (event.message.role === "toolResult") {
					const toolCallId = event.message.toolCallId;
					this.unpersisted = this.unpersisted.filter((item) => !("toolCallId" in item) || item.toolCallId !== toolCallId);
				}
				return;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.unpersisted.push(event);
				return;
			default:
				return;
		}
	}

	private onQueueUpdate(steering: readonly string[]): void {
		const remaining = [...this.lastSteering];
		const added: string[] = [];
		for (const text of steering) {
			const index = remaining.indexOf(text);
			if (index >= 0) {
				remaining.splice(index, 1);
			} else {
				added.push(text);
			}
		}
		this.lastSteering = steering;
		for (const text of added) {
			const target = this.pending.find((item) => item.mode === "steer" && item.expectedText === undefined);
			if (target) {
				target.expectedText = text;
			}
		}
	}

	private onUserMessage(text: string): void {
		const index = this.pending.findIndex(
			(item) => item.mode === "first" || (item.expectedText !== undefined && (text === item.expectedText || text.startsWith(`${item.expectedText}\n\n`))),
		);
		if (index < 0) {
			return;
		}
		const [item] = this.pending.splice(index, 1);
		void this.recordRequest(item, text);
	}

	private async recordRequest(item: PendingRequest, messageText: string): Promise<void> {
		const connection = this.requireConnection();
		try {
			const result = await connection.sendRequest(RecordRequest, {
				requestId: item.requestId,
				messageText,
				userText: item.userText,
				references: item.references,
			});
			this.requestEntries.set(item.requestId, result.userEntryId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.services.log(`[会话 ${this.location.sessionId.slice(0, 8)}] 记录请求 ${item.requestId} 失败：${message}`);
			void vscode.window.showErrorMessage(`Pi 没有记录这条请求对应的会话条目，从这条请求分叉将不可用：${message}`);
		}
	}

	private onExit(process: PiRpcProcess, exit: PiProcessExit): void {
		if (this.process !== process) {
			return;
		}
		for (const unsubscribe of this.exitSubscriptions) {
			unsubscribe();
		}
		this.exitSubscriptions = [];
		this.process = undefined;
		this.cancelIdleShutdown();
		const wasBusy = this.busy;
		this.busy = false;
		const binding = this.binding;
		this.binding = undefined;
		this.renderer = undefined;
		this.buffered = [];
		this.unpersisted = [];
		this.discardUntilSettled = false;
		this.pending.length = 0;
		this.lastSteering = [];
		this.ui.cancelPending();
		if (binding) {
			if (wasBusy && !binding.token.isCancellationRequested) {
				binding.stream.warning(`Pi 进程已退出（退出码 ${exit.code ?? "无"}），本轮中断。重新打开会话后可以重新提交。`);
			}
			binding.settled.resolve({ aborted: true, error: wasBusy ? "Pi 进程已退出，本轮中断" : undefined, interrupted: true });
		}
		for (const waiter of this.idleWaiters.splice(0)) {
			waiter();
		}
		const ipc = this.ipc;
		this.ipc = undefined;
		void ipc?.close();
		void this.releaseLock();
	}

	private async releaseLock(): Promise<void> {
		const lock = this.lock;
		this.lock = undefined;
		if (lock) {
			await lock.release();
		}
		this.services.onReleased(this.location.sessionId);
	}

	/** 停止：先清空 Pi 的消息队列，再中止当前运行；abort 在 Pi 回到空闲后返回 */
	stop(): Promise<void> {
		const process = this.process;
		if (!process || process.hasExited) {
			return Promise.resolve();
		}
		this.stopping ??= (async () => {
			try {
				await process.send({ type: "clear_queue" });
				await process.send({ type: "abort" });
			} finally {
				this.stopping = undefined;
			}
		})();
		return this.stopping;
	}

	/**
	 * 把 Pi 的当前分支退回到 userEntryId 之前：VS Code 中编辑请求时移除了该请求及之后的请求。
	 * 由 Pi 扩展的内部命令调用 navigateTree，之后用 get_entries 核对当前叶子。
	 */
	async rewindBefore(userEntryId: string, expectedLeafId: string | null): Promise<void> {
		if (this.busy) {
			throw new Error("Pi 正在运行，不能退回会话分支");
		}
		const process = this.requireProcess();
		const result = await process.send({ type: "prompt", message: `/${REWIND_COMMAND} ${userEntryId}` });
		if (result.disposition !== "handled") {
			throw new Error(`Pi 没有执行退回命令（${result.disposition}）`);
		}
		const { leafId } = await process.send({ type: "get_entries" });
		if (leafId !== expectedLeafId) {
			throw new Error(`Pi 的当前分支没有退回到 ${userEntryId} 之前（当前叶子 ${leafId ?? "无"}）`);
		}
		this.services.log(`[会话 ${this.location.sessionId.slice(0, 8)}] 当前分支退回到 ${userEntryId} 之前`);
	}

	/** 在持有写入权限时修改会话文件；没有运行的 Pi 进程时，完成后释放写入权限 */
	async editFile<T>(work: () => Promise<T>): Promise<T> {
		if (this.busy) {
			throw new Error("Pi 正在运行本轮任务，请在本轮结束后再操作");
		}
		await this.ensureWritePermission();
		try {
			return await work();
		} finally {
			if (!this.isRunning && this.lock) {
				await this.releaseLock();
			}
		}
	}

	/** 会话交给终端后，下次在 VS Code 中写入前重新确认其他写入方已关闭 */
	markHandedOff(): void {
		this.externalWritersConfirmed = false;
		this.createdHere = false;
	}

	/** 输入是否以 Pi 扩展命令开头（由 get_commands 列出、来源为 extension） */
	async isExtensionCommand(prompt: string): Promise<boolean> {
		if (!prompt.startsWith("/")) {
			return false;
		}
		const name = prompt.slice(1).split(/\s/, 1)[0];
		const { commands } = await this.requireProcess().send({ type: "get_commands" });
		return commands.some((command) => command.source === "extension" && command.name === name);
	}

	whenIdle(): Promise<void> {
		if (!this.busy) {
			return Promise.resolve();
		}
		return new Promise((resolveIdle) => this.idleWaiters.push(resolveIdle));
	}

	/** VS Code 释放了该会话的内容：空闲时结束 Pi 进程并释放写入权限 */
	markContentReleased(released: boolean): void {
		this.contentReleased = released;
		if (released && !this.busy && this.isRunning) {
			void this.shutdown();
		}
	}

	/** 通过运行中的 Pi 进程写入会话名称 */
	async setName(name: string): Promise<void> {
		await this.requireProcess().send({ type: "set_session_name", name });
	}

	async compact(stream: vscode.ChatResponseStream): Promise<void> {
		if (this.busy) {
			throw new Error("Pi 正在运行。压缩上下文会先中止当前任务，请在本轮结束后再执行 /compact。");
		}
		stream.progress("Pi 正在压缩上下文");
		const result = await this.requireProcess().send({ type: "compact" });
		stream.markdown(`已压缩上下文：${result.tokensBefore} 个 token 之前的内容改为摘要。`);
		this.scheduleIdleShutdown();
	}

	/** 关闭标准输入请 Pi 有序退出；deadline 毫秒内没有退出时结束整个进程树 */
	async shutdown(deadlineMs?: number): Promise<void> {
		const process = this.process;
		if (!process || process.hasExited) {
			if (this.lock) {
				await this.releaseLock();
			}
			return;
		}
		const exited = process.shutdown();
		if (deadlineMs === undefined) {
			await exited;
			return;
		}
		const result = await Promise.race([exited.then(() => "exited" as const), delay(deadlineMs).then(() => "timeout" as const)]);
		if (result === "timeout") {
			process.killTree();
			await exited;
		}
	}

	/** 扩展停用：运行中的会话先清空队列并中止，再关闭标准输入，超时后结束进程树 */
	async deactivate(): Promise<void> {
		if (this.busy && this.isRunning) {
			const idle = this.whenIdle();
			await this.stop();
			await Promise.race([idle, delay(3000)]);
		}
		await this.shutdown(3000);
	}

	dispose(): void {
		this.ui.dispose();
	}
}
