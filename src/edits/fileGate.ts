import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";
import type { CommitIdentity, CommitParams, CommitResult, ReadBaseParams, ReadBaseResult, RestoreApplyParams, RestoreFileData, RestorePrepareParams } from "../../shared/protocol";
import { normalizedFilePath, serializeFile } from "./fileIdentity";
import { SnapshotStore, sha256 } from "./snapshotStore";

interface BaseRecord { readonly hash: string | null; readonly documentVersion: number | undefined; }

export interface EditRecord {
	readonly toolCallId: string;
	readonly tool: "edit" | "write";
	readonly path: string;
	readonly beforeHash: string | null;
	readonly afterHash: string;
	readonly identity?: CommitIdentity;
}

function openDocument(path: string): vscode.TextDocument | undefined {
	const key = normalizedFilePath(path);
	return vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && normalizedFilePath(document.uri.fsPath) === key);
}

function checkedDocument(path: string): vscode.TextDocument | undefined {
	const document = openDocument(path);
	if (document?.isDirty) throw new Error(`${path} 在 VS Code 中有未保存的修改。请保存或撤销这些修改后重试。`);
	return document;
}

async function readCurrent(path: string): Promise<Buffer | null> { return existsSync(path) ? readFile(path) : null; }
function contentHash(bytes: Buffer | null): string | null { return bytes === null ? null : sha256(bytes); }

