import * as assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { modelKey } from "../../src/pi/catalog";
import { env, harness, TEST_MODEL, waitFor } from "./helpers";

describe("模型列表", () => {
	it("读取模型目录时共享后台异常退出，完成清理后重新取得模型", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		await api.hub.modelChoices();
		const originalPid = api.hub.backendStatus?.pid;
		assert.ok(originalPid);
		const extensionFile = join(workspace, ".pi", "extensions", "crash-once.ts");
		const marker = join(workspace, "crash-once.marker");
		mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
		copyFileSync(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "crash-once.ts"), extensionFile);
		writeFileSync(marker, "");
		try {
			await assert.rejects(api.hub.refreshChoices(), /退出|disposed|closed|connection/i);
			assert.equal(existsSync(marker), false);
			await waitFor("旧后台清理完成", () => api.hub.backendStatus?.pid !== originalPid);
			const choices = await api.hub.modelChoices();
			assert.ok(choices.models.some((model) => modelKey(model) === TEST_MODEL));
			assert.notEqual(api.hub.backendStatus?.pid, originalPid);
			const models = await vscode.lm.selectChatModels({ vendor: "pi-harness", id: TEST_MODEL });
			assert.equal(models.length, 1);
		} finally {
			rmSync(extensionFile, { force: true });
			rmSync(marker, { force: true });
		}
	});
});
