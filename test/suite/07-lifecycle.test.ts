import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import { describeExit } from "../../src/pi/rpcProcess";
import { WriteLock } from "../../src/sessions/writeLock";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	customData,
	env,
	harness,
	lastAssistantText,
	openInSidebar,
	readBranch,
	readEntries,
	runPiCli,
	sendInSidebar,
	sleep,
	startSession,
	userMessages,
	waitFor,
	waitForBusy,
	waitForIdle,
} from "./helpers";

describe("进程生命周期", () => {
	it("Pi 进程退出的说明给出十六进制状态码和标准错误输出", () => {
		assert.equal(describeExit({ code: 3221226505, signal: null, stderrTail: "" }), "退出码 3221226505（0xC0000409），信号 无。没有标准错误输出。");
		assert.equal(describeExit({ code: 1, signal: null, stderrTail: "boom\n" }), "退出码 1，信号 无。标准错误输出：\nboom");
		assert.equal(describeExit({ code: null, signal: "SIGTERM", stderrTail: "" }), "退出码 无，信号 SIGTERM。没有标准错误输出。");
	});

	it("Pi 进程在运行中异常退出后本轮中断，重新发送时恢复同一会话", async () => {
		const api = await harness();
		const sessionId = await startSession(
			api,
			"Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('done'), 60000)\" and after it finishes reply with exactly: COMPLETE",
			false,
		);
		await waitForBusy(api, sessionId);
		await sleep(5000);
		const session = api.hub.existingSession(sessionId);
		const pid = session?.processId;
		assert.ok(pid !== undefined);
		process.kill(pid);
		await waitFor("Pi 进程退出", () => !session?.isRunning);
		await waitFor("写入权限释放", () => !session?.holdsWritePermission);
		await sleep(1000);

		await sendInSidebar("Reply with exactly: RECOVERED. Do not use any tools.");
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		assert.match(lastAssistantText(branch), /RECOVERED/);
		assert.notEqual(api.hub.existingSession(sessionId)?.processId, pid);
		const users = userMessages(branch);
		assert.equal(users.length, 2, "中断的一轮的用户消息保留在会话中");
		// 请求记录在本轮结束时写入，中断的一轮没有记录
		const records = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.deepEqual(
			records.map((record) => record.userEntryId),
			[users[1].id],
		);
	});

	it("两个会话同时运行，输出各自写入自己的会话", async () => {
		const api = await harness();
		const first = await startSession(api, "Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('one'), 8000)\" and then reply with exactly: ALPHA-ONE", false);
		await waitForBusy(api, first);
		const second = await startSession(api, "Reply with exactly: BRAVO-TWO. Do not use any tools.", false);
		const [firstFile, secondFile] = await Promise.all([waitForIdle(api, first), waitForIdle(api, second)]);
		assert.match(lastAssistantText(await readBranch(api, firstFile)), /ALPHA-ONE/);
		assert.match(lastAssistantText(await readBranch(api, secondFile)), /BRAVO-TWO/);
		assert.doesNotMatch(JSON.stringify(await readBranch(api, secondFile)), /ALPHA-ONE/);
	});

	it("另一个窗口持有写入权限时不启动 Pi，也不写入会话", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "Reply with exactly: LOCKED-TEST. Do not use any tools.");
		const sessionFile = await waitForIdle(api, sessionId);
		const location = await api.hub.locate(sessionId);
		assert.ok(location);
		assert.equal(await WriteLock.acquire(location.cwd, sessionId), undefined, "本窗口运行 Pi 时写入权限已被持有");

		await api.hub.existingSession(sessionId)?.shutdown();
		await waitFor("写入权限释放", () => !api.hub.existingSession(sessionId)?.holdsWritePermission);
		const otherWindow = await WriteLock.acquire(location.cwd, sessionId);
		assert.ok(otherWindow, "进程退出后写入权限应可以被其他窗口取得");
		try {
			await openInSidebar(sessionId);
			await sendInSidebar("Reply with exactly: SHOULD-NOT-RUN");
			await sleep(2000);
			assert.equal(api.hub.existingSession(sessionId)?.isRunning ?? false, false);
			assert.equal(userMessages(await readBranch(api, sessionFile)).length, 1);
		} finally {
			await otherWindow.release();
		}
	});

	it("Pi 空闲超过设定时间后结束进程，下一次发送时重新启动", async () => {
		const api = await harness();
		const config = vscode.workspace.getConfiguration("piHarness");
		await config.update("idleShutdownMinutes", 1, vscode.ConfigurationTarget.Global);
		try {
			const sessionId = await startSession(api, "Reply with exactly: IDLE-ONE. Do not use any tools.");
			await waitForIdle(api, sessionId);
			const session = api.hub.existingSession(sessionId);
			assert.ok(session?.isRunning);
			await waitFor("空闲超时后 Pi 进程退出", () => !session.isRunning, 120_000, 1000);
			assert.equal(session.holdsWritePermission, false);
			await sendInSidebar("Reply with exactly: IDLE-TWO. Do not use any tools.");
			const sessionFile = await waitForIdle(api, sessionId);
			assert.match(lastAssistantText(await readBranch(api, sessionFile)), /IDLE-TWO/);
		} finally {
			await config.update("idleShutdownMinutes", undefined, vscode.ConfigurationTarget.Global);
		}
	});

	it("从历史打开的会话被 VS Code 释放且 Pi 空闲时结束进程", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const sessionsDir = env("PI_HARNESS_TEST_SESSIONS");
		const before = new Set(readdirSync(sessionsDir));
		await runPiCli(api, workspace, ["-p", "Reply with exactly: HISTORY-ONE"]);
		const created = readdirSync(sessionsDir).filter((name) => !before.has(name));
		assert.equal(created.length, 1);
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		const [header] = await readEntries(api, join(sessionsDir, created[0]));
		assert.ok(header.type === "session");
		const sessionId = header.id;
		// 终端中的 Pi 已经退出，跳过确认其他写入方的对话框
		api.hub.markCreatedHere(sessionId);
		await openInSidebar(sessionId);
		await sendInSidebar("Reply with exactly: HISTORY-TWO. Do not use any tools.");
		await waitForIdle(api, sessionId);
		const session = api.hub.existingSession(sessionId);
		assert.ok(session?.isRunning);
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
		await waitFor("会话内容释放后 Pi 进程退出", () => !session.isRunning, 60_000, 500);
		assert.equal(session.holdsWritePermission, false);
	});
});
