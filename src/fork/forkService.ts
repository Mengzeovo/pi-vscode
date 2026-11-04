import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import { EDIT_ENTRY_TYPE, type EditEntryData, type ReferenceRecord, REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import { userMessageText } from "../chat/historyRenderer";
import { sha256 } from "../edits/snapshotStore";
import type { PiHub } from "../session/hub";
import type { SessionLocation } from "../session/piSession";
import { parseSessionResource, sessionResource } from "../sessions/sessionUri";

interface FileRestore {
	readonly path: string;
	/** 分叉点之后第一次修改前的内容；null 表示文件由 Pi 新建 */
	readonly beforeHash: string | null;
	/** Pi 最后一次写入后的内容 */
	readonly lastAfterHash: string;
}

interface RestorePlan {
	readonly files: readonly FileRestore[];
	/** 分叉点及之后在终端中执行、没有修改记录的轮次 */
	readonly unrecordedTurns: readonly string[];
}

class ForkCancelled extends vscode.CancellationError {}

/** `workbench.action.chat.open` 的 attachFiles 使用的范围格式（行列从 1 开始） */
interface EditorRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

/** 分叉点请求的原文和附件 */
interface ForkPointPrompt {
	readonly prompt: string;
	readonly references: readonly ReferenceRecord[];
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

function planRestore(branch: readonly SessionEntry[], forkIndex: number): RestorePlan {
	const requestEntries = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE) {
			requestEntries.add((entry.data as RequestEntryData).userEntryId);
		}
	}
	const files = new Map<string, { beforeHash: string | null; lastAfterHash: string; path: string }>();
	const unrecordedTurns: string[] = [];
	for (let index = forkIndex; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user" && !requestEntries.has(entry.id)) {
			unrecordedTurns.push(userMessageText(entry.message.content).slice(0, 80));
		}
		if (entry.type === "custom" && entry.customType === EDIT_ENTRY_TYPE) {
			const data = entry.data as EditEntryData;
			const key = process.platform === "win32" ? resolve(data.path).toLowerCase() : resolve(data.path);
			const existing = files.get(key);
			if (existing) {
				existing.lastAfterHash = data.afterHash;
			} else {
				files.set(key, { path: data.path, beforeHash: data.beforeHash, lastAfterHash: data.afterHash });
			}
		}
	}
	return { files: [...files.values()], unrecordedTurns };
}

async function currentHash(path: string): Promise<string | null> {
	return existsSync(path) ? sha256(await readFile(path)) : null;
}

/** Pi 会话的分叉：可选把 Pi 修改过的文件恢复到分叉点之前，并提供把原请求填回输入框的通知 */
export class ForkService {
	constructor(
		private readonly hub: PiHub,
		private readonly controller: vscode.ChatSessionItemController,
	) {}

	async fork(resource: vscode.Uri, request: vscode.ChatRequestTurn2 | undefined): Promise<vscode.ChatSessionItem> {
		const sessionId = parseSessionResource(resource);
		const location = await this.hub.locate(sessionId);
		if (!location || location.sessionFile === undefined || !existsSync(location.sessionFile)) {
			throw new Error("这个 Pi 会话还没有保存的消息，不能分叉");
		}
		const session = await this.hub.session(location);
		if (session.isBusy) {
			throw new Error("Pi 正在运行本轮任务，请在本轮结束后再分叉");
		}
		const sourceFile = location.sessionFile;
		return session.editFile(() => this.forkLocked(location, sourceFile, session.requestEntries, request));
	}

	private async forkLocked(location: SessionLocation, sourceFile: string, live: ReadonlyMap<string, string>, request: vscode.ChatRequestTurn2 | undefined): Promise<vscode.ChatSessionItem> {
		const runtime = await this.hub.runtime();
		const manager = runtime.modules.SessionManager.open(sourceFile, location.sessionDir);
		const branch = manager.getBranch();
		let targetLeafId: string | null;
		let restore: RestorePlan | undefined;
		let forkPoint: ForkPointPrompt | undefined;
		if (request) {
			const entryId = this.resolveEntryId(request, branch, live);
			const forkIndex = branch.findIndex((entry) => entry.id === entryId);
			const entry = branch[forkIndex];
			if (entry === undefined || entry.type !== "message" || entry.message.role !== "user") {
				throw new Error("这条请求在 Pi 会话的当前分支中没有对应的用户消息，不能作为分叉点");
			}
			targetLeafId = entry.parentId;
			restore = planRestore(branch, forkIndex);
			const record = branch
				.filter((candidate) => candidate.type === "custom" && candidate.customType === REQUEST_ENTRY_TYPE)
				.map((candidate) => (candidate as { data: RequestEntryData }).data)
				.find((data) => data.userEntryId === entryId);
			forkPoint = record ? { prompt: record.userText, references: record.references } : { prompt: userMessageText(entry.message.content), references: [] };
		} else {
			targetLeafId = manager.getLeafId();
		}
		const restoreFiles = restore ? await this.confirmRestore(restore) : [];
		let forked: SessionLocation;
		if (targetLeafId === null) {
			forked = await this.hub.allocate(location.cwd, randomUUID());
			await this.hub.setParent(forked.sessionId, sourceFile);
		} else {
			const forkedFile = manager.createBranchedSession(targetLeafId);
			if (forkedFile === undefined) {
				throw new Error("Pi 没有创建分叉会话文件");
			}
			forked = { sessionId: manager.getSessionId(), cwd: location.cwd, sessionDir: location.sessionDir, sessionFile: existsSync(forkedFile) ? forkedFile : undefined };
			if (forked.sessionFile === undefined) {
				await this.hub.setParent(forked.sessionId, sourceFile);
			} else {
				await this.hub.rememberSnapshotSession(forked.sessionFile);
			}
			this.hub.register(forked);
		}
		this.hub.markCreatedHere(forked.sessionId);
		await this.restoreFiles(restoreFiles);
		const label = `分叉：${request ? request.prompt.slice(0, 40) : "完整会话"}`;
		const item = this.controller.createChatSessionItem(sessionResource(forked.sessionId), label);
		item.timing = { created: Date.now() };
		item.iconPath = new vscode.ThemeIcon("repo-forked");
		this.controller.items.add(item);
		if (forkPoint) {
			void this.offerPromptRestore(forkPoint.prompt, forkPoint.references);
		}
		return item;
	}

