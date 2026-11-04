import * as assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { env, harness, readBranch, sendInSidebar, waitFor, waitForIdle } from "./helpers";

const BROKEN_MODEL = "broken/broken-model";

function providerExtension(port: number): string {
	return [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		"",
		"export default function (pi: ExtensionAPI) {",
		'\tpi.registerProvider("broken", {',
		'\t\tname: "Broken",',
		`\t\tbaseUrl: "http://127.0.0.1:${port}/v1",`,
		'\t\tapiKey: "invalid-test-key",',
		'\t\tapi: "openai-completions",',
		"\t\tmodels: [",
		'\t\t\t{ type: "chat", id: "broken-model", name: "Broken Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 },',
		"\t\t],",
		"\t});",
		"}",
		"",
	].join("\n");
}

describe("认证失败", () => {
	it("模型服务拒绝认证时本轮显示错误，Pi 进程保持运行", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		// 本机 HTTP 服务对所有请求返回 401，作为拒绝认证的模型服务
		const server: Server = createServer((request, response) => {
			request.resume();
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const extensionFile = join(workspace, ".pi", "extensions", "broken-provider.ts");
		mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
		writeFileSync(extensionFile, providerExtension(port));
		try {
			await vscode.commands.executeCommand("piHarness.refreshModels");
			await waitFor("模型选择器中出现测试模型", async () => (await vscode.lm.selectChatModels({ vendor: "pi-harness", id: BROKEN_MODEL })).length > 0);
			await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
			const before = new Set(api.hub.createdSessionIds());
			const result = await sendInSidebar("Reply with exactly: SHOULD-FAIL", true, BROKEN_MODEL);
			const sessionId = api.hub.createdSessionIds().find((id) => !before.has(id));
			assert.ok(sessionId);
			const sessionFile = await waitForIdle(api, sessionId);
			const branch = await readBranch(api, sessionFile);
			const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
			console.log(`[测试] 会话 ${sessionId}：stopReason=${assistant.message.stopReason} errorMessage=${assistant.message.errorMessage}`);
			assert.equal(assistant.message.stopReason, "error");
			assert.match(assistant.message.errorMessage ?? "", /401|api key/i);
			// VS Code 把 participant 返回的 errorDetails 显示为本轮的错误
			console.log(`[测试] 本轮结果：${JSON.stringify(result)}`);
			assert.equal(result?.errorDetails?.message, assistant.message.errorMessage);
			assert.equal(api.hub.existingSession(sessionId)?.isRunning, true, "Pi 进程保持运行");
		} finally {
			rmSync(extensionFile, { force: true });
			server.close();
			await vscode.commands.executeCommand("piHarness.refreshModels");
		}
	});
});
