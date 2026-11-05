// 界面测试驱动扩展：以正常方式启动的 VS Code 允许显示模态对话框（--extensionTestsPath 启动时 VS Code 拒绝显示），
// 由该扩展在扩展宿主中运行界面测试，把结果写入 PI_HARNESS_TEST_RESULTS 后退出 VS Code。
const { writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const vscode = require("vscode");

exports.activate = async function activate() {
	const suite = process.env.PI_HARNESS_UI_SUITE;
	const done = process.env.PI_HARNESS_UI_DONE;
	if (suite === undefined || done === undefined) {
		return;
	}
	let outcome;
	try {
		await require(suite).run();
		outcome = { ok: true };
	} catch (error) {
		outcome = { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
	}
	writeFileSync(done, JSON.stringify(outcome));
	const { workbench } = require(join(dirname(suite), "..", "ui-suite", "ui.js"));
	const page = await workbench();
	const confirmation = page.locator(".monaco-dialog-box").filter({ hasText: "A session is in progress. Are you sure you want to exit?" });
	try {
		await Promise.all([
			confirmation.waitFor({ state: "visible", timeout: 15_000 }).then(async () => {
				writeFileSync(join(dirname(done), "window-close.json"), JSON.stringify({ confirmedAt: new Date().toISOString(), text: await confirmation.innerText() }));
				await confirmation.locator(".dialog-buttons a.monaco-button").filter({ hasText: /^Yes$/ }).click();
			}),
			vscode.commands.executeCommand("workbench.action.closeWindow"),
		]);
	} catch (error) {
		if (page.isClosed()) return;
		writeFileSync(done, JSON.stringify({ ok: false, error: `测试窗口关闭失败：${error instanceof Error ? error.message : String(error)}` }));
		throw error;
	}
};

exports.deactivate = function deactivate() {};