	private resolveEntryId(request: vscode.ChatRequestTurn2, branch: readonly SessionEntry[], live: ReadonlyMap<string, string>): string {
		if (request.id === undefined) {
			throw new Error("分叉点请求没有 ID");
		}
		if (branch.some((entry) => entry.id === request.id && entry.type === "message" && entry.message.role === "user")) {
			return request.id;
		}
		const mapped = live.get(request.id);
		if (mapped !== undefined) {
			return mapped;
		}
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE && (entry.data as RequestEntryData).requestId === request.id) {
				return (entry.data as RequestEntryData).userEntryId;
			}
		}
		throw new Error("这条请求没有对应的 Pi 会话条目，不能作为分叉点");
	}

	/** 返回需要恢复的文件；用户取消时抛出取消错误 */
	private async confirmRestore(plan: RestorePlan): Promise<readonly FileRestore[]> {
		if (plan.files.length === 0 && plan.unrecordedTurns.length === 0) {
			return [];
		}
		const dirty = plan.files.filter((file) => vscode.workspace.textDocuments.some((document) => document.isDirty && document.uri.scheme === "file" && samePath(document.uri.fsPath, file.path)));
		const details: string[] = [];
		if (plan.files.length > 0) {
			details.push(`Pi 在分叉点之后修改过这些文件：\n${plan.files.map((file) => `  ${file.path}${file.beforeHash === null ? "（由 Pi 新建，恢复时删除）" : ""}`).join("\n")}`);
		}
		if (plan.unrecordedTurns.length > 0) {
			details.push(`以下轮次是在终端中执行的，它们的文件修改无法恢复：\n${plan.unrecordedTurns.map((text) => `  ${text}`).join("\n")}`);
		}
		details.push("Pi 通过 bash 等命令造成的修改不在恢复范围内。");
		const actions = dirty.length === 0 && plan.files.length > 0 ? ["恢复文件并分叉", "只分叉"] : ["只分叉"];
		if (dirty.length > 0) {
			details.push(`这些文件有未保存的修改，不能恢复：\n${dirty.map((file) => `  ${file.path}`).join("\n")}`);
		}
		const choice = await vscode.window.showWarningMessage("从这条请求之前分叉 Pi 会话", { modal: true, detail: details.join("\n\n") }, ...actions);
		if (choice === undefined) {
			throw new ForkCancelled();
		}
		if (choice !== "恢复文件并分叉") {
			return [];
		}
		const unchanged: FileRestore[] = [];
		const changed: FileRestore[] = [];
		for (const file of plan.files) {
			((await currentHash(file.path)) === file.lastAfterHash ? unchanged : changed).push(file);
		}
		if (changed.length === 0) {
			return unchanged;
		}
		const picked = await vscode.window.showQuickPick(
			changed.map((file) => ({ label: file.path, description: "Pi 最后一次写入后被用户或命令改过", file, picked: false })),
			{ canPickMany: true, title: "这些文件在 Pi 修改之后又被改过，勾选的文件也会恢复", ignoreFocusOut: true },
		);
		if (picked === undefined) {
			throw new ForkCancelled();
		}
		return [...unchanged, ...picked.map((item) => item.file)];
	}

	private async restoreFiles(files: readonly FileRestore[]): Promise<void> {
		const missing = files.filter((file) => file.beforeHash !== null && !this.hub.snapshots.has(file.beforeHash));
		if (missing.length > 0) {
			throw new Error(`这些文件的快照已被清理，无法恢复：${missing.map((file) => file.path).join("、")}`);
		}
		for (const file of files) {
			if (file.beforeHash === null) {
				await rm(file.path, { force: true });
			} else {
				await writeFile(file.path, await this.hub.snapshots.get(file.beforeHash));
			}
		}
	}

	/**
	 * VS Code 传给 forkHandler 的请求不带附件（`extHostChatSessions.ts` 的 `convertRequestDtoToRequestTurn`），
	 * 原文和附件取自分叉点的 pi-harness.request 记录。
	 */
	private async offerPromptRestore(prompt: string, references: readonly ReferenceRecord[]): Promise<void> {
		const attachFiles: Array<vscode.Uri | { uri: vscode.Uri; range: EditorRange }> = [];
		const others: string[] = [];
		for (const reference of references) {
			if (reference.uri !== undefined && reference.range !== undefined) {
				const range = reference.range;
				attachFiles.push({
					uri: vscode.Uri.parse(reference.uri),
					range: { startLineNumber: range.startLine + 1, startColumn: range.startCharacter + 1, endLineNumber: range.endLine + 1, endColumn: range.endCharacter + 1 },
				});
			} else if (reference.uri !== undefined && reference.kind === "file") {
				attachFiles.push(vscode.Uri.parse(reference.uri));
			} else {
				others.push(reference.name);
			}
		}
		const note = others.length > 0 ? `（以下附件需要重新添加：${others.join("、")}）` : "";
		const action = await vscode.window.showInformationMessage(`已从这条请求之前分叉出新会话，原会话保留。${note}`, "把原请求填入输入框");
		if (action === "把原请求填入输入框") {
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt, isPartialQuery: true, attachFiles });
		}
	}
}
