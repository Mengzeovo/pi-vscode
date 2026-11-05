import { open, readFile } from "node:fs/promises";
import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AgentSession, ExtensionError, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { EDIT_ENTRY_TYPE, REQUEST_ENTRY_TYPE, type EditEntryData, type RequestEntryData, type RestoreApplyParams, type RestoreCandidate, type RestoreFileData, type RestorePrepareParams } from "../../shared/protocol";
import { OperationStore, canonicalFilePath, type RestoreFile, type RestoreInput, type RestoreOperation } from "./operationStore";

export const RESTORE_SOURCE_TYPE = "pi_harness_restore_source";
export const RESTORE_NAVIGATION_TYPE = "pi_harness_restore_navigation";
export const RESTORE_CANCEL_TYPE = "pi_harness_restore_cancel";
export const RESTORE_ACCEPT_TYPE = "pi_harness_restore_accept";

export interface RecoveryFileAccess {
	prepare(params: RestorePrepareParams): Promise<readonly RestoreFileData[]>;
	apply(params: RestoreApplyParams): Promise<void>;
	waitForIdle(): Promise<void>;
}

export interface RecoveryHooks {
	readonly session: AgentSession;
	readonly reopen: (sessionFile: string) => SessionManager;
	readonly assertOwnership: () => void | Promise<void>;
	readonly invalidate: (rootRequestIds: readonly string[]) => void | Promise<void>;
	readonly stopAndWait: (rootRequestIds: readonly string[]) => Promise<void>;
	readonly files: RecoveryFileAccess;
	readonly onCheckpoint?: (stage: string, operation: RestoreOperation) => void | Promise<void>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hash(bytes: Buffer | null): string | null { return bytes === null ? null : createHash("sha256").update(bytes).digest("hex"); }

export function decodeRestoreFile(file: RestoreFileData): RestoreFile {
	return { ...file, expected: file.expectedBase64 === null ? null : Buffer.from(file.expectedBase64, "base64"), target: file.targetBase64 === null ? null : Buffer.from(file.targetBase64, "base64") };
}

export function encodeRestoreFile(file: RestoreFile): RestoreFileData {
	return { path: file.path, expectedBase64: file.expected?.toString("base64") ?? null, targetBase64: file.target?.toString("base64") ?? null,
		expectedHash: file.expectedHash, targetHash: file.targetHash, documentVersion: file.documentVersion, snapshotHashes: file.snapshotHashes, restored: file.restored };
}

function markerData(entry: SessionEntry): { operationId?: string; targetParent?: string | null; sourceLeaf?: string | null; targetId?: string } {
	return entry.type === "custom" && typeof entry.data === "object" && entry.data !== null ? entry.data : {};
}

function isMetadata(entry: SessionEntry, operationId: string, acceptedRequest = false): boolean {
	if (entry.type === "thinking_level_change" || entry.type === "model_change" || entry.type === "session_info") return true;
	if (acceptedRequest && entry.type === "message" && entry.message.role === "system" && entry.message.content === "") return true;
	return entry.type === "custom" && [RESTORE_SOURCE_TYPE, RESTORE_NAVIGATION_TYPE, RESTORE_CANCEL_TYPE, RESTORE_ACCEPT_TYPE].includes(entry.customType) && markerData(entry).operationId === operationId;
}

export function collectRestoreCandidates(entries: readonly SessionEntry[], targetId: string, additional: readonly EditEntryData[] = []): RestoreCandidate[] {
	const index = entries.findIndex((entry) => entry.id === targetId);
	if (index < 0) throw new Error(`恢复目标不在原分支中：${targetId}`);
	const changes = entries.slice(index).filter((entry) => entry.type === "custom" && entry.customType === EDIT_ENTRY_TYPE).map((entry) => (entry as { data: EditEntryData }).data);
	const candidates = new Map<string, RestoreCandidate>();
	const seen = new Set<string>();
	const editKey = (edit: EditEntryData): string => `${canonicalFilePath(edit.path)}\0${edit.toolCallId}\0${edit.beforeHash}\0${edit.afterHash}`;
	const persisted = new Set(additional.map(editKey));
	// SQLite 保存全部主任务和子任务的实际提交顺序；仅在原生历史中存在的记录属于此前历史。
	for (const edit of [...changes.filter((edit) => !persisted.has(editKey(edit))), ...additional]) {
		const key = canonicalFilePath(edit.path);
		const identity = editKey(edit);
		if (seen.has(identity)) continue;
		seen.add(identity);
		const current = candidates.get(key);
		candidates.set(key, { path: key, beforeHash: current ? current.beforeHash : edit.beforeHash, lastAfterHash: edit.afterHash,
			sourceHashes: [...new Set([...(current?.sourceHashes ?? []), ...(edit.beforeHash === null ? [] : [edit.beforeHash]), edit.afterHash])] });
	}
	return [...candidates.values()];
}

export class RecoveryCoordinator {
	private active: Promise<RestoreOperation> | undefined;

