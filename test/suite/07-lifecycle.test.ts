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
		const session = api.hub.existingSession(sessionId);
		await waitFor("中断前保存请求对应关系", async () => {
			if (!session?.location.sessionFile) return false;
			return customData<RequestEntryData>(await readEntries(api, session.location.sessionFile), REQUEST_ENTRY_TYPE).length === 1;
		});
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
		const records = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.deepEqual(
			records.map((record) => record.userEntryId),
			users.map((user) => user.id),
		);
	});

	it("两个会话同时运行，输出各自写入自己的会话", async () => {
		const api = await harness();
		const first = await startSession(api, "Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('one'), 8000)\" and then reply with exactly: ALPHA-ONE", false);
		await waitForBusy(api, first);
		const second = await startSession(api, "Reply with exactly: BRAVO-TWO. Do not use any tools.", false);
		await waitForBusy(api, second);
		assert.equal(api.hub.existingSession(first)?.processId, api.hub.existingSession(second)?.processId, "两个 Chat 共用同一后台");
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

	it("单会话释放后共享后台继续运行，再次发送恢复同一会话", async () => {
		const api = await harness();
			const sessionId = await startSession(api, "Reply with exactly: IDLE-ONE. Do not use any tools.");
			await waitForIdle(api, sessionId);
			const session = api.hub.existingSession(sessionId);
			assert.ok(session?.isRunning);
			const pid = session.processId;
			await session.shutdown();
			assert.equal(session.isRunning, false);
			assert.equal(session.holdsWritePermission, false);
			assert.equal(api.hub.backendStatus?.pid, pid);
			await sendInSidebar("Reply with exactly: IDLE-TWO. Do not use any tools.");
			const sessionFile = await waitForIdle(api, sessionId);
			assert.match(lastAssistantText(await readBranch(api, sessionFile)), /IDLE-TWO/);
			assert.equal(session.processId, pid);
	});

	it("历史会话的内容释放后保持可恢复状态，明确释放保留共享后台", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const sessionsDir = env("PI_HARNESS_TEST_SESSIONS");
		const before = new Set(readdirSync(sessionsDir));
		await runPiCli(api, workspace, ["-p", "Reply with exactly: HISTORY-ONE"]);
		const created = readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl") && !before.has(name));
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
		const pid = api.hub.backendStatus?.pid;
		await session.shutdown();
		assert.equal(session.isRunning, false);
		assert.equal(session.holdsWritePermission, false);
		assert.equal(api.hub.backendStatus?.pid, pid);
	});
});
