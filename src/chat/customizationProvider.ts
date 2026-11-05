import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import type { FSWatcher } from "chokidar";
import * as vscode from "vscode";
import type { BackendSkill } from "../backend/protocol";
import { watchResource } from "./resourceWatcher";

export interface CustomizationHost {
	readonly onDidChange: vscode.Event<void>;
	readonly onDidDisposeResource: vscode.Event<vscode.Uri>;
	isResourceActive(resource: vscode.Uri): boolean;
	agentDir(): Promise<string>;
	skillsForResource(resource: vscode.Uri, token: vscode.CancellationToken): Promise<readonly BackendSkill[]>;
	cwdForResource(resource: vscode.Uri): Promise<string | undefined>;
	onResourceFilesChanged(resource: vscode.Uri): Promise<void>;
	logDiagnostic(message: string): void;
}
export interface SkillRequest { readonly prompt: string; readonly excludedReferenceIds: ReadonlySet<string>; }
interface SkillItem { readonly skill: BackendSkill; readonly item: vscode.ChatSessionCustomizationItem; }
interface ResourceWatcher { readonly watcher: FSWatcher; readonly resources: Set<string>; readonly ready: Promise<void>; readonly finishWaiting: () => void; error?: Error; }
const reserved = new Set(["compact", "reload", "settings", "model", "thinking", "export", "share", "resume", "new", "tree", "fork", "copy", "name", "session", "changelog", "hotkeys", "quit", "login", "logout"]);

function fileKey(uri: vscode.Uri): string { const path = normalize(uri.fsPath); return process.platform === "win32" ? path.toLowerCase() : path; }