async function persistFile(path: string, bytes: Buffer | null): Promise<void> {
	if (bytes === null) { await rm(path, { force: true }); return; }
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "w");
	try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class FileGate {
	private readonly bases = new Map<string, BaseRecord>();
	private readonly edits = new Map<string, EditRecord & { readonly identity: CommitIdentity }>();
	private readonly pending = new Set<Promise<unknown>>();
	private readonly protectedHashes = new Map<string, Set<string>>();
	private readonly revokedRoots = new Set<string>();

	constructor(
		private readonly snapshots: SnapshotStore,
		private readonly activeStream: () => vscode.ChatResponseStream | undefined,
		private readonly validateIdentity?: (identity: CommitIdentity) => void | Promise<void>,
		private readonly recordIntent?: (record: EditRecord & { readonly identity: CommitIdentity }) => Promise<void>,
	) {}

	private async checkIdentity(identity: CommitIdentity): Promise<void> {
		if (!identity || !identity.sessionId || !identity.generationId || !identity.ownershipId || !identity.rootRequestId || !identity.runId || !Number.isSafeInteger(identity.runtimeGeneration) || !Number.isSafeInteger(identity.operationEpoch)) {
			throw new Error("文件提交缺少有效的会话与运行身份");
		}
		if (this.revokedRoots.has(identity.rootRequestId)) throw new Error(`请求 ${identity.rootRequestId} 的文件提交身份已失效`);
		if (!this.validateIdentity) throw new Error("文件提交身份检查尚未初始化");
		await this.validateIdentity(identity);
		if (this.revokedRoots.has(identity.rootRequestId)) throw new Error(`请求 ${identity.rootRequestId} 的文件提交身份已失效`);
	}

	invalidate(rootRequestIds: readonly string[]): void { for (const root of rootRequestIds) this.revokedRoots.add(root); }

	private track<T>(action: Promise<T>): Promise<T> {
		this.pending.add(action);
		void action.then(() => this.pending.delete(action), () => this.pending.delete(action));
		return action;
	}

	async waitForIdle(): Promise<void> { await Promise.allSettled([...this.pending]); }

	async readBase(params: ReadBaseParams): Promise<ReadBaseResult> {
		await this.checkIdentity(params.identity);
		return this.track(serializeFile(params.path, async () => {
			await this.checkIdentity(params.identity);
			const document = checkedDocument(params.path);
			const bytes = await readCurrent(params.path);
			this.bases.set(this.baseKey(params.identity, params.toolCallId, params.path), { hash: contentHash(bytes), documentVersion: document?.version });
			return { contentBase64: bytes?.toString("base64") ?? "", exists: bytes !== null, hash: contentHash(bytes), documentVersion: document?.version ?? null };
		}));
	}

	async commit(params: CommitParams): Promise<CommitResult> {
		await this.checkIdentity(params.identity);
		return this.track(serializeFile(params.path, async () => {
			await this.checkIdentity(params.identity);
			const document = checkedDocument(params.path);
			const version = document?.version;
			const key = this.baseKey(params.identity, params.toolCallId, params.path);
			const base = this.bases.get(key);
			if (!base) throw new Error(`没有 ${params.path} 的读取记录，无法核对修改基准`);
			this.bases.delete(key);
			const before = await readCurrent(params.path);
			if (contentHash(before) !== base.hash) throw new Error(`${params.path} 在 Pi 读取之后被修改，本次修改没有写入。`);
			if (base.documentVersion !== undefined && document !== undefined && document.version !== base.documentVersion) throw new Error(`${params.path} 的文档版本已变化，本次修改没有写入。`);
			const after = Buffer.from(params.contentBase64, "base64");
			const beforeHash = before === null ? null : sha256(before);
			const afterHash = sha256(after);
			const unpin = this.snapshots.protect([...(beforeHash === null ? [] : [beforeHash]), afterHash]);
			try {
				if (before !== null) await this.snapshots.put(before);
				await this.snapshots.put(after);
				const record = { toolCallId: params.toolCallId, tool: params.tool, path: normalizedFilePath(params.path), beforeHash, afterHash, identity: params.identity };
				if (!this.recordIntent) throw new Error("文件提交持久记录尚未初始化");
				await this.recordIntent(record);
				this.edits.set(this.editKey(params.identity, params.toolCallId), record);
				const write = async () => {
					await this.checkIdentity(params.identity);
					const currentDocument = checkedDocument(params.path);
					if (version !== undefined && currentDocument !== undefined && currentDocument.version !== version || contentHash(await readCurrent(params.path)) !== base.hash) throw new Error(`${params.path} 在准备提交期间被修改，本次修改没有写入。`);
					await this.checkIdentity(params.identity);
					await persistFile(params.path, after);
					if (contentHash(await readCurrent(params.path)) !== afterHash) throw new Error(`${params.path} 写入后的内容核对失败`);
				};
				const stream = this.activeStream();
				if (stream) await stream.externalEdit(vscode.Uri.file(params.path), write); else await write();
				return { beforeHash, afterHash };
			} finally { unpin(); }
		}));
	}

	async prepareRestore(params: RestorePrepareParams): Promise<readonly RestoreFileData[]> {
		this.invalidate(params.rootRequestIds);
		await this.waitForIdle();
		const candidates = new Map(params.files.map((file) => [normalizedFilePath(file.path), file]));
		for (const edit of this.edits.values()) {
			if (!params.rootRequestIds.includes(edit.identity.rootRequestId)) continue;
			const key = normalizedFilePath(edit.path);
			const current = candidates.get(key);
			candidates.set(key, { path: key, beforeHash: current ? current.beforeHash : edit.beforeHash, lastAfterHash: edit.afterHash,
				sourceHashes: [...new Set([...(current?.sourceHashes ?? []), ...(edit.beforeHash === null ? [] : [edit.beforeHash]), edit.afterHash])] });
		}
		const files: RestoreFileData[] = [];
		const hashes = new Set<string>();
		for (const candidate of candidates.values()) {
			files.push(await serializeFile(candidate.path, async () => {
				const document = checkedDocument(candidate.path);
				const target = candidate.beforeHash === null ? null : await this.snapshots.get(candidate.beforeHash);
				const expected = await readCurrent(candidate.path);
				const actual = contentHash(expected);
				if (actual !== candidate.beforeHash && actual !== candidate.lastAfterHash && (actual === null || !candidate.sourceHashes?.includes(actual))) throw new Error(`${candidate.path} 包含用户或其他工具的修改，无法自动恢复`);
				const snapshotHashes = [...new Set([...(candidate.beforeHash === null ? [] : [candidate.beforeHash]), candidate.lastAfterHash, ...(candidate.sourceHashes ?? [])])];
				for (const hash of snapshotHashes) hashes.add(hash);
				return { path: normalizedFilePath(candidate.path), expectedBase64: expected?.toString("base64") ?? null, targetBase64: target?.toString("base64") ?? null, expectedHash: actual,
					targetHash: candidate.beforeHash, documentVersion: document?.version ?? null, snapshotHashes, restored: actual === candidate.beforeHash };
			}));
		}
		this.protectedHashes.set(params.operationId, hashes);
		return files;
	}

	applyRestore(params: RestoreApplyParams): Promise<void> {
		return this.track(serializeFile(params.file.path, async () => {
			const file = params.file;
			const document = checkedDocument(file.path);
			const actual = contentHash(await readCurrent(file.path));
			if (actual === file.targetHash) return;
			if (actual !== file.expectedHash) throw new Error(`${file.path} 的内容与恢复记录不一致`);
			if (!params.reopened && file.documentVersion !== null && document !== undefined && document.version !== file.documentVersion) throw new Error(`${file.path} 的文档版本与恢复记录不一致`);
			const target = file.targetBase64 === null ? null : Buffer.from(file.targetBase64, "base64");
			if (contentHash(target) !== file.targetHash) throw new Error(`${file.path} 的恢复内容校验失败`);
			await persistFile(file.path, target);
			if (contentHash(await readCurrent(file.path)) !== file.targetHash) throw new Error(`${file.path} 恢复后的内容核对失败`);
		}));
	}

	releaseRestore(operationId: string): void { this.protectedHashes.delete(operationId); }
	editFor(toolCallId: string): EditRecord | undefined { return [...this.edits.values()].findLast((record) => record.toolCallId === toolCallId); }

	referencedHashes(): string[] {
		return [...this.edits.values()].flatMap((record) => [...(record.beforeHash === null ? [] : [record.beforeHash]), record.afterHash])
			.concat([...this.protectedHashes.values()].flatMap((hashes) => [...hashes]));
	}

	private editKey(identity: CommitIdentity, toolCallId: string): string { return `${identity.sessionId}\0${identity.rootRequestId}\0${identity.runId}\0${toolCallId}`; }
	private baseKey(identity: CommitIdentity, toolCallId: string, path: string): string { return `${this.editKey(identity, toolCallId)}\0${normalizedFilePath(path)}`; }
}
