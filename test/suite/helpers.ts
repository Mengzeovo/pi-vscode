import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import type { PiHarnessApi } from "../../src/extension";

export const EXTENSION_ID = "local.pi-harness";

export function env(name: string): string {
	const value = process.env[name];
	if (value === undefined) {
		throw new Error(`测试环境缺少环境变量 ${name}`);
	}
	return value;
}

export async function harness(): Promise<PiHarnessApi> {
	const extension = vscode.extensions.getExtension<PiHarnessApi>(EXTENSION_ID);
	if (!extension) {
		throw new Error(`没有找到扩展 ${EXTENSION_ID}`);
	}
	return extension.activate();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 180_000, intervalMs = 200): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== false) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`等待超时：${label}`);
		}
		await sleep(intervalMs);
	}
}

export async function readEntries(api: PiHarnessApi, sessionFile: string): Promise<FileEntry[]> {
	const runtime = await api.hub.runtime();
	return runtime.modules.parseSessionEntries(await readFile(sessionFile, "utf8"));
}

export async function readBranch(api: PiHarnessApi, sessionFile: string): Promise<SessionEntry[]> {
	const catalog = await api.hub.sessionCatalog();
	return [...(await catalog.readBranch(sessionFile)).branch];
}

export function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** 等待会话空闲且会话文件已写入，返回会话文件路径 */
export async function waitForIdle(api: PiHarnessApi, sessionId: string, timeoutMs = 300_000): Promise<string> {
	return waitFor(
		`会话 ${sessionId} 完成本轮`,
		async () => {
			const session = api.hub.existingSession(sessionId);
			if (!session || session.isBusy) {
				return undefined;
			}
			const location = await api.hub.locate(sessionId);
			const file = location?.sessionFile;
			return file !== undefined && existsSync(file) ? file : undefined;
		},
		timeoutMs,
	);
}

/** 在侧边栏新建 Pi 会话并发送第一条消息，返回会话 ID */
export async function startSession(api: PiHarnessApi, prompt: string, block = true): Promise<string> {
	const before = new Set(api.hub.createdSessionIds());
	const untitled = await vscode.commands.executeCommand<vscode.Uri | undefined>("workbench.action.chat.openNewSessionSidebar.pi-harness");
	if (!untitled) {
		throw new Error("VS Code 没有打开新的 Pi 会话");
	}
	await sendInSidebar(prompt, block);
	const created = await waitFor("新会话创建", () => {
		const ids = api.hub.createdSessionIds().filter((id) => !before.has(id));
		return ids.length > 0 ? ids : undefined;
	});
	if (created.length !== 1) {
		throw new Error(`发送第一条消息后应新建一个会话，实际为 ${created.length} 个`);
	}
	return created[0];
}

/** 等待会话进入运行状态 */
export async function waitForBusy(api: PiHarnessApi, sessionId: string): Promise<void> {
	await waitFor(`会话 ${sessionId} 开始运行`, () => api.hub.existingSession(sessionId)?.isBusy);
}

/** 真实模型样本：本机 Pi 设置中的默认模型 */
export const TEST_MODEL = process.env.PI_HARNESS_TEST_MODEL ?? "cliproxyapi/gpt-6-astra";

/** blockOnResponse 时 workbench.action.chat.open 返回的本轮结果，即 participant 返回的 ChatResult */
export interface ChatTurnResult {
	readonly errorDetails?: { readonly message: string };
}

/** 通过侧边栏 Chat 的输入框发送消息（与用户按 Enter 相同），输入框中已有的附件一起发送；block 为 true 时等待响应完成并返回本轮结果 */
export async function sendInSidebar(prompt: string, block = true, model = TEST_MODEL): Promise<ChatTurnResult | undefined> {
	return vscode.commands.executeCommand<ChatTurnResult | undefined>("workbench.action.chat.open", {
		query: prompt,
		modelSelector: { vendor: "pi-harness", id: model },
		blockOnResponse: block,
	});
}

/** 把文字填入侧边栏 Chat 的输入框，不发送 */
export async function fillInput(text: string): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.chat.open", { query: text, isPartialQuery: true, modelSelector: { vendor: "pi-harness", id: TEST_MODEL } });
}

/** 在侧边栏打开已有的 Pi 会话：先在编辑器中打开，再移到侧边栏 */
export async function openInSidebar(sessionId: string): Promise<void> {
	await vscode.commands.executeCommand("vscode.open", sessionUri(sessionId));
	await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
}

export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export function toolCalls(branch: readonly SessionEntry[]): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall") {
					calls.push({ id: block.id, name: block.name, arguments: block.arguments });
				}
			}
		}
	}
	return calls;
}

export function customData<T>(entries: readonly FileEntry[], customType: string): T[] {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === customType).map((entry) => (entry as { data: T }).data);
}

export function userMessages(branch: readonly SessionEntry[]): Array<{ id: string; text: string }> {
	return branch
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map((entry) => ({ id: entry.id, text: messageText((entry as { message: { content: unknown } }).message.content) }));
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export async function fileHash(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** 用与扩展相同的 Pi 安装和 node 运行 Pi CLI；标准输入为空，Pi 的 -p 模式会读取标准输入直到结束 */
export async function runPiCli(api: PiHarnessApi, cwd: string, args: readonly string[]): Promise<string> {
	const runtime = await api.hub.runtime();
	const child = spawn(runtime.nodeExecutable, [runtime.cliEntry, ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	if (code !== 0) {
		throw new Error(`pi ${args.join(" ")} 退出码 ${code}：${stderr}`);
	}
	return stdout;
}

export function sessionUri(sessionId: string): vscode.Uri {
	return vscode.Uri.from({ scheme: "pi-harness", path: `/${sessionId}` });
}

export function lastAssistantText(branch: readonly SessionEntry[]): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			return messageText(entry.message.content);
		}
	}
	return "";
}
