import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { JsonAgentSessionEvent, RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { createMessageConnection, IPCMessageReader, IPCMessageWriter, type MessageConnection, type RequestType } from "vscode-jsonrpc/node";
import {
	BackendCatalog, BackendCatalogChanged, BackendCommand, BackendEvent, BackendInitialize, BackendOpen,
	BackendPrepareSession, BackendRelease, BackendReload, BackendRespondUi, BackendSessionChanged,
	BackendSessionReleased, BackendSetProtection, BackendShutdown, BackendSnapshot, BackendSubscribe,
	BackendUi, BackendUnsubscribe, BackendValidateIdentity,
	BackendRecordFileIntent, BackendRestore, BackendResumeRecovery, BackendPendingRecovery, BackendMarkSubmitted,
	type BackendCatalogSnapshot, type BackendEventParams, type BackendOpenParams, type BackendProcessSnapshot,
	type BackendSessionSnapshot, type BackendUiParams,
} from "../backend/protocol";
import type { OwnershipRecord, RestoreInput, RestoreOperation } from "../backend/operationStore";
import { GuardianClient } from "../guardian/client";
import type { GuardianSnapshot } from "../guardian/protocol";
import type { CommitIdentity, EditEntryData, ReferenceRecord } from "../../shared/protocol";
import type { PiRuntime } from "./piRuntime";
import type { PiProcessExit, RpcCommandInput, RpcData } from "./rpcProcess";

export interface SharedBackendOptions {
	readonly runtime: PiRuntime;
	readonly extensionPath: string;
	readonly residencyLimit: () => number;
	readonly log: (message: string) => void;
}

interface RunningBackend {
	readonly generationId: string;
	readonly child: ChildProcess;
	readonly connection: MessageConnection;
	readonly guardian: GuardianClient;
	valid: boolean;
}

function withDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}超过等待期限`)), Math.max(1, deadline - Date.now()));
		operation.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
	});
}

/** 宿主窗口共用一个后台；各 Chat 使用独立通道接收事件。 */
export class SharedBackendClient {
	private running: RunningBackend | undefined;
	private starting: Promise<RunningBackend> | undefined;
	private startupAbort: AbortController | undefined;
	private cleanup: Promise<void> | undefined;
	private closing = false;
	private closeDeadline: number | undefined;
	private readonly channels = new Map<string, BackendSessionChannel>();
	private readonly ownerships = new Map<string, OwnershipRecord>();
	private readonly acquiring = new Map<string, Promise<{ ownership: OwnershipRecord; sessionFile: string }>>();
	private readonly releasing = new Map<string, Promise<void>>();
	private readonly retainedOwnerships = new Map<string, string>();
	private readonly events = new EventEmitter();
	private processSnapshot: BackendProcessSnapshot | undefined;
	private guardianSnapshot: GuardianSnapshot | undefined;

	constructor(private readonly options: SharedBackendOptions) {}

	get snapshot(): BackendProcessSnapshot | undefined { return this.processSnapshot; }
	get guardianStatus(): GuardianSnapshot | undefined { return this.guardianSnapshot; }
	get generationId(): string | undefined { return this.running?.valid ? this.running.generationId : undefined; }
	get pid(): number | undefined { return this.running?.valid ? this.running.child.pid : undefined; }
	onChanged(listener: () => void): () => void { this.events.on("changed", listener); return () => this.events.off("changed", listener); }
	onCatalogChanged(listener: (cwd: string, sessionId?: string) => void): () => void { this.events.on("catalog", listener); return () => this.events.off("catalog", listener); }

	private async ensure(): Promise<RunningBackend> {
		if (this.closing) throw new Error("Pi 后台正在关闭");
		await this.cleanup;
		this.cleanup = undefined;
		if (this.starting) return this.starting;
		if (this.running?.valid) return this.running;
		this.starting ??= this.start().finally(() => { this.starting = undefined; this.startupAbort = undefined; });
		return this.starting;
	}

	private async start(): Promise<RunningBackend> {
		if (this.closing) throw new Error("Pi 后台正在关闭");
		this.startupAbort = new AbortController();
		const guardian = await GuardianClient.start({
			nodePath: this.options.runtime.nodeExecutable,
			guardianEntry: join(this.options.extensionPath, "dist", "guardian", "index.cjs"),
			log: this.options.log,
			signal: this.startupAbort.signal,
		});
		if (this.closing) {
			await guardian.cleanup(this.closeDeadline ?? Date.now() + 4_000);
			throw new Error("Pi 后台启动已取消");
		}
		const generationId = randomUUID();
		const token = randomUUID();
		const child = fork(join(this.options.extensionPath, "dist", "backend", "index.cjs"), [], {
			execPath: this.options.runtime.nodeExecutable, execArgv: [],
			stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
			env: { ...process.env, PI_HARNESS_STARTUP_NONCE: token },
		});
		for (const source of [child.stdout, child.stderr]) {
			source?.on("data", (data: Buffer) => this.options.log(`[Pi 后台] ${data.toString().trimEnd()}`));
		}
		const connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
		const running: RunningBackend = { child, connection, guardian, generationId, valid: true };
		this.running = running;
		guardian.onSnapshot((snapshot) => {
			if (this.running !== running) return;
			this.guardianSnapshot = snapshot;
			this.events.emit("changed");
		});
		guardian.onInvalidated((error) => this.invalidate(running, error));
		child.once("exit", (code, signal) => this.invalidate(running, new Error(`Pi 后台退出：${code ?? signal}`), { code, signal, stderrTail: "" }));
		child.once("disconnect", () => this.invalidate(running, new Error("Pi 后台连接已经关闭")));
		child.once("error", (error) => this.invalidate(running, error));
		connection.onNotification(BackendEvent, (message) => { if (this.isCurrent(running, message.generationId)) this.channels.get(message.sessionId)?.acceptEvent(message); });
		connection.onNotification(BackendUi, (message) => { if (this.isCurrent(running, message.generationId)) this.channels.get(message.sessionId)?.acceptUi(message); });
		connection.onNotification(BackendSnapshot, (snapshot) => {
			if (!this.isCurrent(running, snapshot.generationId)) return;
			this.processSnapshot = snapshot;
			for (const session of snapshot.sessions) this.channels.get(session.sessionId)?.acceptSnapshot(session);
			this.events.emit("changed");
		});
		connection.onNotification(BackendSessionChanged, (snapshot) => {
			if (!this.isCurrent(running, snapshot.generationId)) return;
			this.channels.get(snapshot.sessionId)?.acceptSnapshot(snapshot);
			if (this.processSnapshot) {
				const sessions = this.processSnapshot.sessions.filter((session) => session.sessionId !== snapshot.sessionId);
				if (snapshot.state !== "released") sessions.push(snapshot);
				this.processSnapshot = { ...this.processSnapshot, sessions };
			}
			this.events.emit("changed");
		});
		connection.onNotification(BackendCatalogChanged, (event) => { if (this.isCurrent(running, event.generationId)) this.events.emit("catalog", event.cwd, event.sessionId); });
		connection.onNotification(BackendSessionReleased, (event) => {
			if (!this.isCurrent(running, event.generationId)) return;
			const release = this.finishRelease(running, event.sessionId, event.ownershipId);
			void release.catch((error: unknown) => this.options.log(`Pi 会话权限保留：${error instanceof Error ? error.message : String(error)}`));
		});
		connection.listen();
		try {
			await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
			const authorization = await guardian.launchGeneration(child, { generationId, token });
			if (this.closing || !running.valid) throw new Error("Pi 后台启动已取消");
			await withDeadline(connection.sendRequest(BackendInitialize, {
				generationId, authorization, packageDir: this.options.runtime.packageDir,
				compatRoot: join(this.options.extensionPath, "dist", "compat"),
				piExtensionPath: join(this.options.extensionPath, "dist", "pi-extension", "index.js"),
				residencyLimit: this.options.residencyLimit(),
			}), Date.now() + 60_000, "初始化 Pi 后台");
			if (!running.valid || this.closing) throw new Error("Pi 后台初始化期间已经关闭");
			return running;
		} catch (error) {
			const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
			if (child.connected) child.disconnect();
			this.invalidate(running, error instanceof Error ? error : new Error(String(error)));
			const results = await Promise.allSettled([this.cleanup, withDeadline(exited, this.closeDeadline ?? Date.now() + 4_000, "等待 Pi 后台启动进程退出")]);
			for (const result of results) if (result.status === "rejected") this.options.log(`Pi 启动清理错误：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
			throw error;
		}
	}

	private isCurrent(running: RunningBackend, generationId: string): boolean {
		return this.running === running && running.valid && running.generationId === generationId;
	}

	private invalidate(running: RunningBackend, error: Error, exit: PiProcessExit = { code: null, signal: null, stderrTail: "" }): void {
		if (!running.valid) return;
		running.valid = false;
		this.options.log(error.message);
		for (const channel of this.channels.values()) channel.exit(exit, error);
		this.channels.clear();
		this.processSnapshot = undefined;
		this.events.emit("changed");
		this.cleanup ??= running.guardian.cleanup(this.closeDeadline ?? Date.now() + 4_000).then(() => {
			if (this.running === running) {
				this.running = undefined;
				this.ownerships.clear();
				this.guardianSnapshot = undefined;
			}
			running.connection.dispose();
			this.events.emit("changed");
		});
		void this.cleanup.catch((failure: unknown) => this.options.log(`Pi 后台清理尚未完成：${failure instanceof Error ? failure.message : String(failure)}`));
	}

	acquire(location: { sessionId: string; cwd: string; sessionDir: string; sessionFile?: string }): Promise<{ ownership: OwnershipRecord; sessionFile: string }> {
		let pending = this.acquiring.get(location.sessionId);
		if (!pending) {
			pending = this.acquireOnce(location);
			this.acquiring.set(location.sessionId, pending);
			void pending.then(() => this.acquiring.delete(location.sessionId), () => this.acquiring.delete(location.sessionId));
		}
		return pending;
	}

	private async acquireOnce(location: { sessionId: string; cwd: string; sessionDir: string; sessionFile?: string }): Promise<{ ownership: OwnershipRecord; sessionFile: string }> {
		const running = await this.ensure();
		const prepared = await running.connection.sendRequest(BackendPrepareSession, { ...location, generationId: running.generationId });
		const current = this.ownerships.get(location.sessionId);
		const ownership = current ?? await running.guardian.acquireSession({ sessionId: location.sessionId, cwd: location.cwd, sessionFile: prepared.sessionFile });
		if (!running.valid) throw new Error("Pi 后台已结束，会话权限需要重新检查");
		this.ownerships.set(location.sessionId, ownership);
		return { ownership, sessionFile: prepared.sessionFile };
	}

	async open(params: Omit<BackendOpenParams, "generationId">, configure: (channel: BackendSessionChannel) => void): Promise<BackendSessionChannel> {
		const running = await this.ensure();
		const existing = this.channels.get(params.sessionId);
		if (existing && !existing.hasExited) return existing;
		const channel = new BackendSessionChannel(this, params.sessionId, running.generationId, params.ownershipId);
		this.channels.set(params.sessionId, channel);
		configure(channel);
		channel.acceptSnapshot(await running.connection.sendRequest(BackendOpen, { ...params, generationId: running.generationId }));
		return channel;
	}

	async request<P, R>(type: RequestType<P, R, void>, params: P, generationId?: string): Promise<R> {
		const running = await this.ensure();
		if (generationId !== undefined && running.generationId !== generationId) throw new Error("Pi 后台代次已经改变");
		return running.connection.sendRequest<R>(type.method, params);
	}

	async catalog(cwd: string, projectTrusted: boolean, refresh = false, sessionId?: string): Promise<BackendCatalogSnapshot> {
		const running = await this.ensure();
		return running.connection.sendRequest(BackendCatalog, { generationId: running.generationId, cwd, projectTrusted, refresh, sessionId });
	}

	async validateIdentity(identity: CommitIdentity): Promise<void> {
		await this.request(BackendValidateIdentity, identity, identity.generationId);
	}

	async recordFileIntent(identity: CommitIdentity, edit: EditEntryData): Promise<void> {
		await this.request(BackendRecordFileIntent, { identity, edit }, identity.generationId);
	}

	async pendingRecovery(sessionId: string, sessionFile: string): Promise<RestoreOperation | undefined> {
		const running = await this.ensure();
		return (await running.connection.sendRequest(BackendPendingRecovery, { generationId: running.generationId, sessionId, sessionFile })) ?? undefined;
	}

	async restore(sessionId: string, input: Omit<RestoreInput, "sessionId" | "operationEpoch" | "sourceLeaf">): Promise<RestoreOperation> {
		const running = await this.ensure();
		return running.connection.sendRequest(BackendRestore, { generationId: running.generationId, sessionId, input });
	}

	async resumeRecovery(sessionId: string): Promise<RestoreOperation | undefined> {
		const running = await this.ensure();
		return (await running.connection.sendRequest(BackendResumeRecovery, { generationId: running.generationId, sessionId })) ?? undefined;
	}

	async markSubmitted(sessionId: string, requestId: string, userEntryId: string): Promise<void> {
		const running = await this.ensure();
		await running.connection.sendRequest(BackendMarkSubmitted, { generationId: running.generationId, sessionId, requestId, userEntryId });
	}

	async release(sessionId: string, stop: boolean, reason: "release" | "archive" | "delete" | "terminal" = "release"): Promise<void> {
		const ownership = this.ownerships.get(sessionId);
		if (!ownership) { await this.cleanup; return; }
		const running = await this.ensure();
		if (this.channels.has(sessionId)) await running.connection.sendRequest(BackendRelease, { generationId: running.generationId, sessionId, stop, reason });
		await this.finishRelease(running, sessionId, ownership.ownershipId);
	}

	private finishRelease(running: RunningBackend, sessionId: string, ownershipId: string): Promise<void> {
		if (this.retainedOwnerships.get(sessionId) === ownershipId) {
			this.closeChannel(sessionId, ownershipId);
			return Promise.resolve();
		}
		let release = this.releasing.get(ownershipId);
		if (!release) {
			release = running.guardian.releaseSession(ownershipId).then(() => {
				if (this.ownerships.get(sessionId)?.ownershipId === ownershipId) this.ownerships.delete(sessionId);
				this.closeChannel(sessionId, ownershipId);
				this.events.emit("changed");
			});
			this.releasing.set(ownershipId, release);
		}
		return release;
	}

	private closeChannel(sessionId: string, ownershipId: string): void {
		const channel = this.channels.get(sessionId);
		if (channel?.ownershipId === ownershipId) {
			channel.exit({ code: 0, signal: null, stderrTail: "" });
			this.channels.delete(sessionId);
		}
	}

	/** 停止所属运行时后，文件操作仍持有同一写入归属。 */
	async withReleasedSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
		const ownership = this.ownerships.get(sessionId);
		if (!ownership) throw new Error("文件操作缺少会话写入权限");
		const running = await this.ensure();
		if (this.retainedOwnerships.has(sessionId)) throw new Error("该会话已有文件操作正在执行");
		this.retainedOwnerships.set(sessionId, ownership.ownershipId);
		let runtimeReleased = false;
		try {
			await this.release(sessionId, false, "delete");
			runtimeReleased = true;
			if (!running.valid || this.ownerships.get(sessionId)?.ownershipId !== ownership.ownershipId) throw new Error("会话写入权限在文件操作前已失效");
			return await work();
		} finally {
			this.retainedOwnerships.delete(sessionId);
			if (runtimeReleased && running.valid && this.ownerships.get(sessionId)?.ownershipId === ownership.ownershipId) await this.finishRelease(running, sessionId, ownership.ownershipId);
		}
	}

	hasOwnership(sessionId: string): boolean { return this.ownerships.has(sessionId); }

	async notifyUi(sessionId: string, generationId: string, runtimeGeneration: number, response: RpcExtensionUIResponse): Promise<void> {
		const running = await this.ensure();
		if (running.generationId !== generationId) throw new Error("Pi 交互所属后台已经结束");
		await running.connection.sendNotification(BackendRespondUi, { sessionId, generationId, runtimeGeneration, response });
	}

	async shutdown(deadline = Date.now() + 4_000): Promise<void> {
		this.closing = true;
		this.closeDeadline = deadline;
		this.startupAbort?.abort();
		const running = this.running;
		if (!running) {
			if (this.starting) await withDeadline(this.starting.then(() => undefined, () => undefined), deadline, "关闭正在启动的 Pi 后台");
			if (this.cleanup) await withDeadline(this.cleanup, deadline, "完成 Pi 进程清理");
			return;
		}
		const gracefulDeadline = Math.max(Date.now(), deadline - 1_000);
		try {
			if (running.valid) await withDeadline(running.connection.sendRequest(BackendShutdown, { generationId: running.generationId, deadline: gracefulDeadline }), gracefulDeadline, "关闭 Pi 会话");
		} catch (error) {
			this.options.log(`Pi 正常关闭未完成：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			running.valid = false;
			this.cleanup ??= running.guardian.cleanup(deadline);
			await withDeadline(this.cleanup, deadline, "完成 Pi 进程清理");
			running.connection.dispose();
			for (const channel of this.channels.values()) channel.exit({ code: 0, signal: null, stderrTail: "" });
			this.channels.clear(); this.ownerships.clear(); this.running = undefined;
			this.processSnapshot = undefined; this.guardianSnapshot = undefined;
			this.events.emit("changed");
		}
	}
}

export class BackendSessionChannel {
	private readonly events = new EventEmitter();
	private exitInfo: PiProcessExit | undefined;
	private current: BackendSessionSnapshot | undefined;
	private sequence = -1;
	private resolveExit!: (exit: PiProcessExit) => void;
	readonly whenExited = new Promise<PiProcessExit>((resolve) => { this.resolveExit = resolve; });
	constructor(private readonly backend: SharedBackendClient, readonly sessionId: string, readonly generationId: string, readonly ownershipId: string) {}
	get pid(): number | undefined { return this.hasExited ? undefined : this.backend.pid; }
	get hasExited(): boolean { return this.exitInfo !== undefined; }
	get snapshot(): BackendSessionSnapshot | undefined { return this.current; }
	onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void { this.events.on("event", listener); return () => this.events.off("event", listener); }
	onExtensionUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void { this.events.on("ui", listener); return () => this.events.off("ui", listener); }
	onExit(listener: (exit: PiProcessExit) => void): () => void { this.events.on("exit", listener); return () => this.events.off("exit", listener); }
	onSnapshot(listener: (snapshot: BackendSessionSnapshot) => void): () => void { this.events.on("snapshot", listener); return () => this.events.off("snapshot", listener); }
	acceptSnapshot(snapshot: BackendSessionSnapshot): void {
		if (this.hasExited || snapshot.generationId !== this.generationId || snapshot.runtimeGeneration < (this.current?.runtimeGeneration ?? 0)) return;
		this.current = snapshot;
		this.events.emit("snapshot", snapshot);
	}
	acceptEvent(message: BackendEventParams): void {
		if (!this.accept(message)) return;
		this.events.emit("event", message.event);
	}
	acceptUi(message: BackendUiParams): void { if (this.accept(message)) this.events.emit("ui", message.request); }
	private accept(message: BackendEventParams | BackendUiParams): boolean {
		if (this.hasExited || message.generationId !== this.generationId || message.runtimeGeneration < (this.current?.runtimeGeneration ?? 0) || message.sequence <= this.sequence) return false;
		this.sequence = message.sequence;
		return true;
	}
	async send<C extends RpcCommandInput>(command: C, requestId: string = randomUUID(), input?: { readonly userText: string; readonly contextBlock?: string; readonly references: readonly ReferenceRecord[] }): Promise<RpcData<C["type"]>> {
		if (this.hasExited) throw new Error("Pi 会话已释放");
		return await this.backend.request(BackendCommand, { generationId: this.generationId, sessionId: this.sessionId, requestId, command, input }, this.generationId) as RpcData<C["type"]>;
	}
	respondUi(response: RpcExtensionUIResponse): Promise<void> { return this.backend.notifyUi(this.sessionId, this.generationId, this.current?.runtimeGeneration ?? 1, response); }
	async subscribe(subscriptionId: string): Promise<void> { this.acceptSnapshot(await this.backend.request(BackendSubscribe, { sessionId: this.sessionId, generationId: this.generationId, subscriptionId }, this.generationId)); }
	unsubscribe(subscriptionId: string): Promise<void> { return this.backend.request(BackendUnsubscribe, { sessionId: this.sessionId, generationId: this.generationId, subscriptionId }, this.generationId); }
	async reload(): Promise<void> { this.acceptSnapshot(await this.backend.request(BackendReload, { sessionId: this.sessionId, generationId: this.generationId, operationId: randomUUID() }, this.generationId)); }
	protect(params: { recovery: boolean; commits?: number; archived?: boolean; name?: string }): Promise<void> { return this.backend.request(BackendSetProtection, { sessionId: this.sessionId, generationId: this.generationId, ...params }, this.generationId); }
	shutdown(stop = false, reason: "release" | "archive" | "delete" | "terminal" = "release"): Promise<void> { return this.backend.release(this.sessionId, stop, reason); }
	exit(exit: PiProcessExit, error?: Error): void {
		if (this.hasExited) return;
		this.exitInfo = exit; this.events.emit("exit", exit, error); this.resolveExit(exit);
	}
}
