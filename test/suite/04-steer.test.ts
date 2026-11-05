import * as assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import {
	customData,
	env,
	fillInput,
	harness,
	lastAssistantText,
	messageText,
	readBranch,
	readEntries,
	sleep,
	startSession,
	toolCalls,
	userMessages,
	waitFor,
	waitForBusy,
	waitForIdle,
} from "./helpers";

describe("引导消息和停止", () => {
	it("Pi 运行时发送的引导消息作为同一次运行中的用户消息送达，并记录对应关系", async () => {
		const api = await harness();
		const sessionId = await startSession(
			api,
			"Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('slept'), 20000)\" and after it finishes reply with exactly: SLEPT",
			false,
		);
		await waitForBusy(api, sessionId);
		await sleep(5000);
		const steering = "Also add the word ORANGE at the very end of your final reply.";
		await fillInput(steering);
		await vscode.commands.executeCommand("workbench.action.chat.steerWithMessage");
		const sessionFile = await waitForIdle(api, sessionId);

		const branch = await readBranch(api, sessionFile);
		const users = userMessages(branch);
		console.log(`[测试] 用户消息：${JSON.stringify(users.map((user) => user.text.slice(0, 60)))}`);
		assert.equal(users.length, 2);
		assert.ok(users[1].text.startsWith(steering), "第二条用户消息应以引导消息开头");
		assert.equal(toolCalls(branch).filter((call) => call.name === "bash").length, 1);
		assert.match(lastAssistantText(branch), /ORANGE/);

		const records = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.deepEqual(
			records.map((record) => record.userEntryId),
			users.map((user) => user.id),
		);
		assert.equal(records[1].userText, steering);
	});

	it("排队的消息在 Pi 本轮结束后作为新的请求送达", async () => {
		const api = await harness();
		const sessionId = await startSession(
			api,
			"Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('waited'), 15000)\" and after it finishes reply with exactly: WAITED",
			false,
		);
		await waitForBusy(api, sessionId);
		await sleep(3000);
		const queued = "Reply with exactly: QUEUED-REPLY. Do not use any tools.";
		await fillInput(queued);
		await vscode.commands.executeCommand("workbench.action.chat.queueMessage");
		const sessionFile = await waitFor(
			"排队的消息完成",
			async () => {
				const location = await api.hub.locate(sessionId);
				if (api.hub.existingSession(sessionId)?.isBusy !== false || location?.sessionFile === undefined || !existsSync(location.sessionFile)) {
					return undefined;
				}
				return userMessages(await readBranch(api, location.sessionFile)).length === 2 ? location.sessionFile : undefined;
			},
			300_000,
			500,
		);
		const branch = await readBranch(api, sessionFile);
		const users = userMessages(branch);
		assert.equal(users[1].text, queued);
		// 排队的消息在第一轮的最终回复之后送达，运行中没有作为引导消息插入
		const firstReply = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant" && /WAITED/.test(messageText(entry.message.content)));
		const queuedEntry = branch.findIndex((entry) => entry.id === users[1].id);
		assert.ok(firstReply !== -1 && firstReply < queuedEntry, "排队的消息应在第一轮的最终回复之后");
		assert.equal(toolCalls(branch).filter((call) => call.name === "bash").length, 1);
		assert.match(lastAssistantText(branch), /QUEUED-REPLY/);
		const records = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.deepEqual(
			records.map((record) => record.userEntryId),
			users.map((user) => user.id),
		);
		assert.notEqual(records[0].requestId, records[1].requestId, "排队的消息应作为另一个请求送达");
		assert.equal(records[1].userText, queued);
	});

	it("停止时中止 Pi 的运行和正在执行的命令", async () => {
		const api = await harness();
		const sessionId = await startSession(
			api,
			"Use the bash tool to run exactly: node -e \"setTimeout(() => console.log('late'), 60000)\" and after it finishes reply with exactly: FINISHED",
			false,
		);
		await waitForBusy(api, sessionId);
		// 等到 bash 调用已经写入会话（助手消息结束后才开始执行命令），再等命令运行一会儿
		await waitFor("bash 开始执行", async () => {
			const location = await api.hub.locate(sessionId);
			if (location?.sessionFile === undefined || !existsSync(location.sessionFile)) {
				return undefined;
			}
			return toolCalls(await readBranch(api, location.sessionFile)).some((call) => call.name === "bash");
		});
		await sleep(3000);
		const started = Date.now();
		const backend = await api.hub.backend();
		const observations: unknown[] = [];
		const capture = (event: string): void => {
			const snapshot = backend.snapshot?.sessions.find((item) => item.sessionId === sessionId);
			observations.push({ event, elapsedMs: Date.now() - started, at: new Date().toISOString(), sequence: snapshot?.sequence, state: snapshot?.state, busy: snapshot?.busy, sessionBusy: api.hub.existingSession(sessionId)?.isBusy, childTasks: snapshot?.childTasks, pendingInteractions: snapshot?.pendingInteractions, pendingCommits: snapshot?.pendingCommits, messageCount: snapshot?.messages.length });
			writeFileSync(join(env("PI_HARNESS_TEST_WORK"), "stop-observations.json"), JSON.stringify(observations, null, 2));
		};
		const unsubscribe = backend.onChanged(() => capture("backend-changed"));
		let sessionFile: string;
		try {
			capture("cancel-issued");
			await vscode.commands.executeCommand("workbench.action.chat.cancel");
			capture("cancel-returned");
			sessionFile = await waitForIdle(api, sessionId, 30_000);
			capture("session-idle");
		} finally { unsubscribe(); }
		const elapsed = Date.now() - started;
		console.log(`[测试] 停止用时 ${elapsed} ms`);
		assert.ok(elapsed < 20_000, `停止应在 20 秒内完成，实际 ${elapsed} ms`);
		const branch = await readBranch(api, sessionFile);
		assert.doesNotMatch(lastAssistantText(branch), /FINISHED/);
		const bashResult = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash");
		assert.ok(bashResult?.type === "message" && bashResult.message.role === "toolResult");
		assert.match(JSON.stringify(bashResult.message.content), /aborted/i, "bash 命令应被中止");
	});
});
