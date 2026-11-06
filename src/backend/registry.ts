import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, AgentSessionServices, JsonAgentSessionEvent, RpcSessionState, ScopedModel, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import { FileRestoreApply, FileRestorePrepare, FileWaitForIdle, Hello, type CommitIdentity, type CopilotToolDeclaration } from "../../shared/protocol";
import { BackendCatalogChanged, BackendEvent, BackendSessionChanged, BackendSessionReleased, BackendSnapshot, BackendUi,
		type BackendCatalogSnapshot, type BackendCommandInput, type BackendIdentity, type BackendInitializeParams, type BackendOpenParams, type BackendRestoreInput, type BackendRpcCommand, type BackendSessionSnapshot } from "./protocol";
import { OperationSequence, ResourceFactory, type SessionResources } from "./resources";
import { BackendUiBridge } from "./ui";
import { OperationStore, type RestoreInput, type RestoreOperation } from "./operationStore";
import { RecoveryCoordinator } from "./recoveryCoordinator";

const LOAD_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function withDeadline<T>(operation: Promise<T> | (() => Promise<T>), timeout: number, label: string, expired?: () => void): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const expiresAt = performance.now() + timeout;
	let timedOut = false;
	const timeoutError = (): Error => {
		if (!timedOut) { timedOut = true; expired?.(); }
		return new Error(`${label}超过 ${Math.ceil(timeout / 1000)} 秒期限；所属操作仍保持保护，等待清理完成`);
	};
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(timeoutError()), Math.max(1, timeout));
	});
	const pending = (typeof operation === "function" ? Promise.resolve().then(operation) : operation).then((result) => {
		if (performance.now() >= expiresAt) throw timeoutError();
		return result;
	});
	return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

interface RequestExecution { identity: CommitIdentity; preflight: boolean; delegatedControl: boolean; }
interface PendingInput { identity: CommitIdentity; mode: "start" | "steer" | "followUp"; text?: string; }

interface Resident {
	options: BackendOpenParams;
	manager: SessionManager;
	store: OperationStore;
	coordinator?: RecoveryCoordinator;
	control: OperationSequence;
	resources?: SessionResources;
	runtime?: AgentSessionRuntime;
	connection?: MessageConnection;
	ui?: BackendUiBridge;
	unsubscribe?: () => void;
	generation: number;
	sequence: number;
	epoch: number;
	identities: Map<string, CommitIdentity>;
	identity?: CommitIdentity;
	inputs: PendingInput[];
	queues: { steering: { text: string; input?: PendingInput }[]; followUp: { text: string; input?: PendingInput }[] };
	delivered: PendingInput[];
	dispatches: Map<Promise<unknown>, RequestExecution>;
	stopping?: Promise<void>;
	state: BackendSessionSnapshot["state"];
	error?: string;
	mcpError?: string;
	lifecycleErrors: string[];
	subscriptions: Set<string>;
	lastUsed: number;
	archived: boolean;
	recovery: boolean;
	commits: number;
	reloadPending: boolean;
	reload?: Promise<BackendSessionSnapshot>;
	loading?: Promise<void>;
	closing?: Promise<void>;
	accepting: boolean;
	partial?: unknown;
	cleanupUnconfirmed?: string;
	extensionFlags?: Map<string, boolean | string>;
	tools?: { active: string[]; known: Set<string> };
}

export class BackendRegistry {
	private readonly sessions = new Map<string, Resident>();
	private readonly prepared = new Map<string, SessionManager>();
	private readonly catalogs = new Map<string, Promise<BackendCatalogSnapshot>>();
	private readonly catalogLoading = new Set<string>();
	private readonly catalogProtected = new Map<string, string>();
	private trimming: Promise<void> | undefined;
	private readonly execution = new AsyncLocalStorage<RequestExecution>();
	private shutdownRequested = false;
	private readonly intervals: NodeJS.Timeout[] = [];
	private lastCpu = process.cpuUsage();
	private lastTime = process.hrtime.bigint();
	private constructor(readonly factory: ResourceFactory, private readonly transport: MessageConnection, private readonly theme: Theme,
		private readonly toJsonEvent: (event: AgentSessionEvent) => JsonAgentSessionEvent) {}

	static async create(options: BackendInitializeParams, transport: MessageConnection): Promise<BackendRegistry> {
		const factory = await ResourceFactory.load(options);
		const theme = await import(pathToFileURL(join(options.packageDir, "dist", "modes", "interactive", "theme", "theme.js")).href) as { theme: Theme; initTheme(name?: string): void };
		theme.initTheme();
		const json = await import(pathToFileURL(join(options.packageDir, "dist", "modes", "json-event.js")).href) as { toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent };
		const registry = new BackendRegistry(factory, transport, theme.theme, json.toJsonEvent);
		registry.intervals.push(setInterval(() => registry.publishProcess(), 2_000), setInterval(() => void registry.trim().catch((error) => console.error(message(error))), 30_000));
		for (const timer of registry.intervals) timer.unref();
		return registry;
	}

	assertGeneration(identity: { generationId: string }): void {
		if (identity.generationId !== this.factory.options.generationId) throw new Error("请求所属后台代次已失效");
	}
	private get(identity: BackendIdentity): Resident {
		this.assertGeneration(identity);
		const entry = this.sessions.get(identity.sessionId);
		if (!entry) throw new Error(`会话 ${identity.sessionId} 没有加载`);
		entry.lastUsed = Date.now();
		return entry;
	}

	prepare(params: BackendIdentity & { cwd: string; sessionDir: string; sessionFile?: string }): { sessionFile: string } {
		this.assertGeneration(params);
		if (this.shutdownRequested) throw new Error("后台正在关闭");
		if (params.sessionFile && existsSync(params.sessionFile)) return { sessionFile: params.sessionFile };
		let manager = this.prepared.get(params.sessionId);
		if (!manager) { manager = this.factory.sdk.SessionManager.create(params.cwd, params.sessionDir, { id: params.sessionId }); this.prepared.set(params.sessionId, manager); }
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Pi 没有生成会话文件地址");
		return { sessionFile };
	}

