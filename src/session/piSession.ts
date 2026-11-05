import { randomUUID } from "node:crypto";
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
	FileCommit,
	FileReadBase,
	FileRestoreApply,
	FileRestorePrepare,
	FileWaitForIdle,
	RecordRequest,
	type ReferenceRecord,
	SetTurnTools,
} from "../../shared/protocol";
import { ExtensionUiBridge } from "../chat/extensionUi";
import { userMessageText } from "../chat/historyRenderer";
import { StreamRenderer } from "../chat/streamRenderer";
import { composePrompt } from "../chat/requestContext";
import { FileGate } from "../edits/fileGate";
import type { SnapshotStore } from "../edits/snapshotStore";
import { IpcServer } from "../ipc/ipcServer";
import type { ThinkingLevel } from "../pi/catalog";
import type { PiRuntime } from "../pi/piRuntime";
import { type PiProcessExit } from "../pi/rpcProcess";
import { BackendSessionChannel, type SharedBackendClient } from "../pi/sharedBackend";
import { OperationStore, type OwnershipRecord, type RestoreOperation } from "../backend/operationStore";
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
	readonly backend: SharedBackendClient;
	readonly piExtensionPath: string;
	readonly snapshots: SnapshotStore;
	readonly log: (line: string) => void;
	/** 会话标题变化（Pi 扩展的 setTitle） */
	readonly onTitle: (sessionId: string, title: string) => void;
	/** 会话进程退出、写入权限释放后通知 */
	readonly onReleased: (sessionId: string) => void;
	/** Pi 写入会话文件后通知（用于刷新列表） */
	readonly onSessionFile: (location: SessionLocation) => void;
	readonly hasSubscriptions: () => boolean;
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
	readonly basePrompt?: string;
	readonly contextBlock?: string;
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

/** 一个 Chat 的共享后台通道、写入权限和响应流。 */
export class PiSession implements vscode.Disposable {
	private process: BackendSessionChannel | undefined;
	private ipc: IpcServer | undefined;
	private ownership: OwnershipRecord | undefined;
	private externalWritersConfirmed = false;
	private busy = false;
	private binding: Binding | undefined;
	private renderer: StreamRenderer | undefined;
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
	private ready = false;
	private recoveryDraft: RestoreOperation | undefined;
	private exitSubscriptions: Array<() => void> = [];
	/** 本窗口中由扩展创建（还没有文件的新会话或分叉出的会话），首次写入时不需要确认其他写入方 */
	createdHere: boolean;

