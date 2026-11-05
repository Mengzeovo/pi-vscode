import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import { REQUEST_ENTRY_TYPE, type RequestEntryData } from "../../shared/protocol";
import type { PiHarnessApi } from "../../src/extension";
import { parseSessionResource } from "../../src/sessions/sessionUri";
import { parseJson } from "../../src/util/json";
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
	startSession,
	userMessages,
	waitFor,
	waitForIdle,
} from "../suite/helpers";
import { chatView, dialogButton, dumpDom, inputText, notification, notificationButton, requestRow, requestRows, responseRow, workbench } from "./ui";

/** 界面操作失败时保存页面结构后再报告错误 */
async function step<T>(page: Page, name: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		await dumpDom(page, ".interactive-session", `ui-failure-${name}-chat`);
		await dumpDom(page, ".monaco-dialog-box, .notifications-toasts, .quick-input-widget", `ui-failure-${name}-overlays`);
		throw error;
	}
}

/** 等待会话中出现新的用户消息并且本轮结束，返回会话文件 */
async function waitForNewTurn(api: PiHarnessApi, sessionId: string, usersBefore: number): Promise<string> {
	return waitFor(
		`会话 ${sessionId} 完成新的一轮`,
		async () => {
			const session = api.hub.existingSession(sessionId);
			const location = await api.hub.locate(sessionId);
			if (!session || session.isBusy || location?.sessionFile === undefined || !existsSync(location.sessionFile)) {
				return undefined;
			}
			return userMessages(await readBranch(api, location.sessionFile)).length > usersBefore ? location.sessionFile : undefined;
		},
		300_000,
		500,
	);
}

/** 回答聊天内的一道题；提交后题目保留在页面中并标记为已使用 */
async function answerQuestion(page: Page, title: string, answer: (carousel: Locator) => Promise<void>): Promise<void> {
	const carousel = page.locator(".chat-question-carousel-container:not(.chat-question-carousel-used)", { hasText: title });
	await carousel.waitFor({ timeout: 120_000 });
	await answer(carousel);
	const submit = carousel.locator(".chat-question-submit-button");
	if (await submit.isVisible()) {
		await submit.click();
	}
	// 已回答的题目显示为摘要，摘要文字中的空格是不换行空格，按 aria-label 匹配
	await page.locator(`.chat-question-carousel-container.chat-question-carousel-used[aria-label*="${title}"]`).waitFor({ timeout: 30_000 });
}

/**
 * 用键盘把焦点移到聊天列表中倒数第 stepsFromLast + 1 项（最后一项为最后的回复）。
 * 点击请求的文字会进入编辑状态，请求行的标题区域不显示，因此从输入框按 Ctrl+Up 进入列表再用方向键移动。
 */
async function focusListItem(page: Page, stepsFromLast: number): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.chat.focusInput");
	await page.keyboard.press("Control+ArrowUp");
	for (let index = 0; index < stepsFromLast; index++) {
		await page.keyboard.press("ArrowUp");
	}
}

/**
 * 通过输入框的 Add Context... 附加一项：先选择类别（例如 Symbols...），需要时输入搜索文字，再点击含有指定文字的项。
 * 命令在选择结束后才返回，因此先发出命令，完成点击后再等待它结束。
 */
async function attachThroughPicker(page: Page, category: string, search: string | undefined, item: string): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.chat.focusInput");
	const picking = vscode.commands.executeCommand("workbench.action.chat.attachContext");
	const rows = page.locator(".quick-input-widget .quick-input-list .monaco-list-row");
	await rows.filter({ hasText: category }).first().click({ timeout: 30_000 });
	if (search !== undefined) {
		await page.keyboard.type(search);
	}
	await rows.filter({ hasText: item }).first().click({ timeout: 60_000 });
	await picking;
	await page.locator(".quick-input-widget").first().waitFor({ state: "hidden", timeout: 15_000 });
}

/** 编辑器区域中打开的无标题文档标签 */
function untitledTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "untitled");
}

/** 悬停在请求行上后点击检查点工具条中的 Fork Conversation */
async function forkFrom(page: Page, requestText: string): Promise<void> {
	const row = requestRow(page, requestText);
	await row.scrollIntoViewIfNeeded();
	await row.hover();
	await row.locator(".chat-fork-action-label").click();
}

