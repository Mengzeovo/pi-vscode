import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { EDIT_ENTRY_TYPE, type EditEntryData } from "../shared/protocol";
import { OPEN_DIFF_COMMAND } from "./chat/toolParts";
import type { EditRecord } from "./edits/fileGate";
import type { PiHub } from "./session/hub";
import type { PiSession, SessionLocation } from "./session/piSession";
import type { SessionList } from "./sessions/sessionList";
import { parseSessionResource } from "./sessions/sessionUri";

export const SNAPSHOT_SCHEME = "pi-harness-snapshot";
const EMPTY_SNAPSHOT = "empty";

/** 只读显示快照内容：pi-harness-snapshot:/<内容哈希或 empty>/<文件名> */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly hub: PiHub) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const hash = uri.path.split("/")[1];
		if (hash === EMPTY_SNAPSHOT) {
			return "";
		}
		if (!this.hub.snapshots.has(hash)) {
			throw new Error(`快照 ${hash} 已被清理`);
		}
		return new TextDecoder("utf-8").decode(await this.hub.snapshots.get(hash));
	}
}

function snapshotUri(hash: string | null, path: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${hash ?? EMPTY_SNAPSHOT}/${basename(path)}` });
}

function itemSessionId(item: vscode.ChatSessionItem | undefined): string {
	if (!item) {
		throw new Error("没有选中 Pi 会话");
	}
	return parseSessionResource(item.resource);
}

async function savedLocation(hub: PiHub, sessionId: string): Promise<SessionLocation & { sessionFile: string }> {
	const location = await hub.locate(sessionId);
	if (!location || location.sessionFile === undefined || !existsSync(location.sessionFile)) {
		throw new Error("这个 Pi 会话还没有保存的消息");
	}
	return location as SessionLocation & { sessionFile: string };
}

/** 从会话文件的全部条目中查找某次工具调用的修改记录 */
async function editFromFile(hub: PiHub, sessionFile: string, toolCallId: string): Promise<EditRecord | undefined> {
	const runtime = await hub.runtime();
	const entries = runtime.modules.parseSessionEntries(await readFile(sessionFile, "utf8"));
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === EDIT_ENTRY_TYPE && (entry.data as EditEntryData).toolCallId === toolCallId) {
			return entry.data as EditEntryData;
		}
	}
	return undefined;
}

async function openDiff(hub: PiHub, sessionId: string, toolCallId: string): Promise<void> {
	let record = hub.existingSession(sessionId)?.fileGate.editFor(toolCallId);
	if (!record) {
		const location = await savedLocation(hub, sessionId);
		record = await editFromFile(hub, location.sessionFile, toolCallId);
	}
	if (!record) {
		throw new Error("没有找到这次修改的快照记录");
	}
	await vscode.commands.executeCommand(
		"vscode.diff",
		snapshotUri(record.beforeHash, record.path),
		snapshotUri(record.afterHash, record.path),
		`${basename(record.path)}（Pi ${record.tool === "edit" ? "修改" : "写入"}）`,
		{ preview: true },
	);
}

/** givenName 由其他命令或测试直接传入；从菜单执行时弹出输入框 */
async function renameSession(hub: PiHub, item: vscode.ChatSessionItem | undefined, givenName: string | undefined): Promise<void> {
	const sessionId = itemSessionId(item);
	const location = await savedLocation(hub, sessionId);
	const name = givenName ?? (await vscode.window.showInputBox({ prompt: "Pi 会话的新名称", value: item?.label, ignoreFocusOut: true }));
	if (name === undefined || name.trim().length === 0) {
		return;
	}
	const session = await hub.session(location);
	await session.editFile(async () => {
		if (session.isRunning) {
			await session.setName(name.trim());
		} else {
			const runtime = await hub.runtime();
			runtime.modules.SessionManager.open(location.sessionFile, location.sessionDir).appendSessionInfo(name.trim());
		}
	});
	hub.setTitle(sessionId, name.trim());
	hub.notifyChanged(sessionId);
}

/** confirmed 由其他命令或测试直接传入；从菜单执行时弹出确认对话框 */
async function deleteSession(hub: PiHub, item: vscode.ChatSessionItem | undefined, confirmed: boolean): Promise<void> {
	const sessionId = itemSessionId(item);
	const location = await savedLocation(hub, sessionId);
	const choice = confirmed
		? "移到回收站"
		: await vscode.window.showWarningMessage(
				`把 Pi 会话“${item?.label ?? sessionId}”的会话文件移到回收站？`,
				{ modal: true, detail: location.sessionFile },
				"移到回收站",
			);
	if (choice !== "移到回收站") {
		return;
	}
	const session = await hub.session(location);
	await session.editFile(async () => {
		await session.shutdown();
		await vscode.workspace.fs.delete(vscode.Uri.file(location.sessionFile), { useTrash: true });
	});
	hub.forget(sessionId);
	hub.notifyChanged();
}

async function continueInTerminal(hub: PiHub, item: vscode.ChatSessionItem | undefined): Promise<void> {
	const sessionId = itemSessionId(item);
	const location = await savedLocation(hub, sessionId);
	const session: PiSession | undefined = hub.existingSession(sessionId);
	if (session?.isBusy) {
		throw new Error("Pi 正在运行本轮任务，请在本轮结束后再交给终端");
	}
	if (session) {
		await session.shutdown();
		session.markHandedOff();
	}
	const runtime = await hub.runtime();
	const terminal = vscode.window.createTerminal({
		name: `Pi · ${item?.label ?? sessionId.slice(0, 8)}`,
		cwd: location.cwd,
		shellPath: runtime.nodeExecutable,
		shellArgs: [runtime.cliEntry, "--session", location.sessionFile, "--session-dir", location.sessionDir],
		iconPath: new vscode.ThemeIcon("hubot"),
	});
	terminal.show();
}

/** 删除不再被任何会话文件中的修改记录引用的快照内容 */
async function cleanSnapshots(hub: PiHub): Promise<void> {
	const runtime = await hub.runtime();
	const referenced = new Set<string>();
	const missing: string[] = [];
	for (const file of hub.snapshotSessionFiles()) {
		if (!existsSync(file)) {
			missing.push(file);
			continue;
		}
		for (const entry of runtime.modules.parseSessionEntries(await readFile(file, "utf8"))) {
			if (entry.type === "custom" && entry.customType === EDIT_ENTRY_TYPE) {
				const data = entry.data as EditEntryData;
				if (data.beforeHash !== null) {
					referenced.add(data.beforeHash);
				}
				referenced.add(data.afterHash);
			}
		}
	}
	for (const session of hub.allSessions()) {
		for (const hash of session.fileGate.referencedHashes()) {
			referenced.add(hash);
		}
	}
	await hub.forgetSnapshotSessions(missing);
	const removed = await hub.snapshots.prune(referenced);
	void vscode.window.showInformationMessage(`已删除 ${removed} 份不再使用的 Pi 快照。`);
}

/**
 * 把聊天回复中选中的文字按 Markdown 引用格式插入输入框。
 * 复制命令在焦点位于回复列表时复制页面中选中的文字；剪贴板接口只支持文字，原有的图片和富文本不能恢复。
 */
async function quoteSelection(hub: PiHub): Promise<void> {
	const original = await vscode.env.clipboard.readText();
	const marker = `pi-harness-quote-${randomUUID()}`;
	await vscode.env.clipboard.writeText(marker);
	try {
		await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
		const copied = await vscode.env.clipboard.readText();
		hub.log(`引用回复内容：复制命令取得 ${copied === marker ? 0 : copied.length} 个字符`);
		if (copied === marker || copied.trim().length === 0) {
			void vscode.window.showInformationMessage("请先在 Pi 的回复中选中要引用的文字。");
			return;
		}
		const quoted = `${copied
			.replace(/\r\n/g, "\n")
			.replace(/\n+$/, "")
			.split("\n")
			.map((line) => (line.length > 0 ? `> ${line}` : ">"))
			.join("\n")}\n\n`;
		await vscode.commands.executeCommand("workbench.action.chat.focusInput");
		await vscode.commands.executeCommand("type", { text: quoted });
	} finally {
		await vscode.env.clipboard.writeText(original);
	}
}

function guard<T extends unknown[]>(hub: PiHub, action: string, run: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
	return async (...args: T) => {
		try {
			await run(...args);
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			hub.log(`${action}失败：${message}`);
			void vscode.window.showErrorMessage(`${action}失败：${message}`);
		}
	};
}

export function registerCommands(hub: PiHub, list: SessionList): vscode.Disposable[] {
	return [
		vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotContentProvider(hub)),
		vscode.commands.registerCommand(OPEN_DIFF_COMMAND, guard(hub, "打开差异", (sessionId: string, toolCallId: string) => openDiff(hub, sessionId, toolCallId))),
		vscode.commands.registerCommand(
			"piHarness.renameSession",
			guard(hub, "重命名 Pi 会话", (item?: vscode.ChatSessionItem, name?: unknown) => renameSession(hub, item, typeof name === "string" ? name : undefined)),
		),
		vscode.commands.registerCommand(
			"piHarness.deleteSession",
			guard(hub, "删除 Pi 会话", (item?: vscode.ChatSessionItem, confirmed?: unknown) => deleteSession(hub, item, confirmed === true)),
		),
		vscode.commands.registerCommand("piHarness.continueInTerminal", guard(hub, "在终端中继续 Pi 会话", (item?: vscode.ChatSessionItem) => continueInTerminal(hub, item))),
		vscode.commands.registerCommand("piHarness.cleanSnapshots", guard(hub, "清理 Pi 快照", () => cleanSnapshots(hub))),
		vscode.commands.registerCommand("piHarness.refreshModels", guard(hub, "刷新 Pi 模型列表", () => hub.refreshChoices())),
		vscode.commands.registerCommand("piHarness.refreshSessions", guard(hub, "刷新 Pi 会话列表", () => list.refresh())),
		vscode.commands.registerCommand("piHarness.quoteSelection", guard(hub, "引用回复内容", () => quoteSelection(hub))),
		vscode.commands.registerCommand("piHarness.restoreHint", () => {
			void vscode.window.showInformationMessage(
				"Pi 会话不使用 VS Code 的还原检查点。要从某条请求重新开始，请在该请求上按 Enter 编辑后提交；要保留原会话，请使用 Fork Conversation，扩展会询问是否同时恢复 Pi 修改过的文件。",
			);
		}),
	];
}
