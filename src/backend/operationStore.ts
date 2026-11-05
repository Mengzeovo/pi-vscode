import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { CommitIdentity, EditEntryData, ReferenceRecord } from "../../shared/protocol";

export type RestoreStage = "requested" | "prepared" | "navigated" | "restoring" | "restored" | "completed";
export type OwnershipState = "running" | "released" | "cleaned";

export interface OwnershipRecord {
	readonly ownershipId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly jobName: string;
	readonly hostPid: number;
	readonly hostCreationTime: string;
	readonly guardianPid: number;
	readonly guardianCreationTime: string;
	readonly backendPid: number;
	readonly backendCreationTime: string;
	readonly state: OwnershipState;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type OwnershipIdentity = Pick<OwnershipRecord, "ownershipId" | "generationId" | "hostPid" | "hostCreationTime" | "guardianPid" | "guardianCreationTime">;

export interface RestoreInput {
	readonly operationId?: string;
	readonly sessionId: string;
	readonly originalRequestId: string;
	readonly requestId: string;
	readonly targetId: string;
	readonly targetParent: string | null;
	readonly sourceLeaf: string | null;
	readonly operationEpoch: number;
	readonly rootRequestIds: readonly string[];
	readonly input: {
		readonly message: string;
		readonly userText?: string;
		readonly contextBlock?: string;
		readonly references: readonly ReferenceRecord[];
		readonly images?: readonly { type: "image"; data: string; mimeType: string }[];
	};
}

export interface RestoreOperation extends Omit<RestoreInput, "operationId"> {
	readonly operationId: string;
	readonly sessionFile: string;
	readonly sourceMarker: string | null;
	readonly navigationMarker: string | null;
	readonly stage: RestoreStage;
	readonly blocked: boolean;
	readonly error: string | null;
	readonly submittedEntryId: string | null;
	readonly acceptedRequestId: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface RestoreFile {
	readonly path: string;
	readonly expected: Buffer | null;
	readonly target: Buffer | null;
	readonly expectedHash: string | null;
	readonly targetHash: string | null;
	readonly documentVersion: number | null;
	readonly snapshotHashes: readonly string[];
	readonly restored: boolean;
}

type Row = Record<string, unknown>;
const stages: readonly RestoreStage[] = ["requested", "prepared", "navigated", "restoring", "restored", "completed"];

export function canonicalFilePath(path: string): string {
	const absolute = resolve(path);
	let canonical: string;
	if (existsSync(absolute)) {
		canonical = realpathSync.native(absolute);
	} else {
		let parent = dirname(absolute);
		while (!existsSync(parent)) {
			const next = dirname(parent);
			if (next === parent) throw new Error(`无法确定文件的真实目录：${path}`);
			parent = next;
		}
		canonical = join(realpathSync.native(parent), absolute.slice(parent.length));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function bytesHash(bytes: Uint8Array | null): string | null {
	return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

function decodeOperation(row: Row): RestoreOperation {
	return {
		operationId: String(row.operation_id), sessionId: String(row.session_id), sessionFile: String(row.session_file),
		originalRequestId: String(row.original_request_id), requestId: String(row.request_id), targetId: String(row.target_id),
		targetParent: row.target_parent === null ? null : String(row.target_parent), sourceLeaf: row.source_leaf === null ? null : String(row.source_leaf),
		operationEpoch: Number(row.operation_epoch), rootRequestIds: JSON.parse(String(row.root_request_ids)), input: JSON.parse(String(row.input_json)),
		sourceMarker: row.source_marker === null ? null : String(row.source_marker), navigationMarker: row.navigation_marker === null ? null : String(row.navigation_marker),
		stage: String(row.stage) as RestoreStage, blocked: row.blocked === 1, error: row.error === null ? null : String(row.error),
		submittedEntryId: row.submitted_entry_id === null ? null : String(row.submitted_entry_id), acceptedRequestId: row.accepted_request_id == null ? null : String(row.accepted_request_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
	};
}

export class OperationStore {
	readonly path: string;
	readonly sessionFile: string;
	private readonly db: DatabaseSync;

	static pathFor(sessionFile: string): string {
		const canonical = canonicalFilePath(sessionFile);
		return join(dirname(canonical), ".pi-harness", `${createHash("sha256").update(canonical).digest("hex")}.sqlite`);
	}

	static referencedHashesFor(sessionFile: string): string[] {
		const path = OperationStore.pathFor(sessionFile);
		if (!existsSync(path)) return [];
		const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
		try {
			if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error(`恢复数据库完整性检查失败：${path}`);
			return OperationStore.readReferencedHashes(db);
		} finally { db.close(); }
	}

	constructor(sessionFile: string, options: { readonly busyTimeoutMs?: number } = {}) {
		this.sessionFile = canonicalFilePath(sessionFile);
		this.path = OperationStore.pathFor(sessionFile);
		mkdirSync(dirname(this.path), { recursive: true });
		this.db = new DatabaseSync(this.path, { timeout: options.busyTimeoutMs ?? 1000 });
		try {
			this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
			const mode = this.db.prepare("PRAGMA journal_mode").get();
			const sync = this.db.prepare("PRAGMA synchronous").get();
			if (mode?.journal_mode !== "wal" || sync?.synchronous !== 2) throw new Error("恢复数据库未启用 WAL 和 FULL 同步");
			if (this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("恢复数据库完整性检查失败");
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS restore_operations (
					operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_file TEXT NOT NULL,
					original_request_id TEXT NOT NULL, request_id TEXT NOT NULL, target_id TEXT NOT NULL,
					target_parent TEXT, source_leaf TEXT, operation_epoch INTEGER NOT NULL, root_request_ids TEXT NOT NULL,
					input_json TEXT NOT NULL, source_marker TEXT, navigation_marker TEXT,
					stage TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, error TEXT, submitted_entry_id TEXT, accepted_request_id TEXT,
					created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS one_pending_restore ON restore_operations ((1)) WHERE stage <> 'completed';
				CREATE TABLE IF NOT EXISTS restore_files (
					operation_id TEXT NOT NULL REFERENCES restore_operations(operation_id), path TEXT NOT NULL,
					expected_blob BLOB, target_blob BLOB, expected_hash TEXT, target_hash TEXT, document_version INTEGER,
					snapshot_hashes TEXT NOT NULL, restored INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY(operation_id,path)
				);
				CREATE TABLE IF NOT EXISTS ownerships (
					ownership_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, state TEXT NOT NULL,
					created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, record_json TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS file_commits (
					commit_id INTEGER PRIMARY KEY, root_request_id TEXT NOT NULL, run_id TEXT NOT NULL,
					tool_call_id TEXT NOT NULL, identity_json TEXT NOT NULL, edit_json TEXT NOT NULL,
					UNIQUE(root_request_id,run_id,tool_call_id)
				);
			`);
			if (!this.db.prepare("PRAGMA table_info(restore_operations)").all().some((column) => column.name === "accepted_request_id")) this.db.exec("ALTER TABLE restore_operations ADD COLUMN accepted_request_id TEXT");
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = work();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getPendingRestore(): RestoreOperation | undefined {
		const row = this.db.prepare("SELECT * FROM restore_operations WHERE stage <> 'completed'").get();
		return row === undefined ? undefined : decodeOperation(row);
	}

	getRestore(operationId: string): RestoreOperation {
		const row = this.db.prepare("SELECT * FROM restore_operations WHERE operation_id=?").get(operationId);
		if (row === undefined) throw new Error(`恢复操作不存在：${operationId}`);
		return decodeOperation(row);
	}

	createRestore(input: RestoreInput): RestoreOperation {
		return this.transaction(() => {
			const active = this.getPendingRestore();
			if (active) {
				if (active.requestId === input.requestId && active.targetId === input.targetId) return active;
				throw new Error(`会话存在未完成的恢复操作：${active.operationId}`);
			}
			const id = input.operationId ?? randomUUID();
			const now = Date.now();
			this.db.prepare(`INSERT INTO restore_operations
				(operation_id,session_id,session_file,original_request_id,request_id,target_id,target_parent,source_leaf,operation_epoch,root_request_ids,input_json,stage,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,'requested',?,?)`).run(id, input.sessionId, this.sessionFile, input.originalRequestId, input.requestId,
				input.targetId, input.targetParent, input.sourceLeaf, input.operationEpoch, JSON.stringify(input.rootRequestIds), JSON.stringify(input.input), now, now);
			return this.getRestore(id);
		});
	}

	prepareRestore(operationId: string, files: readonly RestoreFile[], sourceLeaf: string | null): void {
		this.transaction(() => {
			const operation = this.getRestore(operationId);
			if (operation.stage !== "requested") throw new Error(`恢复准备阶段不正确：${operation.stage}`);
			const insert = this.db.prepare("INSERT INTO restore_files VALUES (?,?,?,?,?,?,?,?,?)");
			for (const file of files) {
				if (bytesHash(file.expected) !== file.expectedHash || bytesHash(file.target) !== file.targetHash) throw new Error(`恢复文件内容校验失败：${file.path}`);
				insert.run(operationId, canonicalFilePath(file.path), file.expected, file.target, file.expectedHash, file.targetHash, file.documentVersion, JSON.stringify(file.snapshotHashes), file.restored ? 1 : 0);
			}
			this.db.prepare("UPDATE restore_operations SET source_leaf=?,stage='prepared',blocked=0,error=NULL,updated_at=? WHERE operation_id=?").run(sourceLeaf, Date.now(), operationId);
		});
	}

	files(operationId: string): RestoreFile[] {
		return this.db.prepare("SELECT * FROM restore_files WHERE operation_id=? ORDER BY path").all(operationId).map((row) => {
			const expected = row.expected_blob === null ? null : Buffer.from(row.expected_blob as Uint8Array);
			const target = row.target_blob === null ? null : Buffer.from(row.target_blob as Uint8Array);
			const expectedHash = row.expected_hash === null ? null : String(row.expected_hash);
			const targetHash = row.target_hash === null ? null : String(row.target_hash);
			if (bytesHash(expected) !== expectedHash || bytesHash(target) !== targetHash) throw new Error(`恢复数据库内容校验失败：${row.path}`);
			return { path: String(row.path), expected, target, expectedHash, targetHash, documentVersion: row.document_version === null ? null : Number(row.document_version), snapshotHashes: JSON.parse(String(row.snapshot_hashes)), restored: row.restored === 1 };
		});
	}

	setRestoreMarkers(operationId: string, markers: { readonly sourceMarker?: string; readonly navigationMarker?: string }): void {
		const fields: string[] = [];
		const values: SQLInputValue[] = [];
		for (const [column, value] of [["source_marker", markers.sourceMarker], ["navigation_marker", markers.navigationMarker]] as const) {
			if (value !== undefined) { fields.push(`${column}=?`); values.push(value); }
		}
		if (fields.length === 0) return;
		this.db.prepare(`UPDATE restore_operations SET ${fields.join(",")},updated_at=? WHERE operation_id=?`).run(...values, Date.now(), operationId);
	}

	refreshPreparedSource(operationId: string, sourceLeaf: string | null): void {
		const operation = this.getRestore(operationId);
		if (operation.stage !== "prepared" || operation.sourceMarker !== null || operation.navigationMarker !== null) throw new Error("恢复源条目不能在当前阶段更新");
		this.db.prepare("UPDATE restore_operations SET source_leaf=?,updated_at=? WHERE operation_id=?").run(sourceLeaf, Date.now(), operationId);
	}

	advanceRestore(operationId: string, stage: RestoreStage): void {
		this.transaction(() => {
			const current = this.getRestore(operationId);
			const next = stages.indexOf(stage);
			const previous = stages.indexOf(current.stage);
			if (next < previous || next > previous + 1 || stage === "completed") throw new Error(`恢复阶段转换不正确：${current.stage} → ${stage}`);
			if (stage === "restored" && this.files(operationId).some((file) => !file.restored)) throw new Error("仍有文件尚未恢复");
			this.db.prepare("UPDATE restore_operations SET stage=?,blocked=0,error=NULL,updated_at=? WHERE operation_id=?").run(stage, Date.now(), operationId);
		});
	}

	markFileRestored(operationId: string, path: string): void {
		const result = this.db.prepare("UPDATE restore_files SET restored=1 WHERE operation_id=? AND path=?").run(operationId, canonicalFilePath(path));
		if (result.changes !== 1) throw new Error(`恢复文件记录不存在：${path}`);
	}

	blockRestore(operationId: string, error: string): void {
		this.db.prepare("UPDATE restore_operations SET blocked=1,error=?,updated_at=? WHERE operation_id=?").run(error, Date.now(), operationId);
	}

	completeRestore(operationId: string, requestId: string, userEntryId: string): void {
		this.transaction(() => {
			const operation = this.getRestore(operationId);
			if (operation.stage === "completed" && operation.submittedEntryId === userEntryId) return;
			if (operation.stage !== "restored" || operation.requestId !== requestId) throw new Error("恢复后的请求身份或阶段不正确");
			this.db.prepare("UPDATE restore_operations SET stage='completed',submitted_entry_id=?,blocked=0,error=NULL,updated_at=? WHERE operation_id=?").run(userEntryId, Date.now(), operationId);
		});
	}

	acceptRestoredRequest(operationId: string, requestId: string, input: RestoreInput["input"]): void {
		this.transaction(() => {
			const operation = this.getRestore(operationId);
			if (operation.stage !== "restored" || operation.blocked) throw new Error("历史恢复尚未完成，无法接受新请求");
			if (operation.acceptedRequestId !== null) throw new Error(`恢复后的请求已经接受：${operation.acceptedRequestId}`);
			this.db.prepare("UPDATE restore_operations SET request_id=?,accepted_request_id=?,input_json=?,updated_at=? WHERE operation_id=?").run(requestId, requestId, JSON.stringify(input), Date.now(), operationId);
		});
	}

	clearUnsubmittedRequest(operationId: string): void {
		const operation = this.getRestore(operationId);
		if (operation.stage !== "restored" || operation.submittedEntryId !== null) throw new Error("恢复请求阶段无法重新开放发送");
		this.db.prepare("UPDATE restore_operations SET accepted_request_id=NULL,blocked=0,error=NULL,updated_at=? WHERE operation_id=?").run(Date.now(), operationId);
	}

	referencedHashes(): string[] {
		return OperationStore.readReferencedHashes(this.db);
	}

	private static readReferencedHashes(db: DatabaseSync): string[] {
		const restoring = db.prepare("SELECT snapshot_hashes FROM restore_files JOIN restore_operations USING(operation_id) WHERE stage <> 'completed'").all()
			.flatMap((row) => JSON.parse(String(row.snapshot_hashes)) as string[]);
		const committed = db.prepare("SELECT edit_json FROM file_commits").all().flatMap((row) => {
			const edit: EditEntryData = JSON.parse(String(row.edit_json));
			return [...(edit.beforeHash === null ? [] : [edit.beforeHash]), edit.afterHash];
		});
		return [...new Set([...restoring, ...committed])];
	}

	recordEdit(data: EditEntryData, identity: CommitIdentity): void {
		this.transaction(() => {
			const existing = this.db.prepare("SELECT identity_json,edit_json FROM file_commits WHERE root_request_id=? AND run_id=? AND tool_call_id=?").get(identity.rootRequestId, identity.runId, data.toolCallId);
			if (existing) {
				const previous: EditEntryData = JSON.parse(String(existing.edit_json));
				const previousIdentity: CommitIdentity = JSON.parse(String(existing.identity_json));
				if (canonicalFilePath(previous.path) !== canonicalFilePath(data.path) || previous.beforeHash !== data.beforeHash || previous.afterHash !== data.afterHash || previous.tool !== data.tool || Object.keys(previousIdentity).some((key) => previousIdentity[key as keyof CommitIdentity] !== identity[key as keyof CommitIdentity])) throw new Error(`同一文件提交身份包含不同内容：${data.toolCallId}`);
				return;
			}
			this.db.prepare("INSERT INTO file_commits(root_request_id,run_id,tool_call_id,identity_json,edit_json) VALUES (?,?,?,?,?)").run(identity.rootRequestId, identity.runId, data.toolCallId, JSON.stringify(identity), JSON.stringify(data));
		});
	}

	editsFor(rootRequestIds: readonly string[]): EditEntryData[] {
		if (rootRequestIds.length === 0) return [];
		return this.db.prepare(`SELECT edit_json FROM file_commits WHERE root_request_id IN (${rootRequestIds.map(() => "?").join(",")}) ORDER BY commit_id`).all(...rootRequestIds).map((row) => JSON.parse(String(row.edit_json)) as EditEntryData);
	}

	latestOwnership(): OwnershipRecord | undefined {
		const row = this.db.prepare("SELECT record_json FROM ownerships ORDER BY rowid DESC LIMIT 1").get();
		return row === undefined ? undefined : JSON.parse(String(row.record_json));
	}

	claimOwnership(record: OwnershipRecord): void {
		this.transaction(() => {
			const current = this.latestOwnership();
			if (current?.state === "running") throw new Error(`旧进程归属尚未完成清理：${current.ownershipId}`);
			if (record.state !== "running") throw new Error("新进程归属必须为 running");
			this.db.prepare("INSERT INTO ownerships VALUES (?,?,?,?,?,?)").run(record.ownershipId, record.generationId, record.state, record.createdAt, record.updatedAt, JSON.stringify(record));
		});
	}

	finishOwnership(identity: OwnershipIdentity, state: "released" | "cleaned"): void {
		this.transaction(() => {
			const row = this.db.prepare("SELECT record_json FROM ownerships WHERE ownership_id=?").get(identity.ownershipId);
			if (!row) throw new Error(`进程归属记录不存在：${identity.ownershipId}`);
			const current: OwnershipRecord = JSON.parse(String(row.record_json));
			for (const key of ["ownershipId", "generationId", "hostPid", "hostCreationTime", "guardianPid", "guardianCreationTime"] as const) {
				if (current[key] !== identity[key]) throw new Error(`进程归属身份不匹配：${key}`);
			}
			if (current.state === state || current.state === "released" && state === "cleaned") return;
			if (current.state !== "running") throw new Error(`进程归属状态无法更新：${current.state}`);
			const updated = { ...current, state, updatedAt: Date.now() };
			this.db.prepare("UPDATE ownerships SET state=?,updated_at=?,record_json=? WHERE ownership_id=? AND generation_id=?").run(state, updated.updatedAt, JSON.stringify(updated), identity.ownershipId, identity.generationId);
		});
	}

	close(): void { this.db.close(); }
}
