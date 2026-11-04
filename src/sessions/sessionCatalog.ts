import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { PiRuntime } from "../pi/piRuntime";
import { parseJson } from "../util/json";

export interface SessionRecord {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionFile: string;
	readonly sessionDir: string;
	readonly name: string | undefined;
	readonly firstMessage: string;
	readonly created: Date;
	readonly modified: Date;
	readonly parentSessionPath: string | undefined;
}

export interface SessionBranch {
	readonly header: SessionHeader;
	readonly entries: readonly FileEntry[];
	/** 当前分支，从根到叶子 */
	readonly branch: readonly SessionEntry[];
}

interface SettingsFile {
	readonly sessionDir?: string;
}

const UTF8_BOM = "\uFEFF";

async function readSessionDirSetting(file: string): Promise<string | undefined> {
	if (!existsSync(file)) {
		return undefined;
	}
	let text = await readFile(file, "utf8");
	if (text.startsWith(UTF8_BOM)) {
		text = text.slice(1);
	}
	return parseJson<SettingsFile>(text, file).sessionDir;
}

/** 按 Pi 文档中的规则计算某个工作目录的默认会话目录（不创建目录） */
export function defaultSessionDir(agentDir: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return join(agentDir, "sessions", `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/**
 * Pi 会话的只读目录。会话目录按 Pi 的优先顺序确定：
 * 环境变量 PI_CODING_AGENT_SESSION_DIR、项目设置、全局设置、默认目录。
 * 相对路径按会话工作目录解析。
 */
export class SessionCatalog {
	private readonly records = new Map<string, SessionRecord>();

	constructor(private readonly runtime: PiRuntime) {}

	async sessionDirFor(cwd: string): Promise<string> {
		const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const agentDir = this.runtime.modules.getAgentDir();
		const configured =
			envDir !== undefined && envDir.length > 0
				? envDir
				: ((await readSessionDirSetting(join(cwd, ".pi", "settings.json"))) ?? (await readSessionDirSetting(join(agentDir, "settings.json"))));
		if (configured === undefined || configured.length === 0) {
			return defaultSessionDir(agentDir, cwd);
		}
		const expanded = this.runtime.modules.expandTildePath(configured);
		return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	}

	/** 列出某个工作目录的会话；会话目录不存在时返回空列表，不创建目录 */
	async listFolder(cwd: string): Promise<SessionRecord[]> {
		const sessionDir = await this.sessionDirFor(cwd);
		if (!existsSync(sessionDir)) {
			return [];
		}
		const infos = await this.runtime.modules.SessionManager.list(cwd, sessionDir);
		const result: SessionRecord[] = [];
		for (const info of infos) {
			const record: SessionRecord = {
				sessionId: info.id,
				cwd: info.cwd.length > 0 ? info.cwd : cwd,
				sessionFile: info.path,
				sessionDir,
				name: info.name,
				firstMessage: info.firstMessage,
				created: info.created,
				modified: info.modified,
				parentSessionPath: info.parentSessionPath,
			};
			this.records.set(record.sessionId, record);
			result.push(record);
		}
		return result;
	}

	get(sessionId: string): SessionRecord | undefined {
		return this.records.get(sessionId);
	}

	remember(record: SessionRecord): void {
		this.records.set(record.sessionId, record);
	}

	/** 在给定的工作目录中按 ID 查找会话，不创建目录 */
	async find(sessionId: string, folders: readonly string[]): Promise<SessionRecord | undefined> {
		const known = this.records.get(sessionId);
		if (known) {
			return known;
		}
		for (const folder of folders) {
			const records = await this.listFolder(folder);
			const match = records.find((record) => record.sessionId === sessionId);
			if (match) {
				return match;
			}
		}
		return undefined;
	}

	/**
	 * 只读取得会话当前分支：读取文件内容，在内存中解析和迁移，不写入任何文件。
	 */
	async readBranch(sessionFile: string): Promise<SessionBranch> {
		const content = await readFile(sessionFile, "utf8");
		const entries = this.runtime.modules.parseSessionEntries(content);
		const header = entries[0];
		if (header === undefined || header.type !== "session" || typeof header.id !== "string") {
			throw new Error(`${sessionFile} 不是有效的 Pi 会话文件：缺少会话头`);
		}
		const manager = this.runtime.modules.SessionManager.inMemory(header.cwd, undefined, entries);
		return { header, entries, branch: manager.getBranch() };
	}
}