	constructor(readonly store: OperationStore, private readonly hooks: RecoveryHooks) {}

	get pending(): RestoreOperation | undefined { return this.store.getPendingRestore(); }

	async restore(input: RestoreInput): Promise<RestoreOperation> {
		if (this.active) throw new Error("当前会话的历史恢复正在执行");
		await this.hooks.assertOwnership();
		const manager = this.hooks.session.sessionManager;
		const target = manager.getEntry(input.targetId);
		if (target?.type !== "message" || target.message.role !== "user" || target.parentId !== input.targetParent) throw new Error("恢复目标用户消息或父条目与真实会话不一致");
		if (manager.getSessionId() !== input.sessionId) throw new Error("恢复目标会话身份不一致");
		const operation = this.store.createRestore({ ...input, sourceLeaf: manager.getLeafId() });
		return this.run(operation, false);
	}

	async resume(): Promise<RestoreOperation | undefined> {
		const operation = this.pending;
		if (!operation) return undefined;
		if (this.active) return this.active;
		await this.hooks.assertOwnership();
		return this.run(operation, true);
	}

	private run(operation: RestoreOperation, reopened: boolean): Promise<RestoreOperation> {
		const promise = this.execute(operation, reopened);
		this.active = promise;
		void promise.then(() => { if (this.active === promise) this.active = undefined; }, () => { if (this.active === promise) this.active = undefined; });
		return promise;
	}

	private async checkpoint(stage: string, operationId: string): Promise<void> {
		await this.hooks.onCheckpoint?.(stage, this.store.getRestore(operationId));
	}

	private async execute(initial: RestoreOperation, reopened: boolean): Promise<RestoreOperation> {
		const { operationId } = initial;
		try {
			await this.hooks.invalidate(initial.rootRequestIds);
			await this.hooks.stopAndWait(initial.rootRequestIds);
			await this.hooks.files.waitForIdle();
			await this.hooks.assertOwnership();
			let operation = this.store.getRestore(operationId);
			if (operation.stage === "requested") {
				const manager = this.hooks.session.sessionManager;
				const files = await this.hooks.files.prepare({ operationId, rootRequestIds: operation.rootRequestIds,
					files: collectRestoreCandidates(manager.getBranch(), operation.targetId, this.store.editsFor(operation.rootRequestIds)) });
				this.store.prepareRestore(operationId, files.map(decodeRestoreFile), manager.getLeafId());
				await this.checkpoint("prepared", operationId);
				operation = this.store.getRestore(operationId);
			}
			if (operation.stage === "prepared") {
				await this.navigate(operation);
				this.store.advanceRestore(operationId, "navigated");
				await this.checkpoint("navigated", operationId);
				operation = this.store.getRestore(operationId);
			}
			if (operation.stage === "navigated") {
				this.verifyNavigation(operation, this.hooks.session.sessionManager);
				this.store.advanceRestore(operationId, "restoring");
				operation = this.store.getRestore(operationId);
			}
			if (operation.stage === "restoring") {
				this.verifyNavigation(operation, this.hooks.session.sessionManager);
				for (const file of this.store.files(operationId)) {
					await this.hooks.assertOwnership();
					await this.hooks.files.apply({ operationId, file: encodeRestoreFile(file), reopened });
					await this.checkpoint(`file-written:${file.path}`, operationId);
					this.store.markFileRestored(operationId, file.path);
					await this.checkpoint(`file-recorded:${file.path}`, operationId);
				}
				this.verifyNavigation(operation, this.hooks.session.sessionManager);
				await this.syncAndVerify(operation);
				this.store.advanceRestore(operationId, "restored");
				await this.checkpoint("restored", operationId);
				operation = this.store.getRestore(operationId);
			}
			if (operation.stage === "restored") {
				const completed = this.findSubmitted(operation);
				if (completed) return completed;
				this.verifyNavigation(operation, this.hooks.session.sessionManager);
				for (const file of this.store.files(operationId)) await this.hooks.files.apply({ operationId, file: encodeRestoreFile(file), reopened });
				this.store.advanceRestore(operationId, "restored");
				if (reopened) this.store.clearUnsubmittedRequest(operationId);
			}
			return this.store.getRestore(operationId);
		} catch (error) {
			this.store.blockRestore(operationId, errorText(error));
			throw error;
		}
	}

