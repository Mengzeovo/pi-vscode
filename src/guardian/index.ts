import { randomUUID } from "node:crypto";
import { createMessageConnection, IPCMessageReader, IPCMessageWriter } from "vscode-jsonrpc/node";
import { OperationStore, type OwnershipRecord } from "../backend/operationStore";
import { WriteLock } from "../sessions/writeLock";
import { ProcessHandle, WindowsJob } from "./native";
import type { GenerationAuthorization, GenerationRequest, GuardianSnapshot, GuardianStart, OwnershipProof, SessionOwnershipRequest } from "./protocol";
import { ProcessSampler } from "./usage";

const startup = JSON.parse(process.argv[2] ?? "null") as GuardianStart | null;
if (!startup || typeof startup.nonce !== "string" || !startup.host) throw new Error("进程管理辅助程序缺少启动身份");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("进程管理辅助程序要求 Node.js 24.15.0");
const host = ProcessHandle.open(startup.host.pid);
host.assertIdentity(startup.host);
const self = ProcessHandle.open(process.pid);
const connection = createMessageConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const owned = new Map<string, { store: OperationStore; lock: WriteLock; record: OwnershipRecord; sessionFile: string }>();
const sampler = new ProcessSampler();
let job: WindowsJob | undefined;
let backend: ProcessHandle | undefined;
let generation: GenerationAuthorization | undefined;
let cleaning = false;
let cleaned = false;
let cleanupPromise: Promise<void> | undefined;
let chain = Promise.resolve();

function sequence<T>(action: () => Promise<T>): Promise<T> {
	const result = chain.then(action);
	chain = result.then(() => undefined, () => undefined);
	return result;
}

function active(expected?: string): GenerationAuthorization {
	if (cleaning || !generation || !backend || backend.exited || host.exited || (expected !== undefined && generation.generationId !== expected)) throw new Error("后台代次已经失效");
	return generation;
}

function snapshot(): GuardianSnapshot {
	return { generationId: generation?.generationId, state: cleaning ? "cleaning" : "running", sessionIds: [...owned.values()].map((entry) => entry.record.sessionId), usage: sampler.sample() };
}

function publish(): void {
	if (process.connected) void connection.sendNotification("guardian/snapshot", snapshot()).catch(fatal);
}

async function cleanup(deadline: number): Promise<void> {
	if (cleanupPromise) return cleanupPromise;
	cleaning = true;
	publish();
	cleanupPromise = sequence(async () => {
		if (job) await job.terminate(deadline);
		for (const entry of owned.values()) {
			if (Date.now() >= deadline) throw new Error("保存进程清理证明超过关闭期限");
			entry.store.finishOwnership(entry.record, "cleaned");
		}
		for (const entry of owned.values()) { await entry.lock.release(); entry.store.close(); }
		owned.clear();
		cleaned = true;
		publish();
	});
	return cleanupPromise;
}

function fatal(error: unknown): void {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
}

async function finishAfterHostExit(): Promise<void> {
	try { await cleanup(Date.now() + 4_000); }
	catch (error) { fatal(error); }
	finally { process.exit(cleaned ? 0 : 1); }
}

connection.onRequest("guardian/hello", (nonce: string) => {
	if (nonce !== startup.nonce) throw new Error("进程管理辅助程序启动凭据无效");
	host.assertIdentity(startup.host);
	return { guardian: self.identity };
});

connection.onRequest("guardian/launch", (request: GenerationRequest) => sequence(async () => {
	if (job || cleaning || host.exited) throw new Error("当前辅助程序无法建立新的后台代次");
	if (!request.generationId || !request.token) throw new Error("后台启动身份不完整");
	backend = ProcessHandle.open(request.backend.pid, true);
	backend.assertIdentity(request.backend);
	job = WindowsJob.create(`Global\\PiHarness-${randomUUID()}`);
	job.assign(backend);
	generation = {
		generationId: request.generationId, token: request.token, jobName: job.name,
		hostPid: host.identity.pid, hostCreationTime: host.identity.creationTime,
		guardianPid: self.identity.pid, guardianCreationTime: self.identity.creationTime,
		backendPid: backend.identity.pid, backendCreationTime: backend.identity.creationTime,
	};
	return generation;
}));