	async open(options: BackendOpenParams): Promise<BackendSessionSnapshot> {
		this.assertGeneration(options);
		if (this.shutdownRequested) throw new Error("后台正在关闭");
		if (!options.ownershipId) throw new Error("会话启动缺少写入授权身份");
		const present = this.sessions.get(options.sessionId);
		if (present) {
			if (present.options.ownershipId !== options.ownershipId) throw new Error("会话已有不同的写入授权");
			if (present.loading) await present.loading;
			return present.control.run(async () => {
				if (this.sessions.get(options.sessionId) !== present || present.state === "released") throw new Error("会话已经释放，需要重新打开");
				for (const subscription of options.initialSubscriptions ?? []) present.subscriptions.add(subscription);
				this.publish(present); return this.snapshot(present);
			});
		}
		const store = new OperationStore(options.sessionFile);
		const owner = store.latestOwnership();
		if (!owner || owner.ownershipId !== options.ownershipId || owner.generationId !== options.generationId || owner.state !== "running") { store.close(); throw new Error("持久化会话写入授权尚未完成"); }
		let manager: SessionManager;
		try {
			manager = this.prepared.get(options.sessionId) ?? this.factory.sdk.SessionManager.open(options.sessionFile, options.sessionDir, options.cwd);
			if (manager.getSessionId() !== options.sessionId || resolve(manager.getSessionFile() ?? "") !== resolve(options.sessionFile)) throw new Error("会话文件与授权身份不一致");
			if (!existsSync(options.sessionFile)) {
				const header = manager.getHeader();
				if (!header || manager.getEntryCount() !== 0) throw new Error("新会话必须具有原生头部且尚无历史条目");
				let descriptor: number;
				try { descriptor = openSync(options.sessionFile, "wx"); }
				catch (error) {
					if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
						const existing = this.factory.sdk.parseSessionEntries(readFileSync(options.sessionFile, "utf8")).find((entry) => entry.type === "session");
						throw new Error(existing?.id === options.sessionId ? "会话文件在创建期间已由其他写入者建立，请重新核查写入权限" : "会话文件在创建期间出现不同的原生会话身份", { cause: error });
					}
					throw error;
				}
				try { writeFileSync(descriptor, `${JSON.stringify(header)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
				manager.setSessionFile(options.sessionFile);
				if (manager.getSessionId() !== options.sessionId || manager.getHeader()?.timestamp !== header.timestamp) throw new Error("新会话原生头部重新读取校验失败");
			}
		} catch (error) { store.close(); throw error; }
		this.prepared.delete(options.sessionId);
		const pending = store.getPendingRestore();
		const entry: Resident = { options, manager, store, control: new OperationSequence(), generation: 0, sequence: 0, epoch: pending?.operationEpoch ?? 0, identities: new Map(), inputs: [], queues: { steering: [], followUp: [] }, delivered: [], dispatches: new Map(), state: "loading", lifecycleErrors: [], subscriptions: new Set(options.initialSubscriptions), lastUsed: Date.now(), archived: false, recovery: Boolean(pending), commits: 0, reloadPending: false, accepting: false };
		this.sessions.set(options.sessionId, entry);
		await this.load(entry, false);
		if (pending) await this.resumeRecovery(options);
		void this.trim().catch((error) => console.error(message(error)));
		return this.snapshot(entry);
	}

	private identity(entry: Resident): CommitIdentity {
		const execution = this.execution.getStore();
		const identity = execution?.preflight ? execution.identity : entry.identity;
		if (!identity) throw new Error("当前会话没有获得执行请求授权");
		return identity;
	}

	validateIdentity(identity: CommitIdentity): void {
		const entry = this.get(identity);
		const current = entry.identities.get(identity.rootRequestId);
		if (!current || !entry.accepting || entry.recovery || entry.generation !== identity.runtimeGeneration || entry.epoch !== identity.operationEpoch || entry.options.ownershipId !== identity.ownershipId || current.runId !== identity.runId) throw new Error("文件提交所属请求身份已失效");
	}
	recordFileIntent(identity: CommitIdentity, edit: Parameters<OperationStore["recordEdit"]>[0]): void { this.validateIdentity(identity); this.get(identity).store.recordEdit(edit, identity); }

	private async connectBridge(entry: Resident): Promise<readonly CopilotToolDeclaration[]> {
		const socket = connect(entry.options.bridge.path);
		await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
		entry.connection = connection;
		connection.onClose(() => {
			entry.accepting = false;
			if (entry.state !== "released" && entry.state !== "releasing") { entry.error = "编辑器连接已经关闭"; entry.state = "protected"; this.publish(entry); void this.stop(entry).catch((error) => console.error(message(error))); }
		});
		connection.listen();
		const result = await connection.sendRequest(Hello, { token: entry.options.bridge.token, sessionId: entry.options.sessionId, sessionFile: entry.options.sessionFile,
			role: "root", identity: { sessionId: entry.options.sessionId, generationId: entry.options.generationId, ownershipId: entry.options.ownershipId, runtimeGeneration: entry.generation } });
		return result.copilotTools;
	}

	private load(entry: Resident, reload: boolean): Promise<void> {
		if (entry.loading) return entry.loading;
		let expired = false;
		const operation = this.factory.sequence.run(async () => {
			try {
				entry.generation++;
				entry.lifecycleErrors = [];
				entry.state = reload ? "reloading" : "loading";
				this.publish(entry);
				if (!entry.resources) {
					const tools = await this.connectBridge(entry);
					entry.resources = this.factory.create(entry.options, entry.connection, tools, () => this.identity(entry), (state) => {
						const server = state.servers.find((item) => item.enabled && ["failed", "disconnected", "needs-auth"].includes(item.state));
						entry.mcpError = state.configurationErrors.length ? `MCP 配置错误：${state.configurationErrors.join("；")}` : server ? `MCP ${server.name}：${server.state === "needs-auth" ? "需要登录" : server.error ?? server.state}` : undefined;
						this.publish(entry);
					}, (edit, identity) => entry.store.recordEdit(edit, identity));
				}
				const resources = entry.resources;
				const services = await resources.load(entry.generation, entry.extensionFlags);
				const scopedModels = await this.resolveSavedModelScope(services);
				const selected = entry.options.model;
				const initial = entry.manager.buildSessionContext().messages.length === 0 ? scopedModels?.[0] : undefined;
				const model = selected ? services.modelRuntime.getAvailableSnapshot().find((model) => model.provider === selected.provider && model.id === selected.modelId) : initial?.model;
				if (selected && !model) throw new Error(`模型不可用：${selected.provider}/${selected.modelId}`);
				entry.runtime = await this.factory.sdk.createAgentSessionRuntime(async () => ({ ...(await this.factory.sdk.createAgentSessionFromServices({ services, sessionManager: entry.manager,
					model, thinkingLevel: selected ? selected.thinkingLevel : initial?.thinkingLevel, scopedModels, sessionStartEvent: { type: "session_start", reason: reload ? "reload" : "startup" } })), services, diagnostics: services.diagnostics }),
					{ cwd: entry.options.cwd, agentDir: services.agentDir, sessionManager: entry.manager });
				resources.checkDiagnostics();
				await this.bind(entry);
				entry.coordinator = this.createRecovery(entry);
				resources.checkDiagnostics();
				this.checkLifecycle(entry);
				while (!resources.checkMcp()) { if (expired) throw new Error("资源加载已经超过期限"); await delay(25); }
				this.checkLifecycle(entry);
				if (expired) throw new Error("资源加载已经超过期限");
				if (entry.tools) {
					const available = new Set(entry.runtime.session.getAllTools().map((tool) => tool.name));
					entry.runtime.session.setActiveToolsByName([...entry.tools.active.filter((name) => available.has(name)), ...entry.runtime.session.getActiveToolNames().filter((name) => !entry.tools!.known.has(name))]);
				}
				entry.state = "loaded"; entry.error = undefined; entry.accepting = true;
				this.catalogs.delete(entry.options.cwd);
				void this.transport.sendNotification(BackendCatalogChanged, { generationId: entry.options.generationId, cwd: entry.options.cwd, sessionId: entry.options.sessionId });
				this.publish(entry);
			} catch (error) {
				entry.accepting = false; entry.error = message(error); entry.state = reload ? "reload-failed" : "protected";
				const services = entry.resources?.getServicesForCleanup();
				if (!entry.runtime && services) {
					try { entry.runtime = await this.factory.sdk.createAgentSessionRuntime(async () => ({ ...await this.factory.sdk.createAgentSessionFromServices({ services, sessionManager: entry.manager }), services, diagnostics: services.diagnostics }), { cwd: entry.options.cwd, agentDir: services.agentDir, sessionManager: entry.manager }); }
					catch (cleanupError) { entry.cleanupUnconfirmed = `无法建立所属资源清理上下文：${message(cleanupError)}`; }
				}
				if (entry.runtime) {
					try { await this.closeRuntime(entry, false); } catch (closeError) { entry.error += `\n清理错误：${message(closeError)}`; entry.state = "protected"; }
				}
				if (entry.resources?.initializationUnconfirmed) entry.cleanupUnconfirmed = "扩展工厂未完整返回，不能确认其创建的全部资源已经关闭";
				if (entry.cleanupUnconfirmed) { entry.state = "protected"; entry.error += `\n${entry.cleanupUnconfirmed}`; }
				this.publish(entry); throw error;
			}
		});
		entry.loading = operation;
		void operation.then(() => { entry.loading = undefined; this.publish(entry); }, () => { entry.loading = undefined; this.publish(entry); });
		return withDeadline(operation, LOAD_TIMEOUT_MS, "会话资源加载", () => { expired = true; entry.accepting = false; entry.state = "protected"; entry.error = "资源加载超过期限，正在等待所属加载与清理结束"; this.publish(entry); });
	}

	private async bind(entry: Resident): Promise<void> {
		const session = entry.runtime!.session;
		const generation = entry.generation;
		entry.ui = new BackendUiBridge(this.theme, (request) => {
			if (entry.generation !== generation) return;
			void this.transport.sendNotification(BackendUi, { ...this.envelope(entry), request });
		}, () => this.publish(entry));
		entry.unsubscribe = session.subscribe((event) => {
			if (entry.generation !== generation || entry.state === "released") return;
			if (event.type === "queue_update") {
				for (const [key, mode] of [["steering", "steer"], ["followUp", "followUp"]] as const) {
					const removed = new Map<string, number>();
					for (const item of entry.queues[key]) removed.set(item.text, (removed.get(item.text) ?? 0) + 1);
					for (const text of event[key]) removed.set(text, (removed.get(text) ?? 0) - 1);
					const retained = entry.queues[key].filter((item) => {
						if ((removed.get(item.text) ?? 0) <= 0) return true;
						removed.set(item.text, removed.get(item.text)! - 1);
						if (item.input && entry.inputs.includes(item.input)) entry.delivered.push(item.input);
						return false;
					});
					entry.queues[key] = event[key].map((text) => {
						const index = retained.findIndex((item) => item.text === text);
						if (index >= 0) return retained.splice(index, 1)[0];
						const submitting = this.execution.getStore();
						const pending = submitting?.preflight ? entry.inputs.find((item) => item.identity === submitting.identity && item.text === undefined) : undefined;
						if (pending) { pending.mode = mode; pending.text = text; }
						return { text, input: pending };
					});
				}
			}
			if (event.type === "message_start" && event.message.role === "user") {
				const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
				const starting = entry.inputs.find((item) => item.mode === "start" && item.identity === entry.identity);
				const consumed = starting ? -1 : entry.delivered.findIndex((item) => item.text === text);
				const input = starting ?? (consumed >= 0 ? entry.delivered.splice(consumed, 1)[0] : undefined);
				if (input) { entry.inputs = entry.inputs.filter((item) => item !== input); entry.identity = input.identity; }
			}
			if (event.type === "message_update") entry.partial = event.message;
			if (event.type === "message_end" || event.type === "agent_settled") entry.partial = undefined;
			void this.transport.sendNotification(BackendEvent, { ...this.envelope(entry), event: this.toJsonEvent(event) });
			if (event.type === "agent_start") entry.state = entry.reloadPending ? "reload-pending" : "running";
			if (event.type === "agent_settled") entry.state = entry.reloadPending ? "reload-pending" : "loaded";
			this.publish(entry);
		});
		await this.factory.compat.runHarnessScope(entry.resources!.scope, () => session.bindExtensions({
			mode: "rpc", uiContext: entry.ui!.context, onError: (error) => {
				entry.lifecycleErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`);
				entry.error = `${error.extensionPath} (${error.event}): ${error.error}`;
				this.publish(entry);
			},
			shutdownHandler: () => { void this.release(entry.options, true).catch((error) => console.error(message(error))); },
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				reload: async () => {
					const execution = this.execution.getStore();
					if (execution) execution.delegatedControl = true;
					try { await this.reload(entry.options); } finally { if (execution) execution.delegatedControl = false; }
				},
				navigateTree: (id, options) => session.navigateTree(id, options),
				newSession: async () => { throw new Error("请通过 Chat 创建新的会话"); },
				fork: async () => { throw new Error("请通过 Chat 创建会话分支"); },
				switchSession: async () => { throw new Error("请通过 Chat 选择目标会话"); },
			},
		}));
	}

	private checkLifecycle(entry: Resident): void { if (entry.lifecycleErrors.length) throw new Error(entry.lifecycleErrors.join("\n")); }
	private async closeRuntime(entry: Resident, reload: boolean): Promise<void> {
		if (!entry.runtime) return;
		if (entry.closing) return entry.closing;
		const runtime = entry.runtime;
		entry.lifecycleErrors = [];
		const stopErrors = runtime.session.extensionRunner.onError((error) => entry.lifecycleErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`));
		const operation = this.factory.compat.runHarnessScope(entry.resources!.scope, async () => {
			if (reload) {
				await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
				this.checkLifecycle(entry);
				if (entry.resources!.mcpState && !entry.resources!.mcpState.closeComplete) throw new Error("MCP 关闭尚未完成");
				runtime.session.dispose();
			} else {
				await runtime.dispose();
				this.checkLifecycle(entry);
				if (entry.resources!.mcpState && !entry.resources!.mcpState.closeComplete) throw new Error("MCP 关闭尚未完成");
			}
			if (typeof entry.resources!.scope.cleanupUnconfirmed === "string") throw new Error(entry.resources!.scope.cleanupUnconfirmed);
			entry.unsubscribe?.(); entry.unsubscribe = undefined; entry.ui?.cancelAll(); entry.ui = undefined;
			entry.runtime = undefined;
			await entry.resources!.original.flush();
		}).finally(stopErrors);
		entry.closing = operation;
		void operation.then(() => { entry.closing = undefined; this.publish(entry); }, () => undefined);
		return operation;
	}

	private busy(entry: Resident): boolean { return Boolean(entry.runtime && (!entry.runtime.session.isIdle || entry.runtime.session.isBashRunning)) || [...entry.dispatches.values()].some((execution) => !execution.delegatedControl) || this.childCount(entry) > 0 || (entry.ui?.count ?? 0) > 0 || entry.commits > 0; }
	private childCount(entry: Resident): number { return entry.resources ? this.factory.compat.getHarnessTaskCount(entry.resources.scope) : 0; }

	reload(identity: BackendIdentity): Promise<BackendSessionSnapshot> {
		const entry = this.get(identity);
		if (entry.reload) return entry.reload;
		if (entry.recovery || entry.store.getPendingRestore()) return Promise.reject(new Error("会话文件恢复尚未完成"));
		if (typeof entry.resources?.scope.cleanupUnconfirmed === "string") return Promise.reject(new Error(entry.resources.scope.cleanupUnconfirmed));
		if (entry.cleanupUnconfirmed) return Promise.reject(new Error(entry.cleanupUnconfirmed));
		if (entry.loading || entry.closing) return Promise.reject(new Error("所属加载或关闭操作仍未结束"));
		entry.reloadPending = true; entry.state = "reload-pending"; this.publish(entry);
		const pending = (async () => {
			while (this.busy(entry)) { if (!entry.reloadPending) throw new Error("等待中的重新加载已取消"); await delay(25); }
			await entry.control.run(async () => {
				if (!entry.reloadPending) throw new Error("等待中的重新加载已取消");
				if (this.busy(entry)) throw new Error("会话重新加载期间出现新的工作");
				entry.accepting = false; entry.state = "reloading"; this.publish(entry);
				const session = entry.runtime?.session;
				if (session?.model && session.modelRuntime.getModel(session.model.provider, session.model.id)) entry.options = { ...entry.options, model: { provider: session.model.provider, modelId: session.model.id, thinkingLevel: session.thinkingLevel } };
				if (session) {
					entry.extensionFlags = new Map(session.resourceLoader.getExtensions().runtime.flagValues);
					entry.tools = { active: session.getActiveToolNames(), known: new Set(session.getAllTools().map((tool) => tool.name)) };
				}
				entry.epoch++; entry.identities.clear(); entry.inputs = []; entry.delivered = []; entry.queues = { steering: [], followUp: [] };
				await withDeadline(() => this.closeRuntime(entry, true), CLOSE_TIMEOUT_MS, "旧会话资源关闭");
				await this.load(entry, true);
			});
			entry.reloadPending = false; this.publish(entry); return this.snapshot(entry);
		})().catch((error: unknown) => { entry.error = message(error); entry.state = entry.closing || entry.loading ? "protected" : "reload-failed"; entry.accepting = false; entry.reloadPending = false; this.publish(entry); throw error; });
		entry.reload = pending;
		void pending.then(() => { entry.reload = undefined; }, () => { entry.reload = undefined; });
		return pending;
	}

	async command(identity: BackendIdentity & { requestId: string; command: BackendRpcCommand; input?: BackendCommandInput }): Promise<unknown> {
		const entry = this.get(identity);
		const command = identity.command;
		if (command.type === "abort") return this.stop(entry);
		if (entry.reloadPending && ["prompt", "steer", "follow_up"].includes(command.type)) { await entry.reload; return this.command(identity); }
		if (!entry.runtime) throw new Error(entry.error ?? "会话运行时不可用");
		const session = entry.runtime.session;
		if (command.type === "get_state") return this.rpcState(session);
		if (command.type === "clear_queue") { entry.inputs = entry.inputs.filter((item) => item.mode === "start"); entry.delivered = []; return session.clearQueue(); }
		if (command.type === "get_messages") return { messages: session.messages };
		if (command.type === "get_entries") { const entries = entry.manager.getEntries(); const index = command.since ? entries.findIndex((item) => item.id === command.since) : -1; if (command.since && index < 0) throw new Error(`条目 ${command.since} 不存在`); return { entries: entries.slice(index + 1), leafId: entry.manager.getLeafId() }; }
		if (command.type === "get_tree") return { tree: entry.manager.getTree(), leafId: entry.manager.getLeafId() };
		if (command.type === "get_available_models") return { models: session.modelRuntime.getAvailableSnapshot() };
		if (command.type === "get_available_thinking_levels") return { levels: session.getAvailableThinkingLevels() };
		if (command.type === "get_session_stats") return session.getSessionStats();
		if (command.type === "get_fork_messages") return { messages: session.getUserMessagesForForking() };
		if (command.type === "get_last_assistant_text") return { text: session.getLastAssistantText() };
		if (command.type === "get_commands") return { commands: [
			...session.extensionRunner.getRegisteredCommands().map((item) => ({ name: item.invocationName, description: item.description, source: "extension", sourceInfo: item.sourceInfo })),
			...session.promptTemplates.map((item) => ({ name: item.name, description: item.description, source: "prompt", sourceInfo: item.sourceInfo })),
			...session.resourceLoader.getSkills().skills.map((item) => ({ name: `skill:${item.name}`, description: item.description, source: "skill", sourceInfo: item.sourceInfo })),
		] };
		if (!entry.accepting || entry.recovery || entry.stopping) throw new Error(entry.error ?? "当前会话正在处理控制操作");
		if (typeof entry.resources?.scope.cleanupUnconfirmed === "string") throw new Error(entry.resources.scope.cleanupUnconfirmed);
		if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
			const accepted = await entry.control.run(async () => {
				if (!entry.accepting || entry.recovery || entry.reloadPending || entry.stopping) throw new Error("当前会话暂停接收新消息");
				const recovery = entry.store.getPendingRestore();
				if (recovery) entry.coordinator!.acceptExplicitRequest(identity.requestId, { ...recovery.input, ...identity.input, message: command.message, images: command.images });
				const commit: CommitIdentity = { sessionId: entry.options.sessionId, generationId: entry.options.generationId, ownershipId: entry.options.ownershipId, runtimeGeneration: entry.generation, rootRequestId: identity.requestId, runId: randomUUID(), operationEpoch: entry.epoch };
				if (entry.identities.has(commit.rootRequestId)) throw new Error("请求身份已经使用");
				const mode = command.type === "steer" ? "steer" : command.type === "follow_up" ? "followUp" : session.isStreaming ? command.streamingBehavior ?? "steer" : "start";
				entry.inputs.push({ identity: commit, mode }); entry.identities.set(commit.rootRequestId, commit); entry.resources!.scope.blocked = false;
				const execution: RequestExecution = { identity: commit, preflight: true, delegatedControl: false };
				const removePending = () => { entry.inputs = entry.inputs.filter((item) => item.identity !== commit); };
				const response = this.execution.run(execution, () => this.factory.compat.runHarnessScope(entry.resources!.scope, () => new Promise((resolve, reject) => {
					let accepted = false;
					const preflight = (disposition: "handled" | "queued" | "started") => {
						execution.preflight = false; accepted = true;
						if (disposition === "started") entry.identity = commit;
						if (disposition === "handled") removePending();
						resolve({ disposition });
					};
					const operation = command.type === "prompt"
						? session.prompt(command.message, { images: command.images, streamingBehavior: command.streamingBehavior, source: "rpc", preflightResult: preflight })
						: (command.type === "steer" ? session.steer(command.message, command.images, { source: "rpc" }) : session.followUp(command.message, command.images, { source: "rpc" })).then(preflight);
					entry.dispatches.set(operation, execution);
					this.publish(entry);
					void operation.then(() => { entry.dispatches.delete(operation); this.publish(entry); }, () => { entry.dispatches.delete(operation); this.publish(entry); });
					void operation.catch((error) => { execution.preflight = false; removePending(); entry.identities.delete(commit.rootRequestId); if (!accepted) reject(error); else { entry.error = message(error); this.publish(entry); } });
				})));
				return { response };
			});
			return accepted.response;
		}
		return entry.control.run(async () => this.factory.compat.runHarnessScope(entry.resources!.scope, async () => {
			switch (command.type) {
				case "set_model": { const model = session.modelRuntime.getAvailableSnapshot().find((item) => item.provider === command.provider && item.id === command.modelId); if (!model) throw new Error(`模型不可用：${command.provider}/${command.modelId}`); await session.setModel(model, { persist: false }); return model; }
				case "set_thinking_level": session.setThinkingLevel(command.level, { persist: false }); return;
				case "cycle_model": return session.cycleModel();
				case "cycle_thinking_level": return { level: session.cycleThinkingLevel() };
				case "set_steering_mode": session.setSteeringMode(command.mode); return;
				case "set_follow_up_mode": session.setFollowUpMode(command.mode); return;
				case "set_auto_compaction": session.setAutoCompactionEnabled(command.enabled); return;
				case "set_auto_retry": session.setAutoRetryEnabled(command.enabled); return;
				case "abort_retry": session.abortRetry(); return;
				case "abort_bash": session.abortBash(); return;
				case "compact": return session.compact(command.customInstructions);
				case "bash": return session.executeBash(command.command, undefined, { excludeFromContext: command.excludeFromContext, id: identity.requestId });
				case "set_session_name": session.setSessionName(command.name); this.publish(entry); return;
				case "export_html": return { path: await session.exportToHtml(command.outputPath) };
				default: throw new Error(`当前 Chat 不允许执行 ${command.type}；请使用会话菜单`);
			}
		}));
	}

	private stop(entry: Resident): Promise<void> {
		if (entry.stopping) return entry.stopping;
		const operation = (async () => {
			entry.epoch++; entry.identities.clear(); entry.inputs = []; entry.delivered = []; entry.runtime?.session.clearQueue(); entry.ui?.cancelAll();
			entry.runtime?.session.abortBash();
			const children = entry.resources ? this.factory.compat.stopHarnessTasks(entry.resources.scope) : Promise.resolve();
			const prompts = (async () => {
				for (;;) {
					await entry.runtime?.session.abort();
					if (!entry.dispatches.size) break;
					await Promise.race([Promise.allSettled([...entry.dispatches.keys()]), delay(25)]);
				}
			})();
			await Promise.all([children, prompts]);
			while (entry.commits > 0 || entry.runtime?.session.isBashRunning) await delay(10);
			await entry.runtime?.session.waitForIdle(); this.publish(entry);
		})();
		entry.stopping = operation;
		void operation.then(() => { entry.stopping = undefined; }, () => { entry.stopping = undefined; });
		return operation;
	}

	async release(identity: BackendIdentity, stop: boolean, reason: "release" | "archive" | "delete" | "terminal" | "lru" = "release"): Promise<void> {
		const entry = this.get(identity);
		entry.reloadPending = false;
		const closing = entry.control.run(async () => {
			if (this.sessions.get(identity.sessionId) !== entry) throw new Error("会话已经释放");
			if (reason === "lru" && !entry.archived && this.sessions.size <= this.factory.options.residencyLimit) return;
			if (!stop && (this.busy(entry) || (reason === "lru" && entry.subscriptions.size > 0) || entry.recovery || entry.loading || entry.closing)) throw new Error("会话仍被使用，暂时不能释放");
			if (entry.recovery || entry.store.getPendingRestore()) throw new Error("会话恢复尚未完成，不能释放写入权限");
			if (entry.cleanupUnconfirmed) throw new Error(entry.cleanupUnconfirmed);
			entry.accepting = false; entry.state = "releasing"; this.publish(entry);
			if (entry.loading) await entry.loading;
			await this.stop(entry);
			await withDeadline(() => this.closeRuntime(entry, false), CLOSE_TIMEOUT_MS, "会话资源关闭");
			if (this.sessions.get(identity.sessionId) !== entry) throw new Error("会话代次发生改变");
			if (!existsSync(entry.options.sessionFile)) this.prepared.set(identity.sessionId, entry.manager);
			entry.state = "released"; entry.connection?.dispose(); this.factory.compat.removeHarnessScope(entry.resources!.scope);
			this.sessions.delete(identity.sessionId);
			entry.store.close();
			void this.transport.sendNotification(BackendSessionReleased, { ...identity, ownershipId: entry.options.ownershipId });
			this.publishProcess();
		});
		await withDeadline(closing, CLOSE_TIMEOUT_MS, "会话停止与资源关闭", () => { entry.accepting = false; entry.state = "protected"; entry.error = "所属停止与关闭操作尚未完成"; this.publish(entry); });
	}

	subscribe(identity: BackendIdentity, subscriptionId: string): Promise<BackendSessionSnapshot> { const entry = this.get(identity); return entry.control.run(async () => { if (this.sessions.get(identity.sessionId) !== entry || entry.state === "released") throw new Error("会话已经释放，需要重新打开"); entry.subscriptions.add(subscriptionId); this.publish(entry); return this.snapshot(entry); }); }
	unsubscribe(identity: BackendIdentity, subscriptionId: string): Promise<void> { const entry = this.get(identity); return entry.control.run(async () => { if (this.sessions.get(identity.sessionId) !== entry) return; entry.subscriptions.delete(subscriptionId); this.publish(entry); void this.trim().catch((error) => console.error(message(error))); }); }
	respondUi(identity: BackendIdentity & { runtimeGeneration: number; response: Parameters<BackendUiBridge["respond"]>[0] }): void { const entry = this.get(identity); if (entry.generation === identity.runtimeGeneration) entry.ui?.respond(identity.response); }
	protect(identity: BackendIdentity & { recovery: boolean; commits?: number; archived?: boolean; name?: string }): void { const entry = this.get(identity); entry.recovery = identity.recovery; if (identity.commits !== undefined) entry.commits = identity.commits; if (identity.archived !== undefined) entry.archived = identity.archived; if (identity.name !== undefined) entry.options = { ...entry.options, name: identity.name }; this.publish(entry); }

	getRecoveryContext(identity: BackendIdentity): { session: AgentSession; sessionManager: SessionManager; invalidate(): void; stopAndWait(): Promise<void>; control: OperationSequence } {
		const entry = this.get(identity);
		if (!entry.runtime) throw new Error("历史恢复需要已加载的会话运行时");
		return { session: entry.runtime.session, sessionManager: entry.manager, invalidate: () => { entry.recovery = true; entry.epoch++; entry.identities.clear(); if (entry.resources) entry.resources.scope.blocked = true; }, stopAndWait: () => this.stop(entry), control: entry.control };
	}

	private createRecovery(entry: Resident): RecoveryCoordinator {
		if (!entry.runtime || !entry.connection) throw new Error("会话恢复需要运行时与编辑器连接");
		return new RecoveryCoordinator(entry.store, {
			session: entry.runtime.session,
			reopen: (file) => this.factory.sdk.SessionManager.open(file, entry.options.sessionDir, entry.options.cwd),
			assertOwnership: () => { const owner = entry.store.latestOwnership(); if (owner?.state !== "running" || owner.ownershipId !== entry.options.ownershipId || owner.generationId !== entry.options.generationId) throw new Error("会话恢复的写入授权已失效"); },
			invalidate: () => { entry.recovery = true; entry.epoch++; entry.identities.clear(); entry.resources!.scope.blocked = true; },
			stopAndWait: () => this.stop(entry),
			files: {
				prepare: (params) => entry.connection!.sendRequest(FileRestorePrepare, params),
				apply: (params) => entry.connection!.sendRequest(FileRestoreApply, params),
				waitForIdle: () => entry.connection!.sendRequest(FileWaitForIdle, undefined),
			},
		});
	}

	async restore(identity: BackendIdentity, input: BackendRestoreInput): Promise<RestoreOperation> {
		const entry = this.get(identity);
		if (!entry.coordinator) throw new Error("会话恢复服务尚未初始化");
		if (entry.reloadPending || entry.loading || entry.closing) throw new Error("会话仍有资源控制操作");
		return entry.control.run(async () => {
			try { const result = await entry.coordinator!.restore({ ...input, sessionId: entry.options.sessionId, operationEpoch: entry.epoch, sourceLeaf: entry.manager.getLeafId() }); entry.recovery = result.stage !== "restored" && result.stage !== "completed"; this.publish(entry); return result; }
			catch (error) { entry.recovery = true; entry.state = "protected"; entry.error = message(error); this.publish(entry); throw error; }
		});
	}

	async resumeRecovery(identity: BackendIdentity): Promise<RestoreOperation | undefined> {
		const entry = this.get(identity);
		if (!entry.coordinator) throw new Error("会话恢复服务尚未初始化");
		return entry.control.run(async () => {
			try { const result = await entry.coordinator!.resume(); entry.recovery = result !== undefined && result.stage !== "restored" && result.stage !== "completed"; this.publish(entry); return result; }
			catch (error) { entry.recovery = true; entry.state = "protected"; entry.error = message(error); this.publish(entry); throw error; }
		});
	}

	pendingRecovery(identity: BackendIdentity & { sessionFile: string }): RestoreOperation | undefined {
		this.assertGeneration(identity);
		const entry = this.sessions.get(identity.sessionId);
		if (entry) return entry.store.getPendingRestore();
		const store = new OperationStore(identity.sessionFile);
		try { return store.getPendingRestore(); } finally { store.close(); }
	}

	markSubmitted(identity: BackendIdentity & { requestId: string; userEntryId: string }): void {
		const entry = this.get(identity);
		entry.coordinator?.markSubmitted(identity.requestId, identity.userEntryId);
		entry.recovery = false;
	}

	async catalog(params: { generationId: string; cwd: string; projectTrusted: boolean; refresh?: boolean; sessionId?: string }): Promise<BackendCatalogSnapshot> {
		this.assertGeneration(params);
		if (params.sessionId) { const entry = this.sessions.get(params.sessionId); if (entry?.runtime) return this.catalogFrom(entry.runtime.session, entry.resources!); }
		const protectedError = this.catalogProtected.get(params.cwd);
		if (protectedError) throw new Error(protectedError);
		if (params.refresh && !this.catalogLoading.has(params.cwd)) this.catalogs.delete(params.cwd);
		let pending = this.catalogs.get(params.cwd);
		if (!pending) {
			this.catalogLoading.add(params.cwd);
			let expired = false;
			const timeout = setTimeout(() => { expired = true; }, LOAD_TIMEOUT_MS);
			pending = this.factory.sequence.run(async () => {
				if (expired) throw new Error("目录加载等待已经超过期限");
				const manager = this.factory.sdk.SessionManager.inMemory(params.cwd);
				const resources = this.factory.create({ generationId: params.generationId, sessionId: manager.getSessionId(), cwd: params.cwd, sessionDir: "", sessionFile: "", ownershipId: "catalog", bridge: { path: "", token: "" }, projectTrusted: params.projectTrusted }, undefined, [], () => { throw new Error("目录查询不能调用编辑器工具"); }, () => undefined);
				let runtime: AgentSessionRuntime | undefined;
				const errors: string[] = [];
				let unsubscribe: (() => void) | undefined;
				try {
					const services = await resources.load(1);
					const scopedModels = await this.resolveSavedModelScope(services);
					runtime = await this.factory.sdk.createAgentSessionRuntime(async () => ({ ...await this.factory.sdk.createAgentSessionFromServices({ services, sessionManager: manager,
						model: scopedModels?.[0]?.model, thinkingLevel: scopedModels?.[0]?.thinkingLevel, scopedModels }), services, diagnostics: services.diagnostics }), { cwd: params.cwd, agentDir: services.agentDir, sessionManager: manager });
					unsubscribe = runtime.session.extensionRunner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));
					resources.checkDiagnostics();
					await this.factory.compat.runHarnessScope(resources.scope, () => runtime!.session.bindExtensions({ mode: "print", onError: (error) => errors.push(`${error.extensionPath}: ${error.error}`) }));
					resources.checkDiagnostics(); if (errors.length) throw new Error(errors.join("\n"));
					while (!resources.checkMcp()) { if (expired) throw new Error("目录加载已经超过期限"); await delay(25); }
					if (expired) throw new Error("目录加载已经超过期限");
					return await this.catalogFrom(runtime.session, resources);
				} finally {
					try {
						const beforeShutdown = errors.length;
						const services = resources.getServicesForCleanup();
						if (!runtime && services) runtime = await this.factory.sdk.createAgentSessionRuntime(async () => ({ ...await this.factory.sdk.createAgentSessionFromServices({ services, sessionManager: manager }), services, diagnostics: services.diagnostics }), { cwd: params.cwd, agentDir: services.agentDir, sessionManager: manager });
						if (runtime) {
							unsubscribe ??= runtime.session.extensionRunner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));
							await this.factory.compat.runHarnessScope(resources.scope, () => runtime!.dispose());
						}
						if (resources.initializationUnconfirmed) throw new Error("目录扩展工厂未完整返回，所属资源关闭无法确认");
						if (errors.length > beforeShutdown) throw new Error(errors.slice(beforeShutdown).join("\n"));
					} catch (error) { this.catalogProtected.set(params.cwd, message(error)); throw error; }
					finally { unsubscribe?.(); this.factory.compat.removeHarnessScope(resources.scope); }
				}
			}).finally(() => { clearTimeout(timeout); this.catalogLoading.delete(params.cwd); });
			this.catalogs.set(params.cwd, pending);
			void pending.catch(() => { if (this.catalogs.get(params.cwd) === pending) this.catalogs.delete(params.cwd); });
		}
		return withDeadline(pending, LOAD_TIMEOUT_MS, "资源目录查询");
	}

	private async resolveSavedModelScope(services: Pick<AgentSessionServices, "settingsManager" | "modelRuntime">): Promise<ScopedModel[] | undefined> {
		const patterns = services.settingsManager.getEnabledModels();
		if (!patterns?.length) return undefined;
		const { scopedModels, diagnostics } = await this.factory.sdk.resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) });
		if (scopedModels.length === 0) throw new Error(`Pi 已保存的 scoped-models 范围没有匹配到可用模型：${patterns.join(", ")}。请检查 enabledModels 和模型认证后刷新模型列表。`);
		for (const diagnostic of diagnostics) console.warn(`Pi scoped-models：${diagnostic.message}`);
		return scopedModels;
	}

	private async catalogFrom(session: AgentSession, resources: SessionResources): Promise<BackendCatalogSnapshot> {
		const scopedModels = await this.resolveSavedModelScope({ settingsManager: resources.original, modelRuntime: session.modelRuntime });
		const models = scopedModels?.map((item) => item.model) ?? session.modelRuntime.getAvailableSnapshot();
		const current = models.find((model) => model.provider === session.model?.provider && model.id === session.model.id);
		const selected = current ?? scopedModels?.[0]?.model;
		const thinking = current || !scopedModels ? session.thinkingLevel : scopedModels[0]?.thinkingLevel
			?? (selected ? resources.original.getModelThinkingLevel(selected.provider, selected.id) : undefined)
			?? resources.original.getDefaultThinkingLevel() ?? session.thinkingLevel;
		const levels: Record<string, RpcSessionState["thinkingLevel"][]> = {};
		for (const model of models) {
			// 目录查询对象没有持久历史；活动会话仅使用模型公开能力。
			if (session.sessionManager.isPersisted()) {
				levels[`${model.provider}/${model.id}`] = this.factory.thinkingLevels(model);
			} else { await session.setModel(model, { persist: false }); levels[`${model.provider}/${model.id}`] = session.getAvailableThinkingLevels(); }
		}
		if (!session.sessionManager.isPersisted() && selected) { await session.setModel(selected, { persist: false }); session.setThinkingLevel(thinking, { persist: false }); }
		return { cwd: resources.options.cwd, models, levels, defaultModel: selected ? `${selected.provider}/${selected.id}` : undefined, defaultThinking: thinking, skills: resources.skills() };
	}

	private trim(): Promise<void> {
		if (this.trimming) return this.trimming;
		const pending = this.trimOnce();
		this.trimming = pending;
		void pending.then(() => { this.trimming = undefined; }, () => { this.trimming = undefined; });
		return pending;
	}
	private async trimOnce(): Promise<void> {
		const candidates = [...this.sessions.values()].sort((a, b) => Number(b.archived) - Number(a.archived) || a.lastUsed - b.lastUsed);
		for (const entry of candidates) {
			if (this.sessions.size <= this.factory.options.residencyLimit && !entry.archived) continue;
			if (this.busy(entry) || entry.subscriptions.size || entry.recovery || entry.reloadPending || entry.loading || entry.closing || !entry.accepting) continue;
			await this.release(entry.options, false, "lru");
		}
	}

	async shutdown(deadline: number): Promise<void> {
		this.shutdownRequested = true;
		for (const timer of this.intervals) clearInterval(timer);
		await withDeadline(Promise.all([...this.sessions.values()].map((entry) => this.release(entry.options, true))), Math.max(1, deadline - Date.now()), "后台关闭");
	}
	private envelope(entry: Resident) { return { sessionId: entry.options.sessionId, generationId: entry.options.generationId, runtimeGeneration: entry.generation, sequence: ++entry.sequence, requestId: entry.identity?.rootRequestId, runId: entry.identity?.runId }; }
	private rpcState(session: AgentSession): RpcSessionState { return { model: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting, steeringMode: session.steeringMode, followUpMode: session.followUpMode, sessionFile: session.sessionFile, sessionId: session.sessionId, sessionName: session.sessionName, autoCompactionEnabled: session.autoCompactionEnabled, messageCount: session.messages.length, pendingMessageCount: session.pendingMessageCount }; }
	private snapshot(entry: Resident): BackendSessionSnapshot { const session = entry.runtime?.session; return { generationId: entry.options.generationId, sessionId: entry.options.sessionId, runtimeGeneration: entry.generation, sequence: entry.sequence, name: session?.sessionName ?? entry.options.name ?? entry.options.sessionId.slice(0, 8), cwd: entry.options.cwd, sessionFile: entry.options.sessionFile, state: (entry.ui?.count ?? 0) > 0 && entry.state === "running" ? "waiting" : entry.state, busy: this.busy(entry), subscriptions: entry.subscriptions.size, childTasks: this.childCount(entry), pendingInteractions: entry.ui?.count ?? 0, pendingCommits: entry.commits, reloadPending: entry.reloadPending, resourceOperation: entry.closing ? "closing" : entry.loading ? "loading" : undefined, error: entry.error ?? entry.mcpError, mcp: entry.resources?.mcpState, runId: entry.identity?.runId, requestId: entry.identity?.rootRequestId, messages: [...session?.messages ?? [], ...entry.partial ? [entry.partial] : []], rpcState: session ? this.rpcState(session) : undefined }; }
	private publish(entry: Resident): void { if (this.sessions.get(entry.options.sessionId) === entry) void this.transport.sendNotification(BackendSessionChanged, this.snapshot(entry)); }
	private publishProcess(): void {
		const cpu = process.cpuUsage(); const now = process.hrtime.bigint();
		const elapsed = Number(now - this.lastTime) / 1000;
		const cpuPercent = elapsed > 0 ? ((cpu.user - this.lastCpu.user + cpu.system - this.lastCpu.system) / elapsed / availableParallelism()) * 100 : 0;
		this.lastCpu = cpu; this.lastTime = now;
		void this.transport.sendNotification(BackendSnapshot, { generationId: this.factory.options.generationId, pid: process.pid, cpuPercent, rssBytes: process.memoryUsage.rss(), sessions: [...this.sessions.values()].map((entry) => this.snapshot(entry)) });
	}
}
