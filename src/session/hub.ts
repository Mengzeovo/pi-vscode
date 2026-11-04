import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { SnapshotStore } from "../edits/snapshotStore";
import { type CatalogSnapshot, ModelCatalog, modelKey, type PiModel, type ThinkingLevel } from "../pi/catalog";
import { loadPiRuntime, type PiRuntime } from "../pi/piRuntime";
import { SessionCatalog, type SessionRecord } from "../sessions/sessionCatalog";
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
}

/** 扩展的全局状态：Pi 运行环境、会话位置、运行中的会话和每个工作区文件夹的模型列表进程 */
export class PiHub implements vscode.Disposable {
	private runtimePromise: Promise<PiRuntime> | undefined;
	private catalog: SessionCatalog | undefined;
	private readonly sessions = new Map<string, PiSession>();
	private readonly locations = new Map<string, SessionLocation>();
	private readonly pending = new Map<string, PendingSession>();
	private readonly modelCatalogs = new Map<string, ModelCatalog>();
	private choicesPromise: Promise<ModelChoices> | undefined;
	private readonly titles = new Map<string, string>();
	private readonly shownEntries = new Map<string, Set<string>>();
	private readonly createdHere = new Set<string>();
	/** 本窗口新建的会话 ID，按创建顺序排列 */
	private readonly newSessionIds: string[] = [];
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

	async session(location: SessionLocation): Promise<PiSession> {
		const existing = this.sessions.get(location.sessionId);
		if (existing) {
			return existing;
		}
		const runtime = await this.runtime();
		const session = new PiSession(
			location,
			{
				runtime,
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
				idleShutdownMs: () => vscode.workspace.getConfiguration("piHarness").get<number>("idleShutdownMinutes", 10) * 60_000,
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
			const created = new ModelCatalog(this.runtimeSync(), cwd, (line) => this.log(line));
			this.modelCatalogs.set(key, created);
			catalog = created;
		}
		return catalog;
	}

	private loadedRuntime: PiRuntime | undefined;

	private runtimeSync(): PiRuntime {
		if (!this.loadedRuntime) {
			throw new Error("Pi 运行环境尚未加载");
		}
		return this.loadedRuntime;
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
		this.loadedRuntime = await this.runtime();
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

	/** 重新读取模型列表：结束模型列表进程，关闭已移除文件夹的进程，然后通知输入区更新 */
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

	async setArchived(sessionId: string, archived: boolean): Promise<void> {
		const current = new Set(this.context.globalState.get<string[]>(ARCHIVED_KEY, []));
		if (archived) {
			current.add(sessionId);
		} else {
			current.delete(sessionId);
		}
		await this.context.globalState.update(ARCHIVED_KEY, [...current]);
	}

	parentOf(sessionId: string): string | undefined {
		return this.context.globalState.get<Record<string, string>>(PARENT_KEY, {})[sessionId];
	}

	async setParent(sessionId: string, parentSessionFile: string): Promise<void> {
		const parents = { ...this.context.globalState.get<Record<string, string>>(PARENT_KEY, {}) };
		parents[sessionId] = parentSessionFile;
		await this.context.globalState.update(PARENT_KEY, parents);
	}

	/** 记录写入过快照的会话文件，清理快照时扫描这些文件 */
	async rememberSnapshotSession(sessionFile: string | undefined): Promise<void> {
		if (sessionFile === undefined) {
			return;
		}
		const files = new Set(this.context.globalState.get<string[]>(TOUCHED_KEY, []));
		if (!files.has(sessionFile)) {
			files.add(sessionFile);
			await this.context.globalState.update(TOUCHED_KEY, [...files]);
		}
	}

	snapshotSessionFiles(): string[] {
		return this.context.globalState.get<string[]>(TOUCHED_KEY, []);
	}

	async forgetSnapshotSessions(files: readonly string[]): Promise<void> {
		const remove = new Set(files);
		await this.context.globalState.update(
			TOUCHED_KEY,
			this.snapshotSessionFiles().filter((file) => !remove.has(file)),
		);
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
		await Promise.all([...this.sessions.values()].map((session) => session.deactivate()));
		await Promise.all([...this.modelCatalogs.values()].map((catalog) => catalog.dispose()));
		this.modelCatalogs.clear();
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.changed.dispose();
		this.choicesChanged.dispose();
	}
}
