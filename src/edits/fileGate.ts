import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as vscode from "vscode";
import type { CommitParams, CommitResult, ReadBaseParams, ReadBaseResult } from "../../shared/protocol";
import { SnapshotStore, sha256 } from "./snapshotStore";

interface BaseRecord {
	readonly hash: string;
	/** 读取时文档已打开则记录其版本 */
	readonly documentVersion: number | undefined;
}

export interface EditRecord {
	readonly toolCallId: string;
	readonly tool: "edit" | "write";
	readonly path: string;
	readonly beforeHash: string | null;
	readonly afterHash: string;
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

function openDocument(path: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && samePath(document.uri.fsPath, path));
}

function unsavedError(path: string): Error {
	return new Error(`${path} 在 VS Code 中有未保存的修改。Pi 不修改该文件，请用户保存或撤销这些修改后再让 Pi 重试。`);
}

/**
 * Pi 的 edit/write 通过这里读取和写入文件：
 * 已打开且有未保存修改的文件拒绝修改；edit 提交前核对读取时的磁盘内容和文档版本；
 * 有正在处理的 participant 请求时在 externalEdit 中写入，纳入聊天的文件变更记录。
 */
export class FileGate {
	private readonly bases = new Map<string, BaseRecord>();
	private readonly edits = new Map<string, EditRecord>();

	constructor(
		private readonly snapshots: SnapshotStore,
		private readonly activeStream: () => vscode.ChatResponseStream | undefined,
	) {}

	async readBase(params: ReadBaseParams): Promise<ReadBaseResult> {
		const document = openDocument(params.path);
		if (document?.isDirty) {
			throw unsavedError(params.path);
		}
		const bytes = await readFile(params.path);
		this.bases.set(this.baseKey(params.toolCallId, params.path), { hash: sha256(bytes), documentVersion: document?.version });
		return { contentBase64: bytes.toString("base64") };
	}

	async commit(params: CommitParams): Promise<CommitResult> {
		const document = openDocument(params.path);
		if (document?.isDirty) {
			throw unsavedError(params.path);
		}
		const exists = existsSync(params.path);
		const before = exists ? await readFile(params.path) : undefined;
		if (params.tool === "edit") {
			const key = this.baseKey(params.toolCallId, params.path);
			const base = this.bases.get(key);
			if (!base) {
				throw new Error(`没有 ${params.path} 的读取记录，无法核对修改基准`);
			}
			this.bases.delete(key);
			if (before === undefined || sha256(before) !== base.hash) {
				throw new Error(`${params.path} 在 Pi 读取之后被修改，Pi 的修改没有写入。请让 Pi 重新读取文件后再修改。`);
			}
			if (base.documentVersion !== undefined && document !== undefined && document.version !== base.documentVersion) {
				throw new Error(`${params.path} 在 Pi 读取之后在 VS Code 中被修改，Pi 的修改没有写入。`);
			}
		}
		const after = Buffer.from(params.contentBase64, "base64");
		const beforeHash = before === undefined ? null : await this.snapshots.put(before);
		const afterHash = await this.snapshots.put(after);
		const stream = this.activeStream();
		if (stream) {
			await stream.externalEdit(vscode.Uri.file(params.path), () => writeFile(params.path, after));
		} else {
			await writeFile(params.path, after);
		}
		const record: EditRecord = { toolCallId: params.toolCallId, tool: params.tool, path: params.path, beforeHash, afterHash };
		this.edits.set(params.toolCallId, record);
		return { beforeHash, afterHash };
	}

	editFor(toolCallId: string): EditRecord | undefined {
		return this.edits.get(toolCallId);
	}

	/** 本窗口提交过的修改引用的内容哈希；Pi 在本轮结束前还没有把记录写入会话文件 */
	referencedHashes(): string[] {
		const hashes: string[] = [];
		for (const record of this.edits.values()) {
			if (record.beforeHash !== null) {
				hashes.push(record.beforeHash);
			}
			hashes.push(record.afterHash);
		}
		return hashes;
	}

	private baseKey(toolCallId: string, path: string): string {
		return `${toolCallId}\0${process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)}`;
	}
}