connection.onRequest("guardian/authorize", (request: SessionOwnershipRequest) => sequence(async () => {
	const current = active(request.generationId);
	if ([...owned.values()].some((entry) => entry.record.sessionId === request.sessionId)) throw new Error(`会话已经取得写入权限：${request.sessionId}`);
	const lock = await WriteLock.acquire(request.cwd, request.sessionId);
	if (!lock) throw new Error(`会话正在被其他窗口使用：${request.sessionId}`);
	let store: OperationStore | undefined;
	let accepted = false;
	try {
		store = new OperationStore(request.sessionFile, { busyTimeoutMs: 100 });
		const previous = store.latestOwnership();
		if (previous?.state === "running") {
			const hostPresent = ProcessHandle.matches({ pid: previous.hostPid, creationTime: previous.hostCreationTime });
			const guardianPresent = ProcessHandle.matches({ pid: previous.guardianPid, creationTime: previous.guardianCreationTime });
			if (hostPresent || guardianPresent) throw new Error(`原窗口仍在处理会话进程清理：${request.sessionId}`);
			const previousJob = WindowsJob.open(previous.jobName);
			try { await previousJob.terminate(Date.now() + 1_000); store.finishOwnership(previous, "cleaned"); }
			finally { previousJob.close(); }
		}
		active(request.generationId);
		const now = Date.now();
		const record: OwnershipRecord = {
			ownershipId: randomUUID(), sessionId: request.sessionId, generationId: current.generationId, jobName: current.jobName,
			hostPid: current.hostPid, hostCreationTime: current.hostCreationTime,
			guardianPid: current.guardianPid, guardianCreationTime: current.guardianCreationTime,
			backendPid: current.backendPid, backendCreationTime: current.backendCreationTime,
			state: "running", createdAt: now, updatedAt: now,
		};
		store.claimOwnership(record);
		owned.set(record.ownershipId, { store, lock, record, sessionFile: request.sessionFile });
		accepted = true;
		publish();
		return record;
	} finally {
		if (!accepted) { store?.close(); await lock.release(); }
	}
}));

connection.onRequest("guardian/release", (ownershipId: string) => sequence(async () => {
	active();
	const entry = owned.get(ownershipId);
	if (!entry) throw new Error(`会话写入身份不存在：${ownershipId}`);
	entry.store.finishOwnership(entry.record, "released");
	await entry.lock.release();
	entry.store.close();
	owned.delete(ownershipId);
	publish();
}));

connection.onRequest("guardian/prove", (proofs: OwnershipProof[]) => sequence(async () => {
	if (job || owned.size !== 0) throw new Error("清理证明必须在后台初始化之前提交");
	for (const proof of proofs) {
		if (proof.record.hostPid !== host.identity.pid || proof.record.hostCreationTime !== host.identity.creationTime) throw new Error("旧代次清理证明的宿主身份不一致");
		const oldJob = WindowsJob.open(proof.record.jobName);
		try {
			if (oldJob.activeProcesses !== 0) throw new Error("旧 Job 仍有运行进程");
			const store = new OperationStore(proof.sessionFile, { busyTimeoutMs: 100 });
			try { store.finishOwnership(proof.record, "cleaned"); } finally { store.close(); }
		} finally { oldJob.close(); }
	}
}));

connection.onRequest("guardian/cleanup", async (deadline: number) => { await cleanup(deadline); return { cleaned: true }; });
connection.onRequest("guardian/exit", () => {
	if (!cleaned && job) throw new Error("Job 清理尚未完成");
	setTimeout(() => process.exit(0), 20);
});
connection.listen();

const monitor = setInterval(() => {
	if (host.exited) { clearInterval(monitor); void finishAfterHostExit(); return; }
	if (backend?.exited && !cleaning) {
		void cleanup(Date.now() + 4_000).then(() => {
			if (process.connected) return connection.sendNotification("guardian/invalidated", { generationId: generation?.generationId, reason: "后台进程已经退出", cleaned: true });
		}, fatal);
	}
}, 50);
const sampling = setInterval(publish, 2_000);
sampling.unref();
process.once("disconnect", () => { clearInterval(monitor); void finishAfterHostExit(); });
process.once("exit", () => { backend?.close(); job?.close(); self.close(); host.close(); });
