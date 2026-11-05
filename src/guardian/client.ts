import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createMessageConnection, IPCMessageReader, IPCMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import { OperationStore, type OwnershipRecord } from "../backend/operationStore";
import { ProcessHandle, WindowsJob } from "./native";
import type { GenerationAuthorization, GuardianReady, GuardianSnapshot, OwnershipProof } from "./protocol";

export interface GuardianClientOptions { nodePath: string; guardianEntry: string; log: (message: string) => void; signal?: AbortSignal; }
type Subscription = { dispose(): void };

function until<T>(promise: Promise<T>, deadline: number, operation: string, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
		const cancel = () => { finish(); reject(new Error(`${operation}已经取消`)); };
		const timer = setTimeout(() => { finish(); reject(new Error(`${operation}超过期限`)); }, Math.max(1, deadline - Date.now()));
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		promise.then((value) => { finish(); resolve(value); }, (error) => { finish(); reject(error); });
	});
}

/** 宿主持有第二个 Job 句柄，辅助程序负责持久归属和写入权限。 */
export class GuardianClient {
	private readonly invalidatedListeners = new Set<(error: Error) => void>();
	private readonly snapshotListeners = new Set<(snapshot: GuardianSnapshot | undefined) => void>();
	private readonly files = new Set<string>();
	private job: WindowsJob | undefined;
	private authorization: GenerationAuthorization | undefined;
	private invalidated = false;
	private closing = false;
	private cleaned = false;
	private disposed = false;
	private emergencyCleanup: Promise<void> | undefined;
	private lastSnapshot: GuardianSnapshot | undefined;
	private constructor(
		private readonly options: GuardianClientOptions,
		private readonly child: ChildProcess,
		private readonly connection: MessageConnection,
		private readonly processHandle: ProcessHandle,
	) {
		connection.onNotification("guardian/snapshot", (snapshot: GuardianSnapshot) => {
			if (this.authorization && snapshot.generationId !== this.authorization.generationId) return;
			this.lastSnapshot = snapshot;
			for (const listener of this.snapshotListeners) listener(snapshot);
		});
		connection.onNotification("guardian/invalidated", (event: { reason: string }) => this.invalidate(new Error(event.reason)));
		child.once("exit", (code, signal) => {
			this.lastSnapshot = undefined;
			for (const listener of this.snapshotListeners) listener(undefined);
			if (!this.closing) this.invalidate(new Error(`进程管理辅助程序退出：${code ?? signal}`));
		});
		child.once("disconnect", () => { if (!this.closing) this.invalidate(new Error("进程管理辅助程序连接已经关闭")); });
	}

