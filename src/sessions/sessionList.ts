import { basename } from "node:path";
import * as vscode from "vscode";
import type { PiHub } from "../session/hub";
import type { SessionRecord } from "./sessionCatalog";
import { sessionResource } from "./sessionUri";

const REFRESH_DELAY_MS = 300;
const NEW_SESSION_LABEL = "新的 Pi 会话";

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 把每个已打开工作区文件夹的 Pi 会话放入 VS Code 的会话列表，并在会话目录变化时刷新 */
export class SessionList implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined;
	private watchers: vscode.FileSystemWatcher[] = [];
	private watchedDirs = new Set<string>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly createdTimes = new Map<string, number>();
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;
	private disposed = false;

	constructor(
		private readonly hub: PiHub,
		private readonly controller: vscode.ChatSessionItemController,
	) {
		this.subscriptions = [
			hub.onDidChange(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
		];
	}

	scheduleRefresh(): void {
		if (this.disposed) return;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh().catch((error: unknown) => {
				this.hub.log(`刷新 Pi 会话列表失败：${error instanceof Error ? error.message : String(error)}`);
			});
		}, REFRESH_DELAY_MS);
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
		this.refreshing = this.refreshLoop().finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}

	private async refreshLoop(): Promise<void> {
		do { this.refreshAgain = false; await this.refreshItems(); } while (this.refreshAgain && !this.disposed);
	}

	private async refreshItems(): Promise<void> {
		const records = await this.hub.listSessions();
		if (this.disposed) return;
		const listed = new Set(records.map((record) => record.sessionId));
		const retained = new Set<string>();
		for (const record of records) {
			const item = this.recordItem(record);
			retained.add(item.resource.toString());
		}
		for (const pending of this.hub.pendingSessions()) {
			if (listed.has(pending.sessionId)) continue;
			const item = this.getItem(pending.sessionId, pending.label);
			this.createdTimes.set(pending.sessionId, pending.created);
			if (item.timing?.created !== pending.created) item.timing = { created: pending.created };
			if (item.status !== vscode.ChatSessionStatus.Completed) item.status = vscode.ChatSessionStatus.Completed;
			retained.add(item.resource.toString());
		}
		for (const location of this.hub.unsavedLocations()) {
			if (listed.has(location.sessionId) || retained.has(sessionResource(location.sessionId).toString())) {
				continue;
			}
			const item = this.getItem(location.sessionId, this.hub.title(location.sessionId) ?? NEW_SESSION_LABEL);
			const created = this.createdTimes.get(location.sessionId) ?? item.timing?.created ?? Date.now();
			this.createdTimes.set(location.sessionId, created);
			if (item.timing?.created !== created) item.timing = { created };
			const status = this.hub.existingSession(location.sessionId)?.isBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
			if (item.status !== status) item.status = status;
			retained.add(item.resource.toString());
		}
		for (const [resource] of this.controller.items) {
			if (!retained.has(resource.toString())) this.controller.items.delete(resource);
		}
		await this.watchSessionDirs();
	}

	private getItem(sessionId: string, label: string): vscode.ChatSessionItem {
		const resource = sessionResource(sessionId);
		let item = this.controller.items.get(resource);
		if (!item) { item = this.controller.createChatSessionItem(resource, label); this.controller.items.add(item); }
		if (item.label !== label) item.label = label;
		if (item.tooltip !== undefined) item.tooltip = undefined;
		return item;
	}

	private recordItem(record: SessionRecord): vscode.ChatSessionItem {
		const label = this.hub.title(record.sessionId) ?? record.name ?? (record.firstMessage.trim().length > 0 ? firstLine(record.firstMessage) : NEW_SESSION_LABEL);
		const item = this.getItem(record.sessionId, label);
		const created = record.created.getTime();
		const modified = record.modified.getTime();
		if (item.timing?.created !== created || item.timing?.lastRequestEnded !== modified) item.timing = { created, lastRequestEnded: modified };
		const archived = this.hub.isArchived(record.sessionId);
		if (item.archived !== archived) item.archived = archived;
		const session = this.hub.existingSession(record.sessionId);
		const status = session?.isBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		if (item.status !== status) item.status = status;
		const badge = this.hub.folders().length > 1 ? `$(folder) ${basename(record.cwd)}` : undefined;
		if (item.badge !== badge) item.badge = badge;
		if (item.metadata?.cwd !== record.cwd || item.metadata?.sessionFile !== record.sessionFile) item.metadata = { cwd: record.cwd, sessionFile: record.sessionFile };
		return item;
	}

	/** 监视各会话目录中的会话文件；目录不存在时不监视，也不创建 */
	private async watchSessionDirs(): Promise<void> {
		const catalog = await this.hub.sessionCatalog();
		const dirs = new Set<string>();
		for (const folder of this.hub.folders()) {
			dirs.add(await catalog.sessionDirFor(folder));
		}
		if (this.disposed) return;
		if (dirs.size === this.watchedDirs.size && [...dirs].every((dir) => this.watchedDirs.has(dir))) {
			return;
		}
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [...dirs].map((dir) => {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), "*.jsonl"));
			watcher.onDidCreate(() => this.scheduleRefresh());
			watcher.onDidChange(() => this.scheduleRefresh());
			watcher.onDidDelete(() => this.scheduleRefresh());
			return watcher;
		});
		this.watchedDirs = dirs;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
