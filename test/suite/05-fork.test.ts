import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { parseSessionResource } from "../../src/sessions/sessionUri";
import { harness, readBranch, sendInSidebar, sessionUri, startSession, userMessages, waitFor, waitForIdle } from "./helpers";

describe("分叉", () => {
	it("/fork 复制整个会话，原会话保留", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "Reply with exactly: FIRST");
		await waitForIdle(api, sessionId);
		await sendInSidebar("Reply with exactly: SECOND");
		const sourceFile = await waitForIdle(api, sessionId);
		const sourceBranch = await readBranch(api, sourceFile);

		const before = new Set<string>();
		api.controller.items.forEach((item) => before.add(item.resource.toString()));
		await vscode.commands.executeCommand("workbench.action.chat.forkConversation", sessionUri(sessionId));
		const forkedItem = await waitFor("分叉出的会话条目", () => {
			let found: vscode.ChatSessionItem | undefined;
			api.controller.items.forEach((item) => {
				if (!before.has(item.resource.toString())) {
					found = item;
				}
			});
			return found;
		});
		const forkedId = parseSessionResource(forkedItem.resource);
		assert.notEqual(forkedId, sessionId);
		const location = await api.hub.locate(forkedId);
		assert.ok(location?.sessionFile, "分叉出的会话应有会话文件");
		const forkedBranch = await readBranch(api, location.sessionFile);
		assert.deepEqual(
			userMessages(forkedBranch).map((user) => user.text),
			userMessages(sourceBranch).map((user) => user.text),
		);
		assert.deepEqual(await readBranch(api, sourceFile), sourceBranch, "原会话不应改变");
	});
});