	static async start(options: GuardianClientOptions, deadline = Date.now() + 5_000): Promise<GuardianClient> {
		if (options.signal?.aborted) throw new Error("启动进程管理辅助程序已经取消");
		const self = ProcessHandle.open(process.pid);
		const nonce = randomUUID();
		const identity = self.identity;
		self.close();
		const child = fork(options.guardianEntry, [JSON.stringify({ host: identity, nonce })], {
			execPath: options.nodePath, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], detached: true, windowsHide: true,
		});
		child.stderr?.on("data", (data: Buffer) => options.log(`进程管理辅助程序：${data.toString().trimEnd()}`));
		let handle: ProcessHandle | undefined;
		let connection: MessageConnection | undefined;
		let client: GuardianClient | undefined;
		try {
			await until(new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }), deadline, "启动进程管理辅助程序", options.signal);
			if (child.pid === undefined) throw new Error("进程管理辅助程序没有 PID");
			handle = ProcessHandle.open(child.pid, false, true);
			connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
			connection.listen();
			client = new GuardianClient({ ...options, signal: undefined }, child, connection, handle);
			const ready = await until(connection.sendRequest<GuardianReady>("guardian/hello", nonce), deadline, "验证进程管理辅助程序", options.signal);
			handle.assertIdentity(ready.guardian);
			return client;
		} catch (error) {
			if (client) client.closing = true;
			try {
				if (handle) handle.terminate(); else child.kill();
				connection?.dispose();
				if (child.connected) child.disconnect();
				if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
					await until(new Promise<void>((resolve) => child.once("exit", () => resolve())), deadline, "结束尚未就绪的进程管理辅助程序");
				}
			} finally { handle?.close(); }
			throw error;
		}
	}

	get pid(): number { return this.processHandle.identity.pid; }
	get currentSnapshot(): GuardianSnapshot | undefined { return this.lastSnapshot; }
	onInvalidated(listener: (error: Error) => void): Subscription { this.invalidatedListeners.add(listener); return { dispose: () => { this.invalidatedListeners.delete(listener); } }; }
	onSnapshot(listener: (snapshot: GuardianSnapshot | undefined) => void): Subscription { this.snapshotListeners.add(listener); return { dispose: () => { this.snapshotListeners.delete(listener); } }; }

	async launchGeneration(backend: ChildProcess, options: { generationId: string; token: string }, deadline = Date.now() + 5_000): Promise<GenerationAuthorization> {
		if (this.authorization || this.invalidated || this.closing || backend.pid === undefined) throw new Error("后台代次无法初始化");
		const handle = ProcessHandle.open(backend.pid);
		try {
			const authorization = await until(this.connection.sendRequest<GenerationAuthorization>("guardian/launch", { ...options, backend: handle.identity }), deadline, "分配后台 Job");
			if (this.invalidated || this.processHandle.exited) throw new Error("辅助程序在后台握手期间退出");
			if (authorization.generationId !== options.generationId || authorization.token !== options.token || authorization.guardianPid !== this.pid) throw new Error("后台启动确认身份不一致");
			handle.assertIdentity({ pid: authorization.backendPid, creationTime: authorization.backendCreationTime });
			this.job = WindowsJob.open(authorization.jobName);
			this.authorization = authorization;
			return authorization;
		} finally { handle.close(); }
	}

	async acquireSession(request: { sessionId: string; cwd: string; sessionFile: string }): Promise<OwnershipRecord> {
		if (!this.authorization || this.invalidated || this.closing) throw new Error("后台当前禁止取得会话写入权限");
		this.files.add(request.sessionFile);
		const record = await this.connection.sendRequest<OwnershipRecord>("guardian/authorize", { ...request, generationId: this.authorization.generationId });
		if (this.invalidated || this.closing || record.generationId !== this.authorization.generationId) throw new Error("会话授权完成前后台代次已经失效");
		return record;
	}

	async releaseSession(ownershipId: string): Promise<void> {
		if (this.invalidated || this.closing) throw new Error("后台当前无法释放会话写入权限");
		await this.connection.sendRequest("guardian/release", ownershipId);
	}

	/** 调用者从 deactivate 入口传入同一个四秒截止时间。 */
	async cleanup(deadline: number): Promise<void> {
		if (this.disposed) return;
		this.closing = true;
		if (this.emergencyCleanup) await until(this.emergencyCleanup, deadline, "完成旧后台清理");
		if (!this.processHandle.exited && this.child.connected) {
			try {
				if (!this.cleaned) await until(this.connection.sendRequest("guardian/cleanup", deadline), deadline - 250, "确认后台全部进程退出");
				this.cleaned = true;
				await until(this.connection.sendRequest("guardian/exit"), deadline, "结束进程管理辅助程序");
			} catch (error) {
				if (this.job) await this.job.terminate(deadline);
				this.processHandle.terminate();
				if (!this.cleaned) await this.cleanAfterGuardianExit(deadline);
				this.options.log(`辅助程序关闭过程：${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			await this.cleanAfterGuardianExit(deadline);
		}
		while (!this.processHandle.exited) {
			if (Date.now() >= deadline) throw new Error("等待进程管理辅助程序退出超过期限");
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		this.job?.close();
		this.job = undefined;
		this.connection.dispose();
		if (this.child.connected) this.child.disconnect();
		this.processHandle.close();
		this.disposed = true;
	}

	private invalidate(error: Error): void {
		if (this.invalidated || this.closing) return;
		this.invalidated = true;
		this.emergencyCleanup = this.cleanAfterGuardianExit(Date.now() + 4_000);
		void this.emergencyCleanup.catch((failure: unknown) => this.options.log(`旧后台保持保护状态：${failure instanceof Error ? failure.message : String(failure)}`));
		for (const listener of this.invalidatedListeners) listener(error);
	}

	private async cleanAfterGuardianExit(deadline: number): Promise<void> {
		if (this.cleaned) return;
		if (!this.job || !this.authorization) {
			if (!this.processHandle.exited) this.processHandle.terminate();
			this.cleaned = true;
			return;
		}
		await this.job.terminate(deadline);
		if (!this.processHandle.exited) {
			if (this.child.connected) {
				await until(this.connection.sendRequest("guardian/cleanup", deadline), deadline, "保存后台清理证明");
				this.cleaned = true;
				return;
			}
			this.processHandle.terminate();
		}
		while (!this.processHandle.exited) {
			if (Date.now() >= deadline) throw new Error("等待原辅助程序结束超过期限");
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		const proofs: OwnershipProof[] = [];
		for (const sessionFile of this.files) {
			const store = new OperationStore(sessionFile, { busyTimeoutMs: 100 });
			try {
				const record = store.latestOwnership();
				if (record?.generationId === this.authorization.generationId && record.state === "running") proofs.push({ sessionFile, record });
			} finally { store.close(); }
		}
		const replacement = await GuardianClient.start(this.options, deadline);
		try {
			await until(replacement.connection.sendRequest("guardian/prove", proofs), deadline, "提交旧代次清理证明");
			await replacement.cleanup(deadline);
			this.cleaned = true;
		} finally {
			if (!replacement.cleaned && !replacement.processHandle.exited) replacement.processHandle.terminate();
		}
	}
}
