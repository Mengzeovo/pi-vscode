import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { COPILOT_TOOL_NAMES, EDIT_ENTRY_TYPE, type EditEntryData } from "../../shared/protocol";
import { parseSessionResource } from "../../src/sessions/sessionUri";
import {
	customData,
	env,
	EXTENSION_ID,
	harness,
	lastAssistantText,
	readBranch,
	readEntries,
	sendInSidebar,
	sessionUri,
	sleep,
	startSession,
	TEST_MODEL,
	toolCalls,
	userMessages,
	waitFor,
	waitForBusy,
	waitForIdle,
} from "../suite/helpers";
import { dialogButton, inputText, notificationButton, requestRow, responseRow, workbench } from "../ui-suite/ui";

interface StepRecord {
	readonly step: string;
	readonly expected: string;
	readonly actual: string;
	readonly passed: boolean | "未执行";
}

const records: StepRecord[] = [];
const sessions: Record<string, string> = {};

function record(step: string, expected: string, actual: string, passed: boolean | "未执行"): void {
	records.push({ step, expected, actual, passed });
}

describe("安装验收", () => {
	after(() => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		writeFileSync(
			join(env("PI_HARNESS_TEST_WORK"), "acceptance.json"),
			JSON.stringify(
				{
					vscodeVersion: vscode.version,
					extensionVersion: extension?.packageJSON.version,
					extensionPath: extension?.extensionPath,
					model: TEST_MODEL,
					sessions,
					records,
				},
				null,
				2,
			),
		);
	});

	it("扩展从 VSIX 安装并通过 argv.json 授权", async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension);
		const api = await harness();
		const runtime = await api.hub.runtime();
		const manifest = JSON.parse(readFileSync(join(runtime.packageDir, "package.json"), "utf8"));
		// 便携数据目录即本次验收目录，扩展应当从其中的 extensions 目录加载
		const installed = extension.extensionPath.toLowerCase().startsWith(join(env("PI_HARNESS_TEST_WORK"), "extensions").toLowerCase());
		record("安装与授权", "扩展从便携数据目录的 extensions 中加载，实验接口可用，加载当前安装的 Pi", `扩展目录 ${extension.extensionPath}；Pi ${runtime.version}；node ${runtime.nodeVersion}`, installed && runtime.version === manifest.version);
		assert.ok(installed);
		assert.equal(runtime.version, manifest.version);
	});

	it("附加选区、Pi 修改文件、打开差异", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const path = join(workspace, "calc.ts");
		writeFileSync(path, ["export function add(a: number, b: number): number {", "\treturn a - b;", "}", ""].join("\n"));
		const document = await vscode.workspace.openTextDocument(path);
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
		const before = new Set(api.hub.createdSessionIds());
		await vscode.commands.executeCommand("workbench.action.chat.open", {
			query: "The attached function has a bug. Use the edit tool to fix it in calc.ts, then reply with exactly: FIXED",
			attachFiles: [{ uri: document.uri, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 2 } }],
			modelSelector: { vendor: "pi-harness", id: TEST_MODEL },
			blockOnResponse: true,
		});
		const sessionId = api.hub.createdSessionIds().find((id) => !before.has(id));
		assert.ok(sessionId);
		sessions["附加选区并修改文件"] = sessionId;
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const user = userMessages(branch)[0];
		const attached = user.text.includes("<selection") && user.text.includes("return a - b;");
		record("附加选区", "Pi 收到的用户消息包含选区文字", attached ? "用户消息的 <vscode-context> 中包含 calc.ts 第 1-3 行" : user.text.slice(0, 200), attached);

		const content = readFileSync(path, "utf8");
		const edits = customData<EditEntryData>(await readEntries(api, sessionFile), EDIT_ENTRY_TYPE);
		const fixed = content.includes("return a + b;") && edits.length === 1;
		record("Pi 修改文件", "calc.ts 中的 a - b 改为 a + b，会话中有一条 pi-harness.edit 记录", `文件第 2 行：${content.split("\n")[1].trim()}；修改记录 ${edits.length} 条；工具调用 ${toolCalls(branch).map((call) => call.name).join(", ")}`, fixed);

		await vscode.commands.executeCommand("piHarness.openDiff", sessionId, edits[0].toolCallId);
		const diffTab = await waitFor("差异编辑器", () =>
			vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "pi-harness-snapshot"),
		);
		const input = diffTab.input as vscode.TabInputTextDiff;
		const original = (await vscode.workspace.openTextDocument(input.original)).getText();
		const modified = (await vscode.workspace.openTextDocument(input.modified)).getText();
		record("打开差异", "差异左侧为修改前的内容，右侧为修改后的内容", `左侧含 a - b：${original.includes("a - b")}；右侧含 a + b：${modified.includes("a + b")}`, original.includes("a - b") && modified.includes("a + b"));
		await vscode.window.tabGroups.close(diffTab);
		assert.ok(attached && fixed);
	});

	it("Pi 调用 Copilot 查询工具", async () => {
		const present = COPILOT_TOOL_NAMES.filter((name) => vscode.lm.tools.some((tool) => tool.name === name));
		if (present.length === 0) {
			record("Copilot 查询工具", "Pi 调用 copilot_searchWorkspaceSymbols 并返回项目中的符号", "验收环境没有登录 GitHub Copilot，vscode.lm.tools 中没有 Copilot 工具", "未执行");
			return;
		}
		const api = await harness();
		const sessionId = await startSession(api, "Use the copilot_searchWorkspaceSymbols tool to find the symbol add, then reply with the file name that defines it.");
		sessions["Copilot 工具"] = sessionId;
		const branch = await readBranch(api, await waitForIdle(api, sessionId));
		const used = toolCalls(branch).some((call) => call.name === "copilot_searchWorkspaceSymbols");
		const passed = used && /calc\.ts/.test(lastAssistantText(branch));
		record("Copilot 查询工具", "Pi 调用 copilot_searchWorkspaceSymbols 并返回项目中的符号", `调用：${used}；回复：${lastAssistantText(branch)}`, passed);
		assert.ok(passed);
	});

	it("引用回复中的文字继续提问", async () => {
		const api = await harness();
		const page = await workbench();
		const sessionId = await startSession(api, "Reply with exactly: QUOTE-THIS-LINE. Do not use any tools.");
		sessions["引用回复"] = sessionId;
		await waitForIdle(api, sessionId);
		const probe = `clipboard-probe-${Date.now()}`;
		await vscode.env.clipboard.writeText(probe);
		if ((await vscode.env.clipboard.readText()) !== probe) {
			record("引用回复", "选中回复文字后按 Ctrl+Alt+Q，输入框出现引用", "验收环境的系统剪贴板不可读写（Windows 拒绝访问剪贴板），引用依赖剪贴板，未能执行", "未执行");
			return;
		}
		const response = responseRow(page, "QUOTE-THIS-LINE");
		await response.waitFor({ timeout: 30_000 });
		await vscode.commands.executeCommand("workbench.action.chat.focusInput");
		await page.keyboard.press("Control+ArrowUp");
		await response.evaluate((row) => {
			const range = document.createRange();
			range.selectNodeContents(row.querySelector(".rendered-markdown p") as Node);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		});
		await page.keyboard.press("Control+Alt+KeyQ");
		await sleep(2000);
		const text = await inputText(page);
		const clipboard = await vscode.env.clipboard.readText();
		const passed = text.includes("> QUOTE-THIS-LINE") && clipboard === probe;
		record("引用回复", "输入框出现 > QUOTE-THIS-LINE，剪贴板恢复为引用前的文字", `输入框：${JSON.stringify(text)}；剪贴板恢复：${clipboard === probe}`, passed);
		assert.ok(passed);
	});

	it("从第二条请求分叉并恢复文件", async () => {
		const api = await harness();
		const page = await workbench();
		const target = join(env("PI_HARNESS_TEST_WORKSPACE_A"), "steps.txt");
		const sessionId = await startSession(api, "Use the write tool to create steps.txt with exactly the content: one (no trailing newline). Then reply with exactly: DONE-ONE");
		sessions["分叉源会话"] = sessionId;
		await waitForIdle(api, sessionId);
		await sendInSidebar("Use the write tool to overwrite steps.txt with exactly the content: two (no trailing newline). Then reply with exactly: DONE-TWO");
		await waitForIdle(api, sessionId);
		const beforeFork = readFileSync(target, "utf8").trim();
		const itemsBefore = new Set<string>();
		api.controller.items.forEach((item) => itemsBefore.add(item.resource.toString()));
		const row = requestRow(page, "content: two");
		await row.waitFor({ timeout: 30_000 });
		await row.hover();
		await row.locator(".chat-fork-action-label").click();
		await dialogButton(page, "恢复文件并分叉").click({ timeout: 30_000 });
		await waitFor("文件恢复", () => readFileSync(target, "utf8").trim() === "one", 30_000);
		const forked = await waitFor("分叉会话", () => {
			let found: string | undefined;
			api.controller.items.forEach((item) => {
				if (!itemsBefore.has(item.resource.toString())) {
					found = parseSessionResource(item.resource);
				}
			});
			return found;
		});
		sessions["分叉出的会话"] = forked;
		const location = await api.hub.locate(forked);
		const forkedUsers = location?.sessionFile ? userMessages(await readBranch(api, location.sessionFile)).length : -1;
		await notificationButton(page, "把原请求填入输入框").click({ timeout: 30_000 });
		const refilled = await waitFor("输入框出现原请求", async () => (await inputText(page)).includes("content: two") || undefined, 30_000).catch(() => false);
		const passed = readFileSync(target, "utf8").trim() === "one" && forkedUsers === 1 && refilled === true;
		record("分叉并恢复文件", "steps.txt 恢复为第二轮之前的 one，新会话只含第一轮，原请求填回输入框", `分叉前 ${beforeFork}，分叉后 ${readFileSync(target, "utf8").trim()}；新会话用户消息 ${forkedUsers} 条；输入框填回：${refilled}`, passed);
		assert.ok(passed);
	});

	it("Pi 运行期间开始修改的文件得到保留", async () => {
		const api = await harness();
		const path = join(env("PI_HARNESS_TEST_WORKSPACE_A"), "draft.txt");
		writeFileSync(path, "first line\nsecond line\n");
		const sessionId = await startSession(
			api,
			"First use the bash tool to run exactly: node -e \"setTimeout(() => {}, 12000)\". After it finishes, use the edit tool once to replace 'first line' with 'FIRST LINE' in draft.txt. Do not retry and do not use any other tool. If the edit tool reports an error, reply with exactly: BLOCKED",
			false,
		);
		sessions["未保存修改"] = sessionId;
		await waitForBusy(api, sessionId);
		await sleep(4000);
		const document = await vscode.workspace.openTextDocument(path);
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((builder) => builder.replace(document.lineAt(1).range, "typed during the run"));
		const sessionFile = await waitForIdle(api, sessionId);
		const disk = readFileSync(path, "utf8");
		const kept = disk === "first line\nsecond line\n" && document.isDirty && document.lineAt(1).text === "typed during the run";
		record("保护未保存修改", "磁盘内容不变，编辑器中未保存的输入保留，Pi 的 edit 返回错误", `磁盘：${JSON.stringify(disk)}；编辑器第 2 行：${document.lineAt(1).text}；未保存：${document.isDirty}；回复：${lastAssistantText(await readBranch(api, sessionFile))}`, kept);
		await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
		assert.ok(kept);
	});

	it("在终端中继续同一会话", async () => {
		const api = await harness();
		const sessionId = sessions["分叉源会话"];
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		const item = await waitFor("会话条目", () => api.controller.items.get(sessionUri(sessionId)));
		await vscode.commands.executeCommand("piHarness.continueInTerminal", item);
		const terminal = await waitFor("终端", () => vscode.window.terminals.find((candidate) => candidate.name.startsWith("Pi · ")));
		const options = terminal.creationOptions as vscode.TerminalOptions;
		const location = await api.hub.locate(sessionId);
		await sleep(8000);
		const passed = options.shellArgs?.includes(location?.sessionFile ?? "-") === true && api.hub.existingSession(sessionId)?.isRunning !== true;
		record("在终端中继续", "所属会话关闭并释放写入权限，终端以 --session 打开同一会话文件", `终端参数：${JSON.stringify(options.shellArgs)}；VS Code 中该会话运行：${api.hub.existingSession(sessionId)?.isRunning ?? false}`, passed);
		terminal.dispose();
		assert.ok(passed);
	});
});
