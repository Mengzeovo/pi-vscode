import * as assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { modelKey } from "../../src/pi/catalog";
import { env, harness, readBranch, sendInSidebar, TEST_MODEL, waitFor, waitForIdle } from "./helpers";

describe("认证失败", () => {
	it("真实模型服务拒绝无效凭据，本轮显示错误且后台继续运行", async () => {
		const api = await harness();
		const model = (await api.hub.modelChoices()).models.find((item) => modelKey(item) === TEST_MODEL);
		assert.ok(model, "需要已配置的真实模型服务");
		const directory = join(env("PI_HARNESS_TEST_WORKSPACE_A"), ".pi", "extensions");
		const extensionFile = join(directory, "auth-rejection.ts");
		const configFile = join(directory, "auth-rejection.json");
		mkdirSync(directory, { recursive: true });
		const endpoint = new URL(model.baseUrl);
		let apiType = model.api;
		if (apiType === "cliproxyapi-codex-responses") {
			assert.match(endpoint.pathname, /\/backend-api\/?$/);
			endpoint.pathname = endpoint.pathname.replace(/\/backend-api\/?$/, "/v1/");
			apiType = "openai-responses";
		}
		writeFileSync(configFile, JSON.stringify({ baseUrl: endpoint.toString(), api: apiType, model: {
			type: "chat", id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
			cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
		} }));
		copyFileSync(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "auth-rejection.ts"), extensionFile);
		try {
			await vscode.commands.executeCommand("piHarness.refreshModels");
			const rejectedModel = `auth-rejection/${model.id}`;
			await waitFor("真实服务认证检查模型", async () => (await vscode.lm.selectChatModels({ vendor: "pi-harness", id: rejectedModel })).length > 0);
			await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
			const before = new Set(api.hub.createdSessionIds());
			const result = await sendInSidebar("Reply with exactly: AUTH-CHECK", true, rejectedModel);
			const sessionId = api.hub.createdSessionIds().find((id) => !before.has(id));
			assert.ok(sessionId);
			const branch = await readBranch(api, await waitForIdle(api, sessionId));
			const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
			assert.equal(assistant.message.stopReason, "error");
			assert.match(assistant.message.errorMessage ?? "", /401|403|api.key|unauthori[sz]ed|authentication/i);
			assert.equal(result?.errorDetails?.message, assistant.message.errorMessage);
			assert.equal(api.hub.existingSession(sessionId)?.isRunning, true);
			console.log(`[测试] 真实服务拒绝凭据：${assistant.message.errorMessage}`);
		} finally {
			rmSync(extensionFile, { force: true });
			rmSync(configFile, { force: true });
			await vscode.commands.executeCommand("piHarness.refreshModels");
		}
	});
});