describe("界面操作", () => {
	it("Pi 扩展的对话框：无超时的在聊天内回答，带超时的使用 QuickPick 并在到期时关闭", async () => {
		const api = await harness();
		const page = await workbench();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
		copyFileSync(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "dialogs-extension.ts"), join(workspace, ".pi", "extensions", "dialogs.ts"));
		const answers = join(workspace, "dialog-answers.json");
		const sessionId = await startSession(api, "/dialogs", false);
		await step(page, "dialogs", async () => {
			await answerQuestion(page, "Pick a fruit", (carousel) => carousel.locator(".chat-question-list-item", { hasText: "banana" }).click());
			await answerQuestion(page, "Proceed?", (carousel) => carousel.locator(".chat-question-list-item", { hasText: "是" }).click());
			// input 的提示文字和标题一起显示在题目中
			await answerQuestion(page, "Your name", (carousel) => carousel.locator("textarea, input").first().fill("Alice"));
			// editor 在无标题文档中编辑，用户在通知中点击“完成”
			await notificationButton(page, "完成").click({ timeout: 60_000 });
			const quickPick = page.locator(".quick-input-widget", { hasText: "Timed pick" });
			await quickPick.waitFor({ state: "visible", timeout: 60_000 });
			await quickPick.waitFor({ state: "hidden", timeout: 30_000 });
		});
		await waitFor("对话框回答写入文件", () => existsSync(answers), 60_000);
		assert.deepEqual(parseJson(readFileSync(answers, "utf8"), answers), { choice: "banana", confirmed: true, text: "Alice", edited: "prefilled note", timed: null });
		// editor 对话框结束后，用于编辑的无标题文档不保存直接关闭
		assert.equal(untitledTabs().length, 0);
		await waitFor("命令结束", () => !api.hub.existingSession(sessionId)?.isBusy);
	});

	it("继续终端创建的会话前确认其他写入方已关闭", async () => {
		const api = await harness();
		const page = await workbench();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const sessionsDir = env("PI_HARNESS_TEST_SESSIONS");
		const before = new Set(readdirSync(sessionsDir));
		await runPiCli(api, workspace, ["-p", "Reply with exactly: CLI-WRITER"]);
		const created = readdirSync(sessionsDir).filter((name) => !before.has(name));
		assert.equal(created.length, 1);
		const [header] = await readEntries(api, join(sessionsDir, created[0]));
		assert.ok(header.type === "session");
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		await openInSidebar(header.id);
		await sendInSidebar("Reply with exactly: AFTER-CONFIRM. Do not use any tools.", false);
		await step(page, "writers", async () => {
			await dialogButton(page, "已关闭，继续").click({ timeout: 60_000 });
		});
		const sessionFile = await waitForNewTurn(api, header.id, 1);
		assert.match(lastAssistantText(await readBranch(api, sessionFile)), /AFTER-CONFIRM/);
	});

	it("在输入框中附加文件、图片、符号和问题，Pi 收到全部附件", async () => {
		const api = await harness();
		const page = await workbench();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const facts = join(workspace, "facts.txt");
		writeFileSync(facts, "The secret code is FILE-TOKEN-5813.\n");
		// VS Code 安装中自带的蓝色图标
		const image = join(workspace, "logo.png");
		copyFileSync(join(vscode.env.appRoot, "resources", "win32", "code_150x150.png"), image);
		const shapes = join(workspace, "shapes.ts");
		writeFileSync(
			shapes,
			["export function computeArea(width: number, height: number): number {", "\treturn width * height;", "}", "", 'export const broken: number = "not a number";', ""].join("\n"),
		);
		const document = await vscode.workspace.openTextDocument(shapes);
		await vscode.window.showTextDocument(document);
		// VS Code 自带的 TypeScript 语言功能报告类型错误后，问题才出现在 Problems 中
		await waitFor(
			"TypeScript 报告类型错误",
			() => vscode.languages.getDiagnostics(document.uri).some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error && /not assignable/.test(diagnostic.message)),
			120_000,
		);

		await vscode.commands.executeCommand("workbench.action.chat.openNewSessionSidebar.pi-harness");
		const before = new Set(api.hub.createdSessionIds());
		await vscode.commands.executeCommand("workbench.action.chat.open", { attachFiles: [vscode.Uri.file(facts), vscode.Uri.file(image)] });
		const attachments = chatView(page).locator(".chat-attached-context-attachment");
		await step(page, "attach", async () => {
			await attachments.filter({ hasText: "facts.txt" }).waitFor({ timeout: 30_000 });
			await attachments.filter({ hasText: "logo.png" }).waitFor({ timeout: 30_000 });
			await attachThroughPicker(page, "Symbols...", "computeArea", "computeArea");
			await attachments.filter({ hasText: "computeArea" }).waitFor({ timeout: 30_000 });
			await attachThroughPicker(page, "Problems...", undefined, "Type 'string' is not assignable");
			await attachments.filter({ hasText: "Type 'string' is not" }).waitFor({ timeout: 30_000 });
		});
		const query =
			"Answer in the format CODE=<the secret code in the attached text file>; COLOR=<which of blue, red or green appears most in the attached image, as one lowercase word>; SYMBOL=<the name of the attached symbol>; ERROR=<the numeric error code of the attached problem>. Do not use any tools.";
		await sendInSidebar(query);
		const sessionId = await waitFor("新会话", () => api.hub.createdSessionIds().find((id) => !before.has(id)));
		const sessionFile = await waitForIdle(api, sessionId);
		const branch = await readBranch(api, sessionFile);
		const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(user?.type === "message" && user.message.role === "user" && Array.isArray(user.message.content));
		assert.ok(
			user.message.content.some((block) => block.type === "image"),
			"用户消息应包含图片",
		);
		const [text] = userMessages(branch).map((message) => message.text);
		assert.ok(text.startsWith(`${query}\n\n<vscode-context>`));
		assert.match(text, /<file path="[^"]*facts\.txt" unsaved="false">\nThe secret code is FILE-TOKEN-5813\./);
		assert.match(text, /<selection path="[^"]*shapes\.ts" lines="[^"]*" unsaved="false">\n[^<]*computeArea/);
		assert.match(text, /<diagnostics>\n[^\n]*shapes\.ts:5:\d+ \[error ts\(2322\)\] Type 'string' is not assignable to type 'number'\./);
		const [record] = customData<RequestEntryData>(await readEntries(api, sessionFile), REQUEST_ENTRY_TYPE);
		assert.deepEqual(record.references.map((reference) => reference.kind).sort(), ["diagnostic", "file", "image", "selection"]);
		const reply = lastAssistantText(branch);
		assert.match(reply, /CODE=FILE-TOKEN-5813/);
		assert.match(reply, /COLOR=blue/i);
		assert.match(reply, /SYMBOL=computeArea/);
		assert.match(reply, /ERROR=(TS)?2322/i);
		const shapesTab = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.find((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString());
		assert.ok(shapesTab);
		await vscode.window.tabGroups.close(shapesTab);
	});

	describe("分叉、还原、编辑请求和引用", () => {
		let sessionId: string;
		let target: string;

		before(async () => {
			const api = await harness();
			target = join(env("PI_HARNESS_TEST_WORKSPACE_A"), "fork.txt");
			sessionId = await startSession(api, "Use the write tool to create fork.txt with exactly the content: v1 (no trailing newline). Then reply with exactly: ONE");
			await waitForIdle(api, sessionId);
			assert.equal(readFileSync(target, "utf8").trim(), "v1");
			await sendInSidebar("Use the write tool to overwrite fork.txt with exactly the content: v2 (no trailing newline). Then reply with exactly: TWO");
			await waitForIdle(api, sessionId);
			assert.equal(readFileSync(target, "utf8").trim(), "v2");
			await sendInSidebar("Use the write tool to overwrite fork.txt with exactly the content: v3 (no trailing newline). Then reply with exactly: QUOTE-ME #tag /path @user");
			await waitForIdle(api, sessionId);
			assert.equal(readFileSync(target, "utf8").trim(), "v3");
		});

		it("从第二条请求分叉并恢复文件，原请求可以填回输入框", async () => {
			const api = await harness();
			const page = await workbench();
			const itemsBefore = new Set<string>();
			api.controller.items.forEach((item) => itemsBefore.add(item.resource.toString()));
			await step(page, "fork-restore", async () => {
				await forkFrom(page, "content: v2");
				await dialogButton(page, "恢复文件并分叉").click({ timeout: 30_000 });
			});
			await waitFor("文件恢复到第二轮之前", () => readFileSync(target, "utf8").trim() === "v1", 30_000);
			const forked = await waitFor("分叉出的会话", () => {
				let found: string | undefined;
				api.controller.items.forEach((item) => {
					if (!itemsBefore.has(item.resource.toString())) {
						found = parseSessionResource(item.resource);
					}
				});
				return found;
			});
			const location = await api.hub.locate(forked);
			assert.ok(location?.sessionFile);
			const forkedUsers = userMessages(await readBranch(api, location.sessionFile));
			assert.equal(forkedUsers.length, 1);
			assert.match(forkedUsers[0].text, /content: v1/);
			await step(page, "fork-prompt", async () => {
				await notificationButton(page, "把原请求填入输入框").click({ timeout: 30_000 });
				await waitFor("输入框出现原请求", async () => (await inputText(page)).includes("content: v2"), 30_000);
			});
		});

		it("只分叉时文件保持不变", async () => {
			const page = await workbench();
			await openInSidebar(sessionId);
			const before = readFileSync(target, "utf8");
			await step(page, "fork-only", async () => {
				await requestRow(page, "content: v3").waitFor({ timeout: 30_000 });
				await forkFrom(page, "content: v3");
				await dialogButton(page, "只分叉").click({ timeout: 30_000 });
				await notification(page, "已从这条请求之前分叉出新会话").waitFor({ timeout: 30_000 });
			});
			assert.equal(readFileSync(target, "utf8"), before);
		});

		it("在 Pi 会话的请求上按 Delete 只显示提示，请求和文件不变", async () => {
			const page = await workbench();
			await openInSidebar(sessionId);
			const before = readFileSync(target, "utf8");
			await step(page, "delete", async () => {
				await requestRow(page, "content: v1").waitFor({ timeout: 30_000 });
				// 列表项依次为请求 1、回复 1、请求 2、回复 2、请求 3、回复 3
				await focusListItem(page, 5);
				await page.keyboard.press("Delete");
				await notification(page, "Pi 会话不使用 VS Code 的还原检查点").waitFor({ timeout: 15_000 });
			});
			assert.equal(await requestRows(page).count(), 3);
			assert.equal(readFileSync(target, "utf8"), before);
		});

		it("选中回复中的文字后按 Ctrl+Alt+Q 引用到输入框，剪贴板保持原样", async () => {
			const page = await workbench();
			await openInSidebar(sessionId);
			await vscode.env.clipboard.writeText("ORIGINAL-CLIPBOARD");
			await step(page, "quote", async () => {
				const response = responseRow(page, "QUOTE-ME");
				await response.waitFor({ timeout: 30_000 });
				await focusListItem(page, 0);
				await response.evaluate((row) => {
					const paragraph = row.querySelector(".rendered-markdown p");
					if (!paragraph) {
						throw new Error("回复中没有文字段落");
					}
					const range = document.createRange();
					range.selectNodeContents(paragraph);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				});
				await page.keyboard.press("Control+Alt+KeyQ");
				await waitFor("输入框出现引用", async () => (await inputText(page)).includes("> QUOTE-ME #tag /path @user"), 15_000);
			});
			assert.equal(await vscode.env.clipboard.readText(), "ORIGINAL-CLIPBOARD");

			await step(page, "quote-empty", async () => {
				await focusListItem(page, 0);
				await page.evaluate(() => window.getSelection()?.removeAllRanges());
				await page.keyboard.press("Control+Alt+KeyQ");
				await notification(page, "请先在 Pi 的回复中选中要引用的文字").waitFor({ timeout: 15_000 });
			});
			assert.equal(await vscode.env.clipboard.readText(), "ORIGINAL-CLIPBOARD");
		});

		it("在请求上按 Enter 编辑后提交，Pi 会话追加这条消息", async () => {
			const api = await harness();
			const page = await workbench();
			await openInSidebar(sessionId);
			const location = await api.hub.locate(sessionId);
			assert.ok(location?.sessionFile);
			const before = userMessages(await readBranch(api, location.sessionFile));
			assert.equal(before.length, 3);
			const edited = "Reply with exactly: EDITED-REQUEST. Do not use any tools.";
			await step(page, "edit-request", async () => {
				await requestRow(page, "content: v3").waitFor({ timeout: 30_000 });
				await focusListItem(page, 1);
				await page.keyboard.press("Enter");
				const editor = page.locator(".interactive-session .interactive-request.editing .interactive-input-editor").first();
				await editor.waitFor({ timeout: 15_000 });
				await editor.click();
				await page.keyboard.press("Control+A");
				await page.keyboard.type(edited);
				await page.keyboard.press("Enter");
				// VS Code 确认移除该请求并撤销其中的文件修改
				await dialogButton(page, "Yes").click({ timeout: 30_000 });
			});
			const sessionFile = await waitFor(
				"编辑后的请求完成",
				async () => {
					if (api.hub.existingSession(sessionId)?.isBusy !== false) {
						return undefined;
					}
					const users = userMessages(await readBranch(api, location.sessionFile as string));
					return users.at(-1)?.text.startsWith(edited) === true ? location.sessionFile : undefined;
				},
				300_000,
				500,
			);
			const branch = await readBranch(api, sessionFile);
			const users = userMessages(branch);
			// Pi 的当前分支退回到第三条请求之前，编辑后的请求接在第二轮之后
			assert.deepEqual(
				users.map((user) => user.id),
				[before[0].id, before[1].id, users[2].id],
			);
			// 编辑后的请求可能附带 VS Code 的文件变更事件（上下文块）
			assert.ok(users[2].text.startsWith(edited));
			console.log(`[测试] 编辑后的用户消息：${users[2].text}`);
			assert.match(lastAssistantText(branch), /EDITED-REQUEST/);
			assert.equal(await (await api.hub.backend()).pendingRecovery(sessionId, sessionFile), undefined, "编辑请求的恢复记录必须完成");
			// VS Code 撤销了第三条请求中 Pi 的写入，文件回到第三条请求开始时的内容
			assert.equal(readFileSync(target, "utf8").trim(), "v2");
			await waitFor("列表不再显示被编辑的请求", async () => (await requestRow(page, "content: v3").count()) === 0, 30_000);
		});

		it("恢复完成后后台退出，保留输入及图片在明确发送后保存一次", async () => {
			const api = await harness();
			const page = await workbench();
			const session = api.hub.existingSession(sessionId);
			const location = await api.hub.locate(sessionId);
			assert.ok(session && location?.sessionFile);
			const branch = await readBranch(api, location.sessionFile);
			const targetUser = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
			assert.ok(targetUser?.type === "message");
			const original = customData<RequestEntryData>(await readEntries(api, location.sessionFile), REQUEST_ENTRY_TYPE).find((record) => record.userEntryId === targetUser.id);
			assert.ok(original);
			const imageFile = join(vscode.env.appRoot, "resources", "win32", "code_150x150.png");
			const imageData = readFileSync(imageFile).toString("base64");
			const contextBlock = "<vscode-context>\n<attachment name=\"保留的文字\">RECOVERY-CONTEXT-3182</attachment>\n</vscode-context>";
			const prompt = "Reply with exactly: RECOVERY-INPUT-7412. Do not use any tools.";
			await session.rewindBefore(targetUser.id, targetUser.parentId, {
				requestId: randomUUID(), promptText: `${prompt}\n\n${contextBlock}`, userText: prompt, basePrompt: prompt, contextBlock,
				references: [{ kind: "other", id: "recovery-text", name: "保留的文字" }, { kind: "image", id: "recovery-image", name: "Code 图标", uri: vscode.Uri.file(imageFile).toString() }],
				images: [{ type: "image", data: imageData, mimeType: "image/png" }], enabledCopilotTools: [], selection: undefined,
			}, [original.requestId]);
			const backend = await api.hub.backend();
			const pending = await backend.pendingRecovery(sessionId, location.sessionFile);
			assert.equal(pending?.stage, "restored");
			assert.ok(backend.pid);
			process.kill(backend.pid);
			await waitFor("恢复测试后台结束并释放权限", () => !session.isRunning && !session.holdsWritePermission);
			await vscode.commands.executeCommand("piHarness.restoreInput", sessionId, pending!.operationId);
			await waitFor("恢复文字进入实际输入框", async () => (await inputText(page)).includes(prompt));
			const before = userMessages(await readBranch(api, location.sessionFile)).length;
			await vscode.commands.executeCommand("workbench.action.chat.focusInput");
			await page.keyboard.press("Enter");
			const file = await waitForNewTurn(api, sessionId, before);
			const after = await readBranch(api, file);
			const users = userMessages(after);
			assert.equal(users.length, before + 1);
			assert.match(users.at(-1)!.text, /RECOVERY-CONTEXT-3182/);
			assert.equal(users.at(-1)!.text.split("RECOVERY-CONTEXT-3182").length - 1, 1);
			const user = [...after].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
			assert.ok(user?.type === "message" && user.message.role === "user" && Array.isArray(user.message.content));
			const images = user.message.content.filter((part) => part.type === "image");
			assert.equal(images.length, 1);
			assert.equal(images[0].data, imageData);
			assert.match(lastAssistantText(after), /RECOVERY-INPUT-7412/);
			assert.equal(await backend.pendingRecovery(sessionId, file), undefined);
		});
	});
});
