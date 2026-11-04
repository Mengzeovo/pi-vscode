import * as assert from "node:assert/strict";
import { harness, lastAssistantText, readBranch, startSession, waitForIdle } from "./helpers";

describe("基本会话", () => {
	it("新建 Pi 会话并收到真实模型的回复", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "只回复这个单词，不要使用任何工具：PONG");
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const reply = lastAssistantText(branch);
		console.log(`[测试] 会话 ${sessionId}，文件 ${sessionFile}，回复：${reply}`);
		assert.match(reply, /PONG/);
	});
});
