import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { parseSessionResource } from "../../src/sessions/sessionUri";
import {
	customData,
	env,
	fileHash,
	harness,
	openInSidebar,
	readEntries,
	runPiCli,
	sendInSidebar,
	sessionUri,
	sleep,
	startSession,
	waitFor,
	waitForIdle,
} from "./helpers";

function responseText(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn2): string {
	if (!(turn instanceof vscode.ChatResponseTurn2)) {
		return "";
	}
	return turn.response
		.map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""))
		.join("");
}

describe("会话列表和历史", () => {
	it("列出终端创建的会话，读取历史不改写会话文件", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_A");
		const sessionsDir = env("PI_HARNESS_TEST_SESSIONS");
		const before = new Set(readdirSync(sessionsDir));
		await runPiCli(api, workspace, ["-p", "Reply with exactly: HELLO-CLI"]);
		const created = readdirSync(sessionsDir).filter((name) => !before.has(name));
		assert.equal(created.length, 1);
		const sessionFile = join(sessionsDir, created[0]);

		await vscode.commands.executeCommand("piHarness.refreshSessions");
		const item = await waitFor("会话列表中的终端会话", () => {
			let found: vscode.ChatSessionItem | undefined;
			api.controller.items.forEach((candidate) => {
				if (candidate.label.startsWith("Reply with exactly: HELLO-CLI")) {
					found = candidate;
				}
			});
			return found;
		});
		const sessionId = parseSessionResource(item.resource);
		assert.ok(created[0].includes(sessionId), `会话 ID ${sessionId} 应出现在文件名 ${created[0]} 中`);
		const hashBefore = await fileHash(sessionFile);

		const state = await api.options.provide(item.resource, undefined);
		const content = await api.content.provideChatSessionContent(item.resource, new vscode.CancellationTokenSource().token, { inputState: state });
		assert.equal(content.history.length, 2);
		const request = content.history[0];
		assert.ok(request instanceof vscode.ChatRequestTurn2);
		assert.equal(request.prompt, "Reply with exactly: HELLO-CLI");
		assert.match(responseText(content.history[1]), /HELLO-CLI/);
		assert.equal(content.activeResponseCallback, undefined);

		await openInSidebar(sessionId);
		await sleep(3000);
		assert.equal(await fileHash(sessionFile), hashBefore, "打开历史后会话文件不应改变");
		assert.equal(api.hub.existingSession(sessionId)?.isRunning ?? false, false, "浏览历史不应启动 Pi 进程");
	});

	it("会话目录按 Pi 的规则确定，列出会话不创建目录", async () => {
		const api = await harness();
		const workspace = env("PI_HARNESS_TEST_WORKSPACE_B");
		const runtime = await api.hub.runtime();
		const catalog = await api.hub.sessionCatalog();
		const agentDir = join(env("PI_HARNESS_TEST_SESSIONS"), "..", "agent-dir");
		const savedSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const dir = await catalog.sessionDirFor(workspace);
			assert.deepEqual(await catalog.listFolder(workspace), []);
			assert.equal(existsSync(dir), false, "列出会话不应创建会话目录");
			const sessionManagerModule = (await import(pathToFileURL(join(runtime.packageDir, "dist", "core", "session-manager.js")).href)) as {
				getDefaultSessionDir: (cwd: string, agentDir: string) => string;
			};
			assert.equal(dir, sessionManagerModule.getDefaultSessionDir(workspace, agentDir));

			mkdirSync(join(workspace, ".pi"), { recursive: true });
			writeFileSync(join(workspace, ".pi", "settings.json"), `\uFEFF${JSON.stringify({ sessionDir: "project-sessions" })}`);
			assert.equal(await catalog.sessionDirFor(workspace), resolve(workspace, "project-sessions"));
		} finally {
			process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDir;
			if (savedAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = savedAgentDir;
			}
		}
	});

	it("重命名和删除本窗口创建的会话", async () => {
		const api = await harness();
		const sessionId = await startSession(api, "Reply with exactly: RENAME-ME");
		const sessionFile = await waitForIdle(api, sessionId);
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		const item = await waitFor("会话条目", () => api.controller.items.get(sessionUri(sessionId)));

		await vscode.commands.executeCommand("piHarness.renameSession", item, "改名后的会话");
		const infos = (await readEntries(api, sessionFile)).filter((entry) => entry.type === "session_info");
		assert.equal((infos.at(-1) as { name?: string } | undefined)?.name, "改名后的会话");
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		await waitFor("列表显示新名称", () => api.controller.items.get(sessionUri(sessionId))?.label === "改名后的会话");

		await sendInSidebar("Reply with exactly: STILL-HERE");
		await waitForIdle(api, sessionId);
		assert.equal(customData(await readEntries(api, sessionFile), "pi-harness.request").length, 2);

		await vscode.commands.executeCommand("piHarness.deleteSession", api.controller.items.get(sessionUri(sessionId)), true);
		assert.equal(existsSync(sessionFile), false, "删除后会话文件应移到回收站");
		await vscode.commands.executeCommand("piHarness.refreshSessions");
		await waitFor("列表移除已删除的会话", () => api.controller.items.get(sessionUri(sessionId)) === undefined);
	});
});
