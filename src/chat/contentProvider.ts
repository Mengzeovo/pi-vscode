import { existsSync } from "node:fs";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import type { PiHub } from "../session/hub";
import { isUntitledResource, parseSessionResource } from "../sessions/sessionUri";
import { renderHistory } from "./historyRenderer";
import { optionsOfState } from "./sessionOptions";

/** 会话文件中最近一次设置的会话名称 */
export function sessionNameOf(entries: readonly FileEntry[]): string | undefined {
	let name: string | undefined;
	for (const entry of entries) {
		if (entry.type === "session_info") {
			name = entry.name !== undefined && entry.name.trim().length > 0 ? entry.name.trim() : undefined;
		}
	}
	return name;
}

/** 为 VS Code 提供 Pi 会话的历史；Pi 仍在运行时由 activeResponseCallback 接回本轮输出 */
export class PiContentProvider implements vscode.ChatSessionContentProvider {
	constructor(private readonly hub: PiHub, readonly provideHandleOptionsChange?: vscode.ChatSessionContentProvider["provideHandleOptionsChange"]) {}

	async provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken, context: { readonly inputState: vscode.ChatSessionInputState }): Promise<vscode.ChatSession> {
		this.hub.trackInputState(resource, context.inputState);
		const options = optionsOfState(context.inputState);
		if (isUntitledResource(resource)) {
			return { history: [], options, requestHandler: undefined };
		}
		const sessionId = parseSessionResource(resource);
		const pending = this.hub.pendingSession(sessionId);
		if (pending) {
			return { title: pending.label, history: [], options, requestHandler: undefined };
		}
		const location = await this.hub.locate(sessionId);
		if (!location) {
			throw new Error(`没有找到 Pi 会话 ${sessionId}`);
		}
		const session = this.hub.existingSession(sessionId) ?? (vscode.workspace.isTrusted ? await this.hub.session(location) : undefined);
		const recovery = vscode.workspace.isTrusted ? await session?.recoverPending() : undefined;
		const busy = session?.isBusy ?? false;
		if (location.sessionFile === undefined || !existsSync(location.sessionFile)) {
			return {
				title: this.hub.title(sessionId),
				history: [],
				options,
				requestHandler: undefined,
				activeResponseCallback: busy && session ? (stream, token) => session.attachCallback(stream, token, []) : undefined,
			};
		}
		const { entries, branch } = await (await this.hub.sessionCatalog()).readBranch(location.sessionFile);
		const rendered = renderHistory(sessionId, location.cwd, branch, busy);
		if (recovery && recovery.stage === "restored") {
			const text = new vscode.MarkdownString().appendText(`历史和文件已恢复。待确认的输入：\n\n${recovery.input.userText ?? recovery.input.message}`);
			if (recovery.input.references.length > 0) text.appendText(`\n\n保留的附件：${recovery.input.references.map((reference) => reference.name).join("、")}。发送时使用已保存的附件内容。`);
			const args = encodeURIComponent(JSON.stringify([sessionId, recovery.operationId]));
			text.appendMarkdown(`\n\n[把保留的输入填入输入框](command:piHarness.restoreInput?${args})`);
			text.isTrusted = { enabledCommands: ["piHarness.restoreInput"] };
			const response = new vscode.ChatResponseMarkdownPart(text);
			rendered.turns.push(new vscode.ChatResponseTurn2([response], {}, "pi-harness"));
		}
		this.hub.markShown(
			sessionId,
			branch.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.id),
		);
		return {
			title: this.hub.title(sessionId) ?? sessionNameOf(entries),
			history: rendered.turns,
			options,
			requestHandler: undefined,
			activeResponseCallback: busy && session ? (stream, token) => session.attachCallback(stream, token, rendered.tailParts) : undefined,
		};
	}
}