	constructor(
		readonly location: SessionLocation,
		private readonly services: SessionServices,
		createdHere: boolean,
	) {
		this.createdHere = createdHere;
		this.fileGate = new FileGate(services.snapshots, () => (this.binding?.kind === "participant" ? this.binding.stream : undefined), async (identity) => {
			if (identity.sessionId !== this.location.sessionId || identity.ownershipId !== this.ownership?.ownershipId) throw new Error("文件提交的会话身份已经失效");
			await services.backend.validateIdentity(identity);
		}, (edit) => services.backend.recordFileIntent(edit.identity, edit));
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
			logDiagnostic: (message) => services.log(`[会话 ${location.sessionId.slice(0, 8)}] ${message}`),
		});
	}

	get isBusy(): boolean {
		return this.busy;
	}

	get isRunning(): boolean {
		return this.ready && this.process !== undefined && !this.process.hasExited;
	}

	get holdsWritePermission(): boolean {
		return this.services.backend.hasOwnership(this.location.sessionId);
	}

	get processId(): number | undefined {
		return this.process?.pid;
	}

	copilotCallShownByVsCode(toolCallId: string): boolean {
		return this.shownCopilotCalls.has(toolCallId);
	}

	/** 取得写入权限；其他窗口持有时报错，尚未持有的已有会话需要用户确认已关闭其他写入方 */
	async ensureWritePermission(): Promise<void> {
		if (this.ownership && this.ownership.generationId === this.services.backend.generationId && this.holdsWritePermission) {
			return;
		}
		const hasFile = this.location.sessionFile !== undefined && existsSync(this.location.sessionFile);
		if (hasFile && !this.createdHere && !this.externalWritersConfirmed) {
			const choice = await vscode.window.showWarningMessage(
				"继续这个 Pi 会话之前，请先关闭终端或其他程序中打开的同一个会话。两个 Pi 进程同时写入同一个会话文件会损坏历史。",
				{ modal: true },
				"已关闭，继续",
			);
			if (choice !== "已关闭，继续") {
				throw new CancelledByUser("用户取消了继续该会话");
			}
			this.externalWritersConfirmed = true;
		}
		const acquired = await this.services.backend.acquire(this.location);
		this.ownership = acquired.ownership;
		this.location.sessionFile = acquired.sessionFile;
	}

	/** 启动 Pi 进程并完成 IPC 握手；已运行时直接返回 */
	ensureStarted(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.isRunning) {
			return Promise.resolve();
		}
		if (this.process && !this.process.hasExited) return Promise.reject(new Error("Pi 会话资源尚未就绪，请通过会话菜单重新加载"));
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async start(): Promise<void> {
		if (!this.ownership || !this.location.sessionFile) {
			throw new Error("加载 Pi 会话前需要取得写入权限");
		}
		const ipc = await IpcServer.listen(
			async (hello) => {
				const identity = hello.identity;
				if (identity.sessionId !== this.location.sessionId || identity.generationId !== this.ownership?.generationId || identity.ownershipId !== this.ownership?.ownershipId) throw new Error("Pi 编辑器连接所属会话已经失效");
				if (hello.role === "child") {
					if (identity.rootRequestId === undefined || identity.runId === undefined || identity.operationEpoch === undefined) throw new Error("Pi 子任务缺少完整请求身份");
					await this.services.backend.validateIdentity({ ...identity, rootRequestId: identity.rootRequestId, runId: identity.runId, operationEpoch: identity.operationEpoch });
				}
				return { copilotTools: availableCopilotTools() };
			},
			(connection) => this.configureConnection(connection),
		);
		this.ipc = ipc;
		this.appliedSelection = undefined;
		const startupSubscription = `startup:${randomUUID()}`;
		const viewSubscription = `view:${this.location.sessionId}`;
		let openingChannel: BackendSessionChannel | undefined;
		try {
			const process = await this.services.backend.open({
				sessionId: this.location.sessionId, cwd: this.location.cwd, sessionDir: this.location.sessionDir,
				sessionFile: this.location.sessionFile, ownershipId: this.ownership.ownershipId,
				bridge: ipc.endpoint, projectTrusted: vscode.workspace.isTrusted,
				initialSubscriptions: [startupSubscription, ...(this.services.hasSubscriptions() ? [viewSubscription] : [])],
			}, (channel) => {
				openingChannel = channel;
				this.process = channel;
				this.exitSubscriptions = [
					channel.onEvent((event) => this.onEvent(event)),
					channel.onExtensionUiRequest((request) => this.ui.handle(request)),
					channel.onExit((exit) => this.onExit(channel, exit)),
					channel.onSnapshot((snapshot) => {
						this.busy = snapshot.busy;
						this.services.onSessionFile(this.location);
					}),
				];
			});
			await Promise.race([ipc.whenConnected(), delay(HANDSHAKE_TIMEOUT_MS).then(() => { throw new Error("Pi 编辑器连接超过等待期限"); })]);
			const state = await process.send({ type: "get_state" });
			if (state.sessionId !== this.location.sessionId) {
				throw new Error(`Pi 打开的会话 ${state.sessionId} 与预期的 ${this.location.sessionId} 不一致`);
			}
			if (state.sessionFile === undefined || resolve(state.sessionFile).toLowerCase() !== resolve(this.location.sessionFile).toLowerCase()) {
				throw new Error(`Pi 打开的会话文件 ${state.sessionFile ?? "无"} 与预期的 ${this.location.sessionFile} 不一致`);
			}
			this.location.sessionFile = state.sessionFile;
			this.contentReleased = !this.services.hasSubscriptions();
			if (!this.contentReleased) await process.subscribe(viewSubscription);
			else await process.unsubscribe(viewSubscription);
			await process.unsubscribe(startupSubscription);
			this.ready = true;
		} catch (error) {
			ipc.failPendingConnection(error instanceof Error ? error : new Error(String(error)));
			if (openingChannel && !openingChannel.hasExited) {
				try { await openingChannel.unsubscribe(startupSubscription); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], "Pi 会话启动失败，启动保护尚未解除"); }
			}
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
		connection.onRequest(FileRestorePrepare, (params) => this.fileGate.prepareRestore(params));
		connection.onRequest(FileRestoreApply, (params) => this.fileGate.applyRestore(params));
		connection.onRequest(FileWaitForIdle, () => this.fileGate.waitForIdle());
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

	private requireProcess(): BackendSessionChannel {
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
				const result = await process.send({ type: "prompt", message: input.promptText, images: [...input.images], streamingBehavior: "steer" }, input.requestId, { userText: input.userText, contextBlock: input.contextBlock, references: input.references });
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
					disposition = (await process.send({ type: "prompt", message: input.promptText, images: [...input.images] }, input.requestId, { userText: input.userText, contextBlock: input.contextBlock, references: input.references })).disposition;
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
					this.services.onSessionFile(this.location);
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
			await this.services.backend.markSubmitted(this.location.sessionId, item.requestId, result.userEntryId);
			this.recoveryDraft = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.services.log(`[会话 ${this.location.sessionId.slice(0, 8)}] 记录请求 ${item.requestId} 失败：${message}`);
			void vscode.window.showErrorMessage(`Pi 没有记录这条请求对应的会话条目，从这条请求分叉将不可用：${message}`);
		}
	}

	private onExit(process: BackendSessionChannel, exit: PiProcessExit): void {
		if (this.process !== process) {
			return;
		}
		for (const unsubscribe of this.exitSubscriptions) {
			unsubscribe();
		}
		this.exitSubscriptions = [];
		this.process = undefined;
		this.ready = false;
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
		this.ui.cancelPending(false);
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
		this.ownership = undefined;
		this.services.onReleased(this.location.sessionId);
	}

	private async releaseLock(): Promise<void> {
		await this.services.backend.release(this.location.sessionId, false);
		this.ownership = undefined;
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

	/** 编辑历史时持久保存输入并等待原执行与文件恢复完成。 */
	async rewindBefore(userEntryId: string, expectedLeafId: string | null, input: PromptInput, rootRequestIds: readonly string[]): Promise<void> {
		this.fileGate.invalidate(rootRequestIds);
		const operation = await this.services.backend.restore(this.location.sessionId, {
			originalRequestId: rootRequestIds[0] ?? userEntryId, requestId: input.requestId,
			targetId: userEntryId, targetParent: expectedLeafId, rootRequestIds,
			input: { message: input.promptText, userText: input.userText, contextBlock: input.contextBlock, references: input.references, images: input.images },
		});
		if (operation.stage !== "restored" && operation.stage !== "completed") throw new Error(operation.error ?? "Pi 文件恢复尚未完成");
		this.busy = false;
		this.renderer = undefined; this.buffered = []; this.unpersisted = [];
		this.pending.length = 0; this.lastSteering = [];
		this.services.onSessionFile(this.location);
	}

	async recoverPending(): Promise<RestoreOperation | undefined> {
		const file = this.location.sessionFile;
		if (!file || !existsSync(OperationStore.pathFor(file))) return undefined;
		const pending = await this.services.backend.pendingRecovery(this.location.sessionId, file);
		if (!pending) return undefined;
		await this.ensureWritePermission();
		await this.ensureStarted();
		return this.services.backend.resumeRecovery(this.location.sessionId);
	}

	async prepareRecoveryInput(operationId: string): Promise<RestoreOperation> {
		const operation = await this.recoverPending();
		if (!operation || operation.operationId !== operationId || operation.stage !== "restored" || operation.blocked) throw new Error("待发送输入所属恢复操作当前不可用，请重新打开会话");
		this.recoveryDraft = operation;
		return operation;
	}

	async applyRecoveryInput(input: PromptInput): Promise<PromptInput> {
		const draft = this.recoveryDraft;
		if (!draft) return input;
		const pending = await this.services.backend.pendingRecovery(this.location.sessionId, this.location.sessionFile!);
		if (!pending) { this.recoveryDraft = undefined; return input; }
		if (pending.operationId !== draft.operationId || pending.stage !== "restored" || pending.blocked) throw new Error("保留输入的恢复状态已改变，请重新打开会话");
		const saved = pending.input;
		if (saved.references.some((reference) => reference.kind !== "image") && saved.contextBlock === undefined) throw new Error("保留的附件没有持久内容，请重新选择附件后发送");
		const contextBlock = [saved.contextBlock, input.contextBlock].filter((block) => block && block.length > 0).join("\n\n");
		const references = new Map(saved.references.map((reference) => [reference.id, reference]));
		for (const reference of input.references) references.set(reference.id, reference);
		const promptText = input.userText === (saved.userText ?? saved.message)
			? composePrompt(saved.message, input.contextBlock ?? "")
			: composePrompt(input.basePrompt ?? input.userText, contextBlock);
		return { ...input, promptText, contextBlock, references: [...references.values()], images: [...saved.images ?? [], ...input.images] };
	}

	async requireRecoveryCompleted(): Promise<void> {
		const pending = await this.recoverPending();
		if (pending && pending.stage !== "completed") throw new Error(pending.error ?? "Pi 历史和文件已经恢复，请确认保留的输入并发送后继续此操作");
	}

	/** 在持有写入权限时修改会话文件；没有运行的 Pi 进程时，完成后释放写入权限 */
	async editFile<T>(work: () => Promise<T>): Promise<T> {
		if (this.busy) {
			throw new Error("Pi 正在运行本轮任务，请在本轮结束后再操作");
		}
		await this.ensureWritePermission();
		await this.requireRecoveryCompleted();
		try {
			return await work();
		} finally {
			if (!this.isRunning && this.holdsWritePermission) {
				await this.releaseLock();
			}
		}
	}

	async deleteFile(work: () => Promise<void>): Promise<void> {
		await this.editFile(() => this.services.backend.withReleasedSession(this.location.sessionId, work));
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

	/** VS Code 的内容引用决定后台会话能否被释放。 */
	markContentReleased(released: boolean): void {
		if (this.contentReleased === released) return;
		this.contentReleased = released;
		if (this.process && !this.process.hasExited) {
			const update = released ? this.process.unsubscribe(`view:${this.location.sessionId}`) : this.process.subscribe(`view:${this.location.sessionId}`);
			void update.catch((error: unknown) => this.services.log(`Pi 会话引用更新失败：${error instanceof Error ? error.message : String(error)}`));
		}
	}

	async setArchived(archived: boolean): Promise<void> {
		await this.requireRecoveryCompleted();
		if (this.isRunning) await this.requireProcess().protect({ recovery: false, archived });
	}

	async reload(): Promise<void> {
		await this.ensureWritePermission();
		await this.requireRecoveryCompleted();
		await this.starting;
		if (!this.process || this.process.hasExited) await this.ensureStarted();
		else { await this.requireProcess().reload(); this.ready = true; }
		this.appliedSelection = undefined;
		this.services.onSessionFile(this.location);
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
		this.services.onSessionFile(this.location);
	}

	/** 释放当前会话，窗口后台继续服务其他会话。 */
	async shutdown(_deadlineMs?: number): Promise<void> {
		const process = this.process;
		if (!process || process.hasExited) {
			if (this.holdsWritePermission) {
				await this.releaseLock();
			}
			return;
		}
		await this.requireRecoveryCompleted();
		await process.unsubscribe(`view:${this.location.sessionId}`);
		await process.shutdown(false);
	}

	/** 单会话关闭由后台确认所属任务与工具均已结束。 */
	async deactivate(): Promise<void> {
		if (this.isRunning) await this.requireProcess().shutdown(true);
	}

	dispose(): void {
		this.ui.dispose();
	}
}
