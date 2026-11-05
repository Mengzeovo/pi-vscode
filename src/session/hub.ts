import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { SnapshotStore } from "../edits/snapshotStore";
import { type CatalogSnapshot, ModelCatalog, modelKey, type PiModel, type ThinkingLevel } from "../pi/catalog";
import { loadPiRuntime, type PiRuntime } from "../pi/piRuntime";
import { SharedBackendClient } from "../pi/sharedBackend";
import type { BackendSkill } from "../backend/protocol";
import { SessionCatalog, type SessionRecord } from "../sessions/sessionCatalog";
import { isUntitledResource, parseSessionResource } from "../sessions/sessionUri";
import { PiSession, type SessionLocation } from "./piSession";

const ARCHIVED_KEY = "piHarness.archivedSessions";
const PARENT_KEY = "piHarness.parentSessions";
const TOUCHED_KEY = "piHarness.sessionFilesWithSnapshots";

export function folderKey(path: string): string {
	return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

export interface FolderDefaults {
	readonly model: string | undefined;
	readonly thinking: ThinkingLevel;
}

/** 全部工作区文件夹的模型合集；VS Code 按会话类型保存选项组，所有 Pi 会话使用同一份列表 */
export interface ModelChoices {
	readonly models: readonly PiModel[];
	readonly levels: ReadonlyMap<string, readonly ThinkingLevel[]>;
	/** folderKey → 该文件夹中 Pi 为新会话选择的模型和思考级别 */
	readonly defaults: ReadonlyMap<string, FolderDefaults>;
}

/** 新建后还没有发送第一条消息的会话；工作目录在第一条消息发送时确定 */
export interface PendingSession {
	readonly sessionId: string;
	readonly label: string;
	readonly created: number;
	readonly cwd?: string;
}

/** 扩展的全局状态：Pi 运行环境、会话位置、运行中的会话和每个工作区文件夹的模型列表进程 */
export class PiHub implements vscode.Disposable {
	private runtimePromise: Promise<PiRuntime> | undefined;
	private backendPromise: Promise<SharedBackendClient> | undefined;
	private loadedBackend: SharedBackendClient | undefined;
	private closing = false;
	private readonly backendChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeBackend = this.backendChanged.event;
	private readonly backendSubscriptions: Array<() => void> = [];
	private catalog: SessionCatalog | undefined;
	private readonly sessions = new Map<string, PiSession>();
	private readonly creatingSessions = new Map<string, Promise<PiSession>>();
	private readonly locations = new Map<string, SessionLocation>();
	private readonly pending = new Map<string, PendingSession>();
	private readonly modelCatalogs = new Map<string, ModelCatalog>();
	private choicesPromise: Promise<ModelChoices> | undefined;
	private stateUpdates: Promise<void> = Promise.resolve();
	private readonly titles = new Map<string, string>();
	private readonly shownEntries = new Map<string, Set<string>>();
	private readonly createdHere = new Set<string>();
	/** 本窗口新建的会话 ID，按创建顺序排列 */
	private readonly newSessionIds: string[] = [];
	private readonly inputStates = new Map<string, Set<vscode.ChatSessionInputState>>();
	private readonly stateResources = new Map<vscode.ChatSessionInputState, string>();
	private readonly inputSubscriptions = new Map<vscode.ChatSessionInputState, vscode.Disposable[]>();
	private readonly inputsChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeInputs = this.inputsChanged.event;
	private readonly inputResourceDisposed = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidDisposeInputResource = this.inputResourceDisposed.event;
	readonly snapshots: SnapshotStore;
	private readonly changed = new vscode.EventEmitter<string | undefined>();
	/** 会话列表或某个会话的标题、状态变化；参数为会话 ID，undefined 表示整个列表 */
	readonly onDidChange = this.changed.event;
	private readonly choicesChanged = new vscode.EventEmitter<void>();
	/** 模型合集重新读取之后触发 */
	readonly onDidChangeChoices = this.choicesChanged.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {
		this.snapshots = new SnapshotStore(context.globalStorageUri.fsPath);
	}

	log(line: string): void {
		if (this.closing) {
			console.log(`[Pi Harness] ${line}`);
			return;
		}
		this.output.appendLine(line);
	}

	get piExtensionPath(): string {
		return join(this.context.extensionPath, "dist", "pi-extension", "index.js");
	}

	runtime(): Promise<PiRuntime> {
		if (!this.runtimePromise) {
			const configured = vscode.workspace.getConfiguration("piHarness").get<string>("piPackagePath", "");
			this.runtimePromise = loadPiRuntime(configured).then(
				(runtime) => {
					this.log(`Pi ${runtime.version}：${runtime.packageDir}；node ${runtime.nodeVersion}：${runtime.nodeExecutable}`);
					return runtime;
				},
				(error: unknown) => {
					this.log(`加载 Pi 失败：${error instanceof Error ? error.message : String(error)}`);
					// 下次使用时重新定位，用户可以在修改设置或安装 Pi 之后重试
					this.runtimePromise = undefined;
					throw error;
				},
			);
		}
		return this.runtimePromise;
	}

	async sessionCatalog(): Promise<SessionCatalog> {
		if (!this.catalog) {
			this.catalog = new SessionCatalog(await this.runtime());
		}
		return this.catalog;
	}

	backend(): Promise<SharedBackendClient> {
		if (this.closing) return Promise.reject(new Error("Pi 窗口正在关闭"));
		this.backendPromise ??= this.runtime().then((runtime) => {
			if (this.closing) throw new Error("Pi 窗口已经停止创建后台");
			const backend = new SharedBackendClient({
				runtime, extensionPath: this.context.extensionPath, log: (message) => this.log(message),
				residencyLimit: () => vscode.workspace.getConfiguration("piHarness").get<number>("sessionResidencyLimit", 10),
			});
			this.loadedBackend = backend;
			this.backendSubscriptions.push(backend.onChanged(() => this.backendChanged.fire()));
			this.backendSubscriptions.push(backend.onCatalogChanged((cwd) => {
				this.modelCatalogs.get(folderKey(cwd))?.invalidate();
				this.choicesPromise = undefined;
				this.choicesChanged.fire();
				this.inputsChanged.fire();
			}));
			return backend;
		}).catch((error: unknown) => { this.backendPromise = undefined; throw error; });
		return this.backendPromise;
	}

	get backendStatus(): SharedBackendClient | undefined { return this.loadedBackend; }

	async skillsForResource(resource: vscode.Uri): Promise<readonly BackendSkill[]> {
		if (!vscode.workspace.isTrusted) return [];
		const sessionId = isUntitledResource(resource) ? undefined : parseSessionResource(resource);
		const cwd = await this.cwdForResource(resource);
		if (cwd === undefined) throw new Error("Pi 技能菜单需要一个工作目录");
		if (!this.isWorkspaceFolder(cwd)) throw new Error("Pi 技能目录必须属于当前工作区");
		return (await (await this.backend()).catalog(cwd, true, false, this.sessions.get(sessionId ?? "")?.isRunning ? sessionId : undefined)).skills;
	}

	async cwdForResource(resource: vscode.Uri): Promise<string | undefined> {
		const sessionId = isUntitledResource(resource) ? undefined : parseSessionResource(resource);
		const location = sessionId === undefined ? undefined : await this.locate(sessionId);
		return location?.cwd ?? (sessionId === undefined ? undefined : this.pending.get(sessionId)?.cwd) ?? this.draftFolder(resource);
	}

	async resourceFilesChanged(resource: vscode.Uri): Promise<void> {
		const cwd = await this.cwdForResource(resource);
		if (cwd === undefined || !vscode.workspace.isTrusted) return;
		const sessionId = isUntitledResource(resource) ? undefined : parseSessionResource(resource);
		if (!sessionId || !this.sessions.get(sessionId)?.isRunning) {
			await this.modelCatalog(cwd).refresh();
			this.choicesPromise = undefined;
			this.choicesChanged.fire();
		}
		this.inputsChanged.fire();
	}

	/** 已打开的本地工作区文件夹 */
	folders(): string[] {
		return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
	}

	isWorkspaceFolder(cwd: string): boolean {
		const key = folderKey(cwd);
		return this.folders().some((folder) => folderKey(folder) === key);
	}

	async listSessions(): Promise<SessionRecord[]> {
		const catalog = await this.sessionCatalog();
		const records: SessionRecord[] = [];
		for (const folder of this.folders()) {
			for (const record of await catalog.listFolder(folder)) {
				records.push(record);
				const known = this.locations.get(record.sessionId);
				if (known) {
					known.sessionFile = record.sessionFile;
				} else {
					this.locations.set(record.sessionId, { sessionId: record.sessionId, cwd: record.cwd, sessionDir: record.sessionDir, sessionFile: record.sessionFile });
				}
			}
		}
		return records;
	}

	/** 本窗口中已开始、Pi 还没有写入会话文件的会话 */
	unsavedLocations(): SessionLocation[] {
		return [...this.locations.values()].filter((location) => location.sessionFile === undefined || !existsSync(location.sessionFile));
	}

	addPending(session: PendingSession): void {
		this.pending.set(session.sessionId, session);
		this.createdHere.add(session.sessionId);
		this.newSessionIds.push(session.sessionId);
	}

	createdSessionIds(): readonly string[] {
		return [...this.newSessionIds];
	}

	pendingSession(sessionId: string): PendingSession | undefined {
		return this.pending.get(sessionId);
	}

	pendingSessions(): PendingSession[] {
		return [...this.pending.values()];
	}

	trackInputState(resource: vscode.Uri, state: vscode.ChatSessionInputState): void {
		const key = resource.toString();
		const previous = this.stateResources.get(state);
		if (previous === key) {
			return;
		}
		if (previous !== undefined) {
			this.removeInputState(previous, state);
		}
		this.stateResources.set(state, key);
		const states = this.inputStates.get(key) ?? new Set<vscode.ChatSessionInputState>();
		states.add(state);
		this.inputStates.set(key, states);
		if (!this.inputSubscriptions.has(state)) {
			this.inputSubscriptions.set(state, [
				state.onDidChange(() => this.inputsChanged.fire()),
				state.onDidDispose(() => {
					const current = this.stateResources.get(state);
					if (current !== undefined) {
						this.removeInputState(current, state);
					}
					this.stateResources.delete(state);
					for (const subscription of this.inputSubscriptions.get(state) ?? []) {
						subscription.dispose();
					}
					this.inputSubscriptions.delete(state);
					this.inputsChanged.fire();
				}),
			]);
		}
		if (!isUntitledResource(resource)) {
			this.sessions.get(parseSessionResource(resource))?.markContentReleased(false);
		}
		this.inputsChanged.fire();
	}

	private removeInputState(resource: string, state: vscode.ChatSessionInputState): void {
		const states = this.inputStates.get(resource);
		states?.delete(state);
		if (states?.size === 0) {
			this.inputStates.delete(resource);
			setImmediate(() => { if (!this.inputStates.has(resource)) this.inputResourceDisposed.fire(vscode.Uri.parse(resource)); });
			const uri = vscode.Uri.parse(resource);
			if (!isUntitledResource(uri)) {
				this.sessions.get(parseSessionResource(uri))?.markContentReleased(true);
			}
		}
	}

	isInputResourceActive(resource: vscode.Uri): boolean { return this.inputStates.has(resource.toString()); }

	draftFolder(resource: vscode.Uri): string | undefined {
		const states = this.inputStates.get(resource.toString());
		const current = states === undefined ? undefined : [...states].at(-1);
		const selected = current?.groups.find((group) => group.id === "folder")?.selected?.id;
		return selected ?? (this.folders().length === 1 ? this.folders()[0] : undefined);
	}

	inputSubscriptionCount(sessionId: string): number {
		let count = 0;
		for (const [key, states] of this.inputStates) {
			const resource = vscode.Uri.parse(key);
			if (!isUntitledResource(resource) && parseSessionResource(resource) === sessionId) {
				count += states.size;
			}
		}
		return count;
	}

	async locate(sessionId: string): Promise<SessionLocation | undefined> {
		const known = this.locations.get(sessionId);
		if (known) {
			return known;
		}
		if (this.pending.has(sessionId)) {
			return undefined;
		}
		const catalog = await this.sessionCatalog();
		const record = await catalog.find(sessionId, this.folders());
		if (!record) {
			return undefined;
		}
		const location: SessionLocation = { sessionId: record.sessionId, cwd: record.cwd, sessionDir: record.sessionDir, sessionFile: record.sessionFile };
		this.locations.set(sessionId, location);
		return location;
	}

	/** 确定新会话的工作目录和会话目录；第一条消息发送时调用 */
	async allocate(cwd: string, sessionId: string): Promise<SessionLocation> {
		const catalog = await this.sessionCatalog();
		const location: SessionLocation = { sessionId, cwd, sessionDir: await catalog.sessionDirFor(cwd), sessionFile: undefined };
		this.locations.set(sessionId, location);
		this.pending.delete(sessionId);
		this.createdHere.add(sessionId);
		return location;
	}

	register(location: SessionLocation): void {
		this.locations.set(location.sessionId, location);
	}

	/** 本窗口创建的会话（新建或分叉），首次写入时不需要确认其他写入方 */
	markCreatedHere(sessionId: string): void {
		this.createdHere.add(sessionId);
	}

	existingSession(sessionId: string): PiSession | undefined {
		return this.sessions.get(sessionId);
	}

	session(location: SessionLocation): Promise<PiSession> {
		const existing = this.sessions.get(location.sessionId);
		if (existing) {
			return Promise.resolve(existing);
		}
		let pending = this.creatingSessions.get(location.sessionId);
		if (!pending) {
			pending = this.createSession(location);
			this.creatingSessions.set(location.sessionId, pending);
			void pending.then(() => this.creatingSessions.delete(location.sessionId), () => this.creatingSessions.delete(location.sessionId));
		}
		return pending;
	}

	private async createSession(location: SessionLocation): Promise<PiSession> {
		const runtime = await this.runtime();
		const backend = await this.backend();
		const session = new PiSession(
			location,
			{
				runtime,
				backend,
				piExtensionPath: this.piExtensionPath,
				snapshots: this.snapshots,
				log: (line) => this.log(line),
				onTitle: (sessionId, title) => {
					this.titles.set(sessionId, title);
					this.changed.fire(sessionId);
				},
				onReleased: (sessionId) => this.changed.fire(sessionId),
				onSessionFile: (updated) => {
					void this.rememberSnapshotSession(updated.sessionFile);
					this.changed.fire(updated.sessionId);
				},
				hasSubscriptions: () => this.inputSubscriptionCount(location.sessionId) > 0,
			},
			this.createdHere.has(location.sessionId),
		);
		this.sessions.set(location.sessionId, session);
		return session;
	}

	title(sessionId: string): string | undefined {
		return this.titles.get(sessionId);
	}

	setTitle(sessionId: string, title: string): void {
		this.titles.set(sessionId, title);
	}

	/** 记录本窗口向 VS Code 显示过的用户消息条目；只有这些请求可能被 VS Code 的编辑请求移除 */
	markShown(sessionId: string, userEntryIds: Iterable<string>): void {
		const shown = this.shownEntries.get(sessionId) ?? new Set<string>();
		for (const id of userEntryIds) {
			shown.add(id);
		}
		this.shownEntries.set(sessionId, shown);
	}

	shownEntryIds(sessionId: string): ReadonlySet<string> {
		return this.shownEntries.get(sessionId) ?? new Set();
	}

	private modelCatalog(cwd: string): ModelCatalog {
		const key = folderKey(cwd);
		let catalog = this.modelCatalogs.get(key);
		if (!catalog) {
			const created = new ModelCatalog(() => this.backend(), cwd, () => vscode.workspace.isTrusted);
			this.modelCatalogs.set(key, created);
			catalog = created;
		}
		return catalog;
	}

	/** 全部工作区文件夹的模型合集；工作区未受信任或没有文件夹时报告原因。读取失败的结果不保留，下次使用时重新读取 */
	modelChoices(): Promise<ModelChoices> {
		if (!this.choicesPromise) {
			const building: Promise<ModelChoices> = this.buildChoices().catch((error: unknown) => {
				if (this.choicesPromise === building) {
					this.choicesPromise = undefined;
				}
				throw error;
			});
			this.choicesPromise = building;
		}
		return this.choicesPromise;
	}

	private async buildChoices(): Promise<ModelChoices> {
		if (!vscode.workspace.isTrusted) {
			throw new Error("工作区未受信任，不启动 Pi");
		}
		const folders = this.folders();
		if (folders.length === 0) {
			throw new Error("没有打开的本地文件夹");
		}
		await this.runtime();
		const snapshots: Array<[string, CatalogSnapshot]> = [];
		for (const folder of folders) {
			snapshots.push([folder, await this.modelCatalog(folder).snapshot()]);
		}
		const models: PiModel[] = [];
		const levels = new Map<string, readonly ThinkingLevel[]>();
		const defaults = new Map<string, FolderDefaults>();
		for (const [folder, snapshot] of snapshots) {
			for (const model of snapshot.models) {
				const key = modelKey(model);
				if (!levels.has(key)) {
					models.push(model);
					levels.set(key, snapshot.levels.get(key) ?? ["off"]);
				}
			}
			defaults.set(folderKey(folder), { model: snapshot.defaultModel, thinking: snapshot.defaultThinking });
		}
		if (models.length === 0) {
			throw new Error("Pi 没有可用的模型，请先在终端中运行 pi 完成登录或配置模型");
		}
		return { models, levels, defaults };
	}

	/** 重新读取工作区模型资源，并通知输入区更新。 */
	async refreshChoices(): Promise<void> {
		this.choicesPromise = undefined;
		const keep = new Set(this.folders().map(folderKey));
		for (const [key, catalog] of this.modelCatalogs) {
			if (!keep.has(key)) {
				this.modelCatalogs.delete(key);
			}
			await catalog.refresh();
		}
		this.choicesChanged.fire();
	}

	isArchived(sessionId: string): boolean {
		return this.context.globalState.get<string[]>(ARCHIVED_KEY, []).includes(sessionId);
	}

	private updateState(work: () => PromiseLike<void>): Promise<void> {
		const operation = this.stateUpdates.then(work);
		this.stateUpdates = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async setArchived(sessionId: string, archived: boolean): Promise<void> {
		if (this.isArchived(sessionId) === archived) return;
		const location = await this.locate(sessionId);
		if (!location) throw new Error(`没有找到 Pi 会话 ${sessionId}`);
		await (await this.session(location)).setArchived(archived);
		await this.updateState(() => {
			const current = new Set(this.context.globalState.get<string[]>(ARCHIVED_KEY, []));
			if (archived) current.add(sessionId);
			else current.delete(sessionId);
			return this.context.globalState.update(ARCHIVED_KEY, [...current]);
		});
	}

	parentOf(sessionId: string): string | undefined {
		return this.context.globalState.get<Record<string, string>>(PARENT_KEY, {})[sessionId];
	}

	async setParent(sessionId: string, parentSessionFile: string): Promise<void> {
		await this.updateState(() => {
			const parents = { ...this.context.globalState.get<Record<string, string>>(PARENT_KEY, {}) };
			parents[sessionId] = parentSessionFile;
			return this.context.globalState.update(PARENT_KEY, parents);
		});
	}

	/** 记录写入过快照的会话文件，清理快照时扫描这些文件 */
	async rememberSnapshotSession(sessionFile: string | undefined): Promise<void> {
		if (sessionFile === undefined) {
			return;
		}
		await this.updateState(async () => {
			const files = new Set(this.context.globalState.get<string[]>(TOUCHED_KEY, []));
			if (!files.has(sessionFile)) {
				files.add(sessionFile);
				await this.context.globalState.update(TOUCHED_KEY, [...files]);
			}
		});
	}

	snapshotSessionFiles(): string[] {
		return this.context.globalState.get<string[]>(TOUCHED_KEY, []);
	}

	async forgetSnapshotSessions(files: readonly string[]): Promise<void> {
		const remove = new Set(files);
		await this.updateState(() => this.context.globalState.update(
			TOUCHED_KEY, this.snapshotSessionFiles().filter((file) => !remove.has(file)),
		));
	}

	forget(sessionId: string): void {
		this.sessions.get(sessionId)?.dispose();
		this.sessions.delete(sessionId);
		this.locations.delete(sessionId);
		this.pending.delete(sessionId);
		this.titles.delete(sessionId);
	}

	notifyChanged(sessionId?: string): void {
		this.changed.fire(sessionId);
	}

	allSessions(): PiSession[] {
		return [...this.sessions.values()];
	}

	async deactivate(): Promise<void> {
		this.closing = true;
		const deadline = Date.now() + 4_000;
		await this.loadedBackend?.shutdown(deadline);
		this.modelCatalogs.clear();
	}

	dispose(): void {
		this.closing = true;
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.changed.dispose();
		this.choicesChanged.dispose();
		this.backendChanged.dispose();
		for (const unsubscribe of this.backendSubscriptions) unsubscribe();
		this.inputsChanged.dispose();
		this.inputResourceDisposed.dispose();
		for (const subscriptions of this.inputSubscriptions.values()) {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		}
		this.inputSubscriptions.clear();
		this.inputStates.clear();
		this.stateResources.clear();
	}
}