	private findMarker(operation: RestoreOperation, customType: string): SessionEntry | undefined {
		const matches = this.hooks.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType && markerData(entry).operationId === operation.operationId);
		if (matches.length > 1) throw new Error(`恢复操作包含重复控制记录：${customType}`);
		return matches[0];
	}

	private async navigate(operation: RestoreOperation): Promise<void> {
		const session = this.hooks.session;
		const manager = session.sessionManager;
		const savedNavigation = this.findMarker(operation, RESTORE_NAVIGATION_TYPE);
		if (savedNavigation) {
			this.store.setRestoreMarkers(operation.operationId, { navigationMarker: savedNavigation.id });
			await this.syncAndVerify(this.store.getRestore(operation.operationId));
			return;
		}
		let source = this.findMarker(operation, RESTORE_SOURCE_TYPE);
		if (source) {
			if (source.parentId !== operation.sourceLeaf) throw new Error("恢复源控制记录的父条目不一致");
		} else {
			const branch = manager.getBranch();
			const sourceIndex = operation.sourceLeaf === null ? -1 : branch.findIndex((entry) => entry.id === operation.sourceLeaf);
			if (operation.sourceLeaf !== null && sourceIndex < 0 || branch.slice(sourceIndex + 1).some((entry) => !isMetadata(entry, operation.operationId))) throw new Error("恢复源分支发生了其他修改");
			if (manager.getLeafId() !== operation.sourceLeaf) {
				this.store.refreshPreparedSource(operation.operationId, manager.getLeafId());
				operation = this.store.getRestore(operation.operationId);
			}
			const id = manager.appendCustomEntry(RESTORE_SOURCE_TYPE, { operationId: operation.operationId, sourceLeaf: operation.sourceLeaf, targetId: operation.targetId, targetParent: operation.targetParent });
			source = manager.getEntry(id)!;
			await this.checkpoint("source-appended", operation.operationId);
		}
		this.store.setRestoreMarkers(operation.operationId, { sourceMarker: source.id });
		session.refreshContext();
		try {
			await this.checkedNavigate(operation.targetId);
			if (manager.getLeafId() !== operation.targetParent) throw new Error(`Pi 导航后的父条目不一致：${manager.getLeafId() ?? "根节点"}`);
			await this.checkpoint("navigation-selected", operation.operationId);
			const id = manager.appendCustomEntry(RESTORE_NAVIGATION_TYPE, { operationId: operation.operationId, targetId: operation.targetId, targetParent: operation.targetParent });
			session.refreshContext();
			await this.checkpoint("navigation-appended", operation.operationId);
			this.store.setRestoreMarkers(operation.operationId, { navigationMarker: id });
			await this.syncAndVerify(this.store.getRestore(operation.operationId));
		} catch (error) {
			const untouched = await this.filesHaveExpectedContent(operation.operationId);
			if (untouched && !this.findMarker(operation, RESTORE_NAVIGATION_TYPE)) {
				await this.checkedNavigate(source.id);
				manager.appendCustomEntry(RESTORE_CANCEL_TYPE, { operationId: operation.operationId, reason: errorText(error) });
				session.refreshContext();
				await this.syncSessionFile();
			}
			throw error;
		}
	}

	private async checkedNavigate(entryId: string): Promise<void> {
		const errors: ExtensionError[] = [];
		const dispose = this.hooks.session.extensionRunner.onError((error) => { errors.push(error); });
		try {
			const result = await this.hooks.session.navigateTree(entryId, { summarize: false });
			if (errors.length > 0) throw new Error(errors.map((error) => `${error.extensionPath} ${error.event}: ${error.error}`).join("\n"));
			if (result.cancelled) throw new Error(`Pi 导航被扩展取消：${entryId}`);
		} finally { dispose(); }
	}

	private async filesHaveExpectedContent(operationId: string): Promise<boolean> {
		for (const file of this.store.files(operationId)) {
			if (file.restored) return false;
			const actual = existsSync(file.path) ? await readFile(file.path) : null;
			if (hash(actual) !== file.expectedHash) return false;
		}
		return true;
	}

