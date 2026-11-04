import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import {
	customData,
	env,
	harness,
	lastAssistantText,
	readBranch,
	readEntries,
	sendInSidebar,
	sessionUri,
	sleep,
	startSession,
	TEST_MODEL,
	toolCalls,
	userMessages,
	waitForBusy,
	waitForIdle,
} from "./helpers";

async function openDirty(path: string, line: number, text: string): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument(path);
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	await editor.edit((builder) => builder.replace(document.lineAt(line).range, text));
	assert.ok(document.isDirty);
	return editor;
}

/** VS Code 默认在发送聊天消息前保存所有编辑器（chat.saveBeforeSend），测试未保存内容时关闭该设置 */
async function withoutSaveBeforeSend(run: () => Promise<void>): Promise<void> {
	const chat = vscode.workspace.getConfiguration("chat");
	await chat.update("saveBeforeSend", false, vscode.ConfigurationTarget.Global);
	try {
		await run();
	} finally {
		await chat.update("saveBeforeSend", undefined, vscode.ConfigurationTarget.Global);
	}
}

describe("编辑器上下文", () => {
	const workspace = (): string => env("PI_HARNESS_TEST_WORKSPACE_A");

	it("附加的选区使用编辑器中未保存的文字，请求记录保存用户原文和附件", () =>
		withoutSaveBeforeSend(async () => {
		const api = await harness();
		const path = join(workspace(), "context.ts");
		writeFileSync(path, ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", ""].join("\n"));
		const editor = await openDirty(path, 2, "const unsaved = 42; // UNSAVED-MARKER-7731");
		await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
		const before = new Set(api.hub.createdSessionIds());
		const query = "Repeat the exact text of the attached selection inside a code block. Do not use any tools.";
		await vscode.commands.executeCommand("workbench.action.chat.open", {
			query,
			attachFiles: [{ uri: editor.document.uri, range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 45 } }],
			modelSelector: { vendor: "pi-harness", id: TEST_MODEL },
			blockOnResponse: true,
		});
		const sessionId = api.hub.createdSessionIds().find((id) => !before.has(id));
		assert.ok(sessionId);
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const users = userMessages(branch);
		assert.equal(users.length, 1);
		assert.ok(users[0].text.startsWith(`${query}\n\n<vscode-context>`), "Pi 收到的文字应为用户原文加上下文块");
		assert.match(users[0].text, /UNSAVED-MARKER-7731/);
		assert.match(users[0].text, /unsaved="true"/);
		assert.match(lastAssistantText(branch), /UNSAVED-MARKER-7731/);

		const [record] = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.equal(record.userText, query);
		assert.equal(record.references.length, 1);
		assert.equal(record.references[0].kind, "selection");
		assert.equal(record.references[0].documentVersion, editor.document.version);

		const state = await api.options.provide(sessionUri(sessionId), undefined);
		const content = await api.content.provideChatSessionContent(sessionUri(sessionId), new vscode.CancellationTokenSource().token, { inputState: state });
		const request = content.history[0];
		assert.ok(request instanceof vscode.ChatRequestTurn2);
		assert.equal(request.prompt, query);
		assert.ok(request.references[0].value instanceof vscode.Location);
		await vscode.commands.executeCommand("workbench.action.files.revert", editor.document.uri);
		}));

	it("Pi 不修改编辑器中有未保存修改的文件", () =>
		withoutSaveBeforeSend(async () => {
		const api = await harness();
		const path = join(workspace(), "guarded.txt");
		writeFileSync(path, "first line\nsecond line\n");
		const editor = await openDirty(path, 1, "second line edited in VS Code");
		const sessionId = await startSession(
			api,
			"Use the edit tool once to replace the text 'first line' with 'FIRST LINE' in guarded.txt. Do not retry and do not use any other tool. If the edit tool reports an error, reply with exactly: BLOCKED",
		);
		const sessionFile = await waitForIdle(api, sessionId);
		assert.equal(readFileSync(path, "utf8"), "first line\nsecond line\n", "磁盘内容不应改变");
		assert.ok(editor.document.isDirty);
		assert.equal(editor.document.lineAt(1).text, "second line edited in VS Code", "编辑器中的未保存内容应保留");
		const branch = await readBranch(api, sessionFile);
		const editResult = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "edit");
		assert.ok(editResult?.type === "message" && editResult.message.role === "toolResult");
		assert.equal(editResult.message.isError, true);
		assert.match(JSON.stringify(editResult.message.content), /未保存/);
		await vscode.commands.executeCommand("workbench.action.files.revert", editor.document.uri);
		}));

	it("Pi 运行期间用户开始修改的文件不被 Pi 覆盖", async () => {
		const api = await harness();
		const path = join(workspace(), "typing.txt");
		writeFileSync(path, "first line\nsecond line\n");
		const sessionId = await startSession(
			api,
			"First use the bash tool to run exactly: node -e \"setTimeout(() => {}, 12000)\". After it finishes, use the edit tool once to replace 'first line' with 'FIRST LINE' in typing.txt. Do not retry and do not use any other tool. If the edit tool reports an error, reply with exactly: BLOCKED",
			false,
		);
		await waitForBusy(api, sessionId);
		await sleep(4000);
		const editor = await openDirty(path, 1, "typed while Pi was running");
		const sessionFile = await waitForIdle(api, sessionId);
		assert.equal(readFileSync(path, "utf8"), "first line\nsecond line\n", "磁盘内容不应改变");
		assert.equal(editor.document.lineAt(1).text, "typed while Pi was running");
		assert.ok(editor.document.isDirty);
		const branch = await readBranch(api, sessionFile);
		const editResult = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "edit");
		assert.ok(editResult?.type === "message" && editResult.message.role === "toolResult");
		assert.equal(editResult.message.isError, true);
		await vscode.commands.executeCommand("workbench.action.files.revert", editor.document.uri);
	});

	it("截图附件作为图片送达 Pi", async () => {
		const api = await harness();
		await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
		const before = new Set(api.hub.createdSessionIds());
		await vscode.commands.executeCommand("workbench.action.chat.open", {
			query: "Is there an image attached to this message? Answer with exactly YES or NO. Do not use any tools.",
			attachScreenshot: true,
			modelSelector: { vendor: "pi-harness", id: TEST_MODEL },
			blockOnResponse: true,
		});
		const sessionId = api.hub.createdSessionIds().find((id) => !before.has(id));
		assert.ok(sessionId);
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(user?.type === "message" && user.message.role === "user" && Array.isArray(user.message.content));
		assert.ok(
			user.message.content.some((block) => block.type === "image"),
			"用户消息应包含图片",
		);
		assert.match(lastAssistantText(branch), /YES/i);
	});

	it("用户保留 Pi 的修改后，下一个请求携带文件变更事件", async () => {
		const api = await harness();
		const path = join(workspace(), "events.txt");
		writeFileSync(path, "red\n");
		const sessionId = await startSession(api, "Use the edit tool to replace red with green in events.txt, then reply with exactly: EDITED");
		await waitForIdle(api, sessionId);
		assert.equal(readFileSync(path, "utf8"), "green\n");
		await vscode.commands.executeCommand("chatEditing.acceptAllFiles");
		await sendInSidebar("Reply with exactly: NEXT. Do not use any tools.");
		const sessionFile = await waitForIdle(api, sessionId);
		const users = userMessages(await readBranch(api, sessionFile));
		console.log(`[测试] 第二条用户消息：${users[1]?.text}`);
		assert.match(users[1].text, /<edited-files[^>]*>\s*kept: .*events\.txt/);
		assert.equal(toolCalls(await readBranch(api, sessionFile)).filter((call) => call.name === "edit").length, 1);
	});
});
