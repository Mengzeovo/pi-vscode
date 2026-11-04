import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { modelKey } from "../../src/pi/catalog";
import { env, harness, TEST_MODEL } from "./helpers";

/** 标记文件存在时删除它并以退出码 9 结束 Pi 进程：下一个在该目录启动的 Pi 进程在加载扩展时退出，之后的进程正常启动 */
const CRASH_ONCE_EXTENSION = [
	'import { existsSync, unlinkSync } from "node:fs";',
	'import { join } from "node:path";',
	'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
	"",
	"export default function (_pi: ExtensionAPI) {",
	'\tconst marker = join(process.cwd(), "crash-once.marker");',
	"\tif (existsSync(marker)) {",
	"\t\tunlinkSync(marker);",
	"\t\tprocess.exit(9);",
	"\t}",
	"}",
	"",
].join("\n");

describe("模型列表", () => {
	it("读取模型列表的 Pi 进程启动时异常退出后，下一次读取重新启动 Pi 并取得模型", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		// 等前一个测试刷新后开始的读取结束，此后只有本测试在该目录启动 Pi
		await api.hub.modelChoices();
		const extensionFile = join(workspace, ".pi", "extensions", "crash-once.ts");
		const marker = join(workspace, "crash-once.marker");
		mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
		writeFileSync(extensionFile, CRASH_ONCE_EXTENSION);
		writeFileSync(marker, "");
		try {
			// 刷新后的第一次读取启动的 Pi 进程加载上面的扩展后退出
			await api.hub.refreshChoices();
			await assert.rejects(api.hub.modelChoices(), /模型列表.*已退出，退出码 9，/s);
			assert.equal(existsSync(marker), false);
			// 失败的结果不保留：下一次读取重新启动 Pi
			const choices = await api.hub.modelChoices();
			assert.ok(choices.models.some((model) => modelKey(model) === TEST_MODEL));
			// VS Code 再次读取模型时取得 Pi 的模型，不需要用户手动刷新
			const models = await vscode.lm.selectChatModels({ vendor: "pi-harness", id: TEST_MODEL });
			assert.equal(models.length, 1);
		} finally {
			rmSync(extensionFile, { force: true });
			rmSync(marker, { force: true });
		}
	});
});
