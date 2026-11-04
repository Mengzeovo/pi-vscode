import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { EDIT_ENTRY_TYPE, type EditEntryData, REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import {
	customData,
	env,
	harness,
	lastAssistantText,
	readBranch,
	readEntries,
	sendInSidebar,
	sha256Text,
	startSession,
	toolCalls,
	userMessages,
	waitFor,
	waitForIdle,
} from "./helpers";

describe("工具调用和多轮对话", () => {
	it("Pi 读取、修改文件并运行验证命令，修改进入快照，第二轮继续同一会话", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const target = join(workspace, "notes.txt");
		writeFileSync(target, "alpha\n");
		const sessionId = await startSession(
			api,
			[
				"Do exactly these steps in order:",
				"1. Use the read tool to read notes.txt.",
				"2. Use the edit tool to replace the word alpha with beta in notes.txt.",
				"3. Use the bash tool to run: node -e \"process.stdout.write(require('fs').readFileSync('notes.txt','utf8'))\"",
				"Then reply with exactly: DONE",
			].join("\n"),
		);
		const sessionFile = await waitForIdle(api, sessionId);
		assert.equal(readFileSync(target, "utf8"), "beta\n");

		const branch = await readBranch(api, sessionFile);
		const calls = toolCalls(branch);
		console.log(`[测试] 工具调用：${calls.map((call) => call.name).join(", ")}`);
		assert.equal(calls.filter((call) => call.name === "read").length, 1);
		assert.equal(calls.filter((call) => call.name === "edit").length, 1);
		assert.equal(calls.filter((call) => call.name === "bash").length, 1);
		assert.match(lastAssistantText(branch), /DONE/);

		const entries = await readEntries(api, sessionFile);
		const edits = customData<EditEntryData>(entries, EDIT_ENTRY_TYPE);
		assert.equal(edits.length, 1);
		assert.equal(edits[0].tool, "edit");
		assert.equal(edits[0].beforeHash, sha256Text("alpha\n"));
		assert.equal(edits[0].afterHash, sha256Text("beta\n"));
		assert.ok(api.hub.snapshots.has(edits[0].afterHash));
		assert.equal(edits[0].toolCallId, calls.find((call) => call.name === "edit")?.id);

		await vscode.commands.executeCommand("piHarness.openDiff", sessionId, edits[0].toolCallId);
		const diffTab = await waitFor("差异编辑器", () =>
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "pi-harness-snapshot"),
		);
		const input = diffTab.input as vscode.TabInputTextDiff;
		assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), "alpha\n");
		assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), "beta\n");
		await vscode.window.tabGroups.close(diffTab);

		await sendInSidebar("In one short sentence, which word did you write into notes.txt? Do not use any tools.");
		await waitForIdle(api, sessionId);
		const branchAfter = await readBranch(api, sessionFile);
		assert.match(lastAssistantText(branchAfter).toLowerCase(), /beta/);
		const records = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		const users = userMessages(branchAfter);
		assert.equal(records.length, 2);
		assert.deepEqual(
			records.map((record) => record.userEntryId),
			users.map((user) => user.id),
		);
	});
});
