import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { EXTENSION_ID } from "../suite/helpers";

describe("缺少实验接口授权", () => {
	it("没有 --enable-proposed-api 时扩展不能使用实验接口，Pi 会话类型不可用", async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, "扩展已安装");
		await assert.rejects(
			async () => extension.activate(),
			(error: Error) => {
				console.log(`[测试] 激活错误：${error.message}`);
				return /proposed|enable-proposed-api|chatSessionsProvider/i.test(error.message);
			},
		);
		const commands = await vscode.commands.getCommands(true);
		assert.equal(commands.includes("workbench.action.chat.openNewSessionSidebar.pi-harness"), false, "未授权时不注册 Pi 会话类型的命令");
	});
});
