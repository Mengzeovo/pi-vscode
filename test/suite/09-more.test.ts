import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { harness, lastAssistantText, readBranch, sendInSidebar, sessionUri, startSession, waitFor, waitForIdle } from "./helpers";

describe("模型选择和交给终端", () => {
	it("在模型选择器中换用另一个 Pi 模型后，下一条消息使用新模型", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "Reply with exactly: MODEL-ONE. Do not use any tools.");
		await waitForIdle(api, sessionId);
		const other = "cliproxyapi/gpt-6-luna";
		await sendInSidebar("Reply with exactly: MODEL-TWO. Do not use any tools.", true, other);
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const changes = branch.filter((entry) => entry.type === "model_change").map((entry) => (entry.type === "model_change" ? `${entry.provider}/${entry.modelId}` : ""));
		console.log(`[测试] model_change：${changes.join(", ")}`);
		assert.equal(changes.at(-1), other);
		const lastAssistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(lastAssistant?.type === "message" && lastAssistant.message.role === "assistant");
		assert.equal(`${lastAssistant.message.provider}/${lastAssistant.message.model}`, other);
		assert.match(lastAssistantText(branch), /MODEL-TWO/);
	});

	it("在终端中继续会话时先结束 VS Code 中的 Pi 进程并释放写入权限", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "Reply with exactly: HAND-OFF. Do not use any tools.");
		await waitForIdle(api, sessionId);
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		const item = await waitFor("会话条目", () => api.controller.items.get(sessionUri(sessionId)));
		const session = api.hub.existingSession(sessionId);
		assert.ok(session?.isRunning);
		await vscode.commands.executeCommand("piHarness.continueInTerminal", item);
		const terminal = await waitFor("终端", () => vscode.window.terminals.find((candidate) => candidate.name.startsWith("Pi · ")));
		assert.equal(session.isRunning, false);
		assert.equal(session.holdsWritePermission, false);
		const options = terminal.creationOptions as vscode.TerminalOptions;
		const location = await api.hub.locate(sessionId);
		assert.ok(options.shellArgs?.includes(location?.sessionFile ?? ""), "终端中的 Pi 打开同一个会话文件");
		terminal.dispose();
	});
});