	verifyNavigation(operation: RestoreOperation, manager: SessionManager): void {
		if (manager.getSessionId() !== operation.sessionId || !operation.navigationMarker) throw new Error("恢复导航记录缺少会话身份或控制记录");
		const branch = manager.getBranch();
		const index = branch.findIndex((entry) => entry.id === operation.navigationMarker);
		const marker = branch[index];
		if (!marker || marker.type !== "custom" || marker.customType !== RESTORE_NAVIGATION_TYPE || marker.parentId !== operation.targetParent || markerData(marker).operationId !== operation.operationId) throw new Error("恢复导航控制记录与当前分支不一致");
		if (branch.slice(index + 1).some((entry) => !isMetadata(entry, operation.operationId, operation.acceptedRequestId !== null))) throw new Error("恢复目标分支包含未经确认的消息或工具修改");
	}

	private async syncSessionFile(): Promise<void> {
		const handle = await open(this.store.sessionFile, "r+");
		try { await handle.sync(); } finally { await handle.close(); }
	}

	private async syncAndVerify(operation: RestoreOperation): Promise<void> {
		await this.syncSessionFile();
		this.verifyNavigation(operation, this.hooks.reopen(this.store.sessionFile));
		this.verifyNavigation(operation, this.hooks.session.sessionManager);
	}

	private findSubmitted(operation: RestoreOperation): RestoreOperation | undefined {
		const branch = this.hooks.session.sessionManager.getBranch();
		const entry = branch.find((candidate) => candidate.type === "custom" && candidate.customType === REQUEST_ENTRY_TYPE && (candidate.data as RequestEntryData).requestId === operation.requestId);
		if (entry?.type === "custom") {
			this.markSubmitted(operation.requestId, (entry.data as RequestEntryData).userEntryId);
			return this.store.getRestore(operation.operationId);
		}
		if (!operation.acceptedRequestId) return undefined;
		const acceptance = branch.findIndex((candidate) => candidate.type === "custom" && candidate.customType === RESTORE_ACCEPT_TYPE && markerData(candidate).operationId === operation.operationId && (candidate.data as { requestId: string }).requestId === operation.acceptedRequestId);
		if (acceptance < 0) return undefined;
		const user = branch.slice(acceptance + 1).find((candidate) => !isMetadata(candidate, operation.operationId, true));
		if (!user) return undefined;
		if (user.type !== "message" || user.message.role !== "user") throw new Error("恢复后已接受请求的首个消息类型不正确");
		this.markSubmitted(operation.acceptedRequestId, user.id);
		return this.store.getRestore(operation.operationId);
	}

	markSubmitted(requestId: string, userEntryId: string): void {
		const operation = this.pending;
		if (!operation) return;
		const branch = this.hooks.session.sessionManager.getBranch();
		const markerIndex = branch.findIndex((entry) => entry.id === operation.navigationMarker);
		const userIndex = branch.findIndex((entry) => entry.id === userEntryId);
		const user = branch[userIndex];
		if (markerIndex < 0 || userIndex <= markerIndex || user?.type !== "message" || user.message.role !== "user") throw new Error("恢复后的用户请求尚未保存到目标分支");
		if (branch.slice(markerIndex + 1, userIndex).some((entry) => !isMetadata(entry, operation.operationId, operation.acceptedRequestId !== null))) throw new Error("恢复后的请求之前存在其他消息或文件修改");
		const descriptor = openSync(this.store.sessionFile, "r+");
		try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
		const persisted = this.hooks.reopen(this.store.sessionFile).getBranch();
		if (!persisted.some((entry) => entry.id === userEntryId && entry.type === "message" && entry.message.role === "user") || !persisted.some((entry) => entry.id === operation.navigationMarker)) throw new Error("恢复后的用户消息尚未通过重新打开核对");
		this.store.completeRestore(operation.operationId, requestId, userEntryId);
	}

	acceptExplicitRequest(requestId: string, input: RestoreInput["input"]): void {
		const operation = this.pending;
		if (!operation) return;
		this.verifyNavigation(operation, this.hooks.session.sessionManager);
		this.store.acceptRestoredRequest(operation.operationId, requestId, input);
		const manager = this.hooks.session.sessionManager;
		const acceptance = manager.appendCustomEntry(RESTORE_ACCEPT_TYPE, { operationId: operation.operationId, requestId });
		this.hooks.session.refreshContext();
		const descriptor = openSync(this.store.sessionFile, "r+");
		try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
		if (!this.hooks.reopen(this.store.sessionFile).getBranch().some((entry) => entry.id === acceptance)) throw new Error("恢复请求的接受记录尚未通过重新打开核对");
	}
}