export class PiCustomizationProvider implements vscode.ChatSessionCustomizationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly subscription: vscode.Disposable;
	private readonly resourceSubscription: vscode.Disposable;
	private readonly watchers = new Map<string, ResourceWatcher>();
	private readonly resourceWatchers = new Map<string, Set<string>>();
	private readonly changedResources = new Map<string, vscode.Uri>();
	private changeTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	constructor(private readonly host: CustomizationHost) {
		this.subscription = host.onDidChange(() => this.emitter.fire());
		this.resourceSubscription = host.onDidDisposeResource((resource) => {
			void this.releaseResource(resource).catch((error: unknown) => host.logDiagnostic(`释放 Pi 技能目录监视失败：${error instanceof Error ? error.message : String(error)}`));
		});
	}
	refresh(): void { this.emitter.fire(); }
	async provideChatSessionCustomizations(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		return (await this.items(resource, token)).map((entry) => entry.item);
	}
	async consumeSkillRequest(resource: vscode.Uri, request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<SkillRequest> {
		const references = request.references.filter((reference) => reference.id.startsWith("vscode.prompt.file__") && reference.value instanceof vscode.Uri);
		if (references.length === 0) return { prompt: request.prompt, excludedReferenceIds: new Set() };
		const available = await this.items(resource, token);
		const selected = references.flatMap((reference) => {
			const found = available.find((entry) => fileKey(entry.item.uri) === fileKey(reference.value as vscode.Uri));
			return found ? [{ reference, ...found }] : [];
		});
		if (selected.length === 0) return { prompt: request.prompt, excludedReferenceIds: new Set() };
		const unique = new Set(selected.map((entry) => fileKey(entry.item.uri)));
		if (unique.size !== 1) throw new Error("每条消息只能选择一个 Pi 技能命令");
		const chosen = selected[0];
		let args = request.prompt;
		for (const prefix of [`/${chosen.item.name}`, `/skill:${chosen.skill.name}`]) {
			if (args === prefix) { args = ""; break; }
			if (args.startsWith(`${prefix} `)) { args = args.slice(prefix.length).trimStart(); break; }
		}
		return { prompt: `/skill:${chosen.skill.name}${args.length > 0 ? ` ${args}` : ""}`, excludedReferenceIds: new Set(selected.map((entry) => entry.reference.id)) };
	}
	private async items(resource: vscode.Uri, token: vscode.CancellationToken): Promise<SkillItem[]> {
		const skills = await this.host.skillsForResource(resource, token);
		if (token.isCancellationRequested) throw new vscode.CancellationError();
		await this.watchResources(resource, skills);
		if (token.isCancellationRequested || this.disposed) throw new vscode.CancellationError();
		const names = new Map<string, number>();
		for (const skill of skills) names.set(skill.name, (names.get(skill.name) ?? 0) + 1);
		const uris = new Set<string>();
		return skills.map((skill) => {
			const uri = vscode.Uri.file(skill.filePath);
			const key = fileKey(uri);
			if (uris.has(key)) throw new Error(`Pi 技能 URI 重复：${skill.filePath}`);
			uris.add(key);
			let name = reserved.has(skill.name) ? `skill:${skill.name}` : skill.name;
			if ((names.get(skill.name) ?? 0) > 1) name = `skill:${skill.name}:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
			return { skill, item: { uri, name, type: vscode.ChatSessionCustomizationType.Skill, description: skill.description, source: skill.source === "project" || skill.source === "local" ? "local" : "user", userInvocable: true } };
		});
	}
	private async watchResources(resource: vscode.Uri, skills: readonly BackendSkill[]): Promise<void> {
		const cwd = await this.host.cwdForResource(resource);
		const agentDir = await this.host.agentDir();
		if (this.disposed || !this.host.isResourceActive(resource)) return;
		const paths = new Set<string>();
		paths.add(join(agentDir, "settings.json")); paths.add(join(agentDir, "skills"));
		paths.add(join(process.env.HOME || homedir(), ".agents", "skills"));
		if (cwd) {
			paths.add(join(cwd, ".pi", "settings.json")); paths.add(join(cwd, ".pi", "skills")); paths.add(join(cwd, ".agents", "skills"));
		}
		for (const skill of skills) {
			const parent = dirname(skill.filePath);
			paths.add(basename(skill.filePath).toLowerCase() === "skill.md" ? dirname(parent) : parent);
		}
		const resourceKey = resource.toString();
		const keys = new Set([...paths].map((path) => fileKey(vscode.Uri.file(path))));
		for (const key of this.resourceWatchers.get(resourceKey) ?? []) {
			if (keys.has(key)) continue;
			const entry = this.watchers.get(key);
			entry?.resources.delete(resourceKey);
			if (entry?.resources.size === 0) { this.watchers.delete(key); entry.finishWaiting(); await entry.watcher.close(); }
		}
		const ready: Promise<void>[] = [];
		for (const path of paths) {
			const key = fileKey(vscode.Uri.file(path));
			let entry = this.watchers.get(key);
			if (!entry) {
				const watcher = watchResource(path);
				let resolveReady!: () => void;
				let rejectReady!: (error: Error) => void;
				const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
				entry = { watcher, resources: new Set(), ready, finishWaiting: resolveReady };
				this.watchers.set(key, entry);
				const owned = entry;
				const changed = () => {
					for (const value of this.watchers.get(key)?.resources ?? []) this.changedResources.set(value, vscode.Uri.parse(value));
					this.scheduleFilesChanged();
				};
				watcher.on("all", changed);
				watcher.once("ready", resolveReady);
				watcher.on("error", (value) => {
					const error = value instanceof Error ? value : new Error(String(value));
					owned.error = error; rejectReady(error);
					this.host.logDiagnostic(`监视 Pi 技能目录失败：${path}：${error.message}`);
					this.emitter.fire();
				});
			}
			if (entry.error) throw entry.error;
			entry.resources.add(resourceKey);
			ready.push(entry.ready);
		}
		this.resourceWatchers.set(resourceKey, keys);
		await Promise.all(ready);
		if (!this.host.isResourceActive(resource)) await this.releaseResource(resource);
	}
	private async releaseResource(resource: vscode.Uri): Promise<void> {
		const key = resource.toString();
		const paths = this.resourceWatchers.get(key);
		this.resourceWatchers.delete(key); this.changedResources.delete(key);
		const closing: Promise<void>[] = [];
		for (const path of paths ?? []) {
			const entry = this.watchers.get(path);
			entry?.resources.delete(key);
			if (entry?.resources.size === 0) { this.watchers.delete(path); entry.finishWaiting(); closing.push(entry.watcher.close()); }
		}
		await Promise.all(closing);
	}
	private scheduleFilesChanged(): void {
		if (this.changeTimer || this.disposed) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			const resources = [...this.changedResources.values()]; this.changedResources.clear();
			void Promise.all(resources.map(async (resource) => {
				try { await this.host.onResourceFilesChanged(resource); }
				catch (error) { this.host.logDiagnostic(`更新 Pi 技能目录失败：${error instanceof Error ? error.message : String(error)}`); }
			})).then(() => { if (!this.disposed) this.emitter.fire(); });
		}, 250);
	}
	dispose(): void {
		this.disposed = true;
		if (this.changeTimer) clearTimeout(this.changeTimer);
		void Promise.all([...this.watchers.values()].map((entry) => { entry.finishWaiting(); return entry.watcher.close(); })).catch((error: unknown) => this.host.logDiagnostic(`关闭 Pi 技能目录监视失败：${error instanceof Error ? error.message : String(error)}`));
		this.watchers.clear(); this.resourceWatchers.clear(); this.changedResources.clear();
		this.subscription.dispose(); this.resourceSubscription.dispose(); this.emitter.dispose();
	}
}
