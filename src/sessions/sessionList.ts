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

	async refresh(): Promise<void> {
		const records = await this.hub.listSessions();
		const items: vscode.ChatSessionItem[] = records.map((record) => this.recordItem(record));
		const listed = new Set(records.map((record) => record.sessionId));
		for (const pending of this.hub.pendingSessions()) {
			const item = this.controller.createChatSessionItem(sessionResource(pending.sessionId), pending.label);
			item.timing = { created: pending.created };
			item.status = vscode.ChatSessionStatus.Completed;
			items.push(item);
		}
		for (const location of this.hub.unsavedLocations()) {
			if (listed.has(location.sessionId)) {
				continue;
			}
			const item = this.controller.createChatSessionItem(sessionResource(location.sessionId), this.hub.title(location.sessionId) ?? NEW_SESSION_LABEL);
			item.timing = { created: Date.now() };
			item.status = this.hub.existingSession(location.sessionId)?.isBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
			items.push(item);
		}
		this.controller.items.replace(items);
		await this.watchSessionDirs();
	}

	private recordItem(record: SessionRecord): vscode.ChatSessionItem {
		const label = this.hub.title(record.sessionId) ?? record.name ?? (record.firstMessage.trim().length > 0 ? firstLine(record.firstMessage) : NEW_SESSION_LABEL);
		const item = this.controller.createChatSessionItem(sessionResource(record.sessionId), label);
		item.timing = { created: record.created.getTime(), lastRequestEnded: record.modified.getTime() };
		item.archived = this.hub.isArchived(record.sessionId);
		const session = this.hub.existingSession(record.sessionId);
		item.status = session?.isBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		item.tooltip = record.sessionFile;
		if (this.hub.folders().length > 1) {
			item.badge = `$(folder) ${basename(record.cwd)}`;
		}
		item.metadata = { cwd: record.cwd, sessionFile: record.sessionFile };
		return item;
	}

	/** 监视各会话目录中的会话文件；目录不存在时不监视，也不创建 */
	private async watchSessionDirs(): Promise<void> {
		const catalog = await this.hub.sessionCatalog();
		const dirs = new Set<string>();
		for (const folder of this.hub.folders()) {
			dirs.add(await catalog.sessionDirFor(folder));
		}
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
