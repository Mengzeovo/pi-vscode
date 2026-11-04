import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { parseJson } from "../../src/util/json";
import { env, harness, lastAssistantText, openInSidebar, readBranch, sendInSidebar, sessionUri, startSession, userMessages, waitFor, waitForIdle } from "../suite/helpers";
import { dialogButton, requestRow, workbench } from "../ui-suite/ui";

const phase = process.env.PI_HARNESS_UI_PHASE;
const stateFile = (): string => join(env("PI_HARNESS_TEST_WORK"), "reopen.json");

describe("重新打开窗口", () => {
	if (phase === "first") {
		it("第一次启动：新建会话并收到回复", async () => {
			const api = await harness();
			const sessionId = await startSession(api, "Reply with exactly: BEFORE-RELOAD. Do not use any tools.");
			const sessionFile = await waitForIdle(api, sessionId);
			assert.match(lastAssistantText(await readBranch(api, sessionFile)), /BEFORE-RELOAD/);
			writeFileSync(stateFile(), JSON.stringify({ sessionId, sessionFile }));
		});
	}

	if (phase === "second") {
		it("重新启动后：会话出现在列表中，打开历史并继续同一会话", async () => {
			const api = await harness();
			const page = await workbench();
			const { sessionId, sessionFile } = parseJson<{ sessionId: string; sessionFile: string }>(readFileSync(stateFile(), "utf8"), stateFile());
			await vscode.commands.executeCommand("piHarness.refreshSessions");
			const item = await waitFor("会话列表中的会话", () => api.controller.items.get(sessionUri(sessionId)));
			assert.match(item.label, /BEFORE-RELOAD/);
			await openInSidebar(sessionId);
			await requestRow(page, "BEFORE-RELOAD").waitFor({ timeout: 30_000 });
			await sendInSidebar("Reply with exactly: AFTER-RELOAD. Do not use any tools.", false);
			// 会话不是在本窗口创建的，第一次写入前确认其他写入方已关闭
			await dialogButton(page, "已关闭，继续").click({ timeout: 60_000 });
			await waitFor(
				"继续同一会话",
				async () => {
					if (api.hub.existingSession(sessionId)?.isBusy !== false) {
						return undefined;
					}
					return userMessages(await readBranch(api, sessionFile)).length === 2 || undefined;
				},
				300_000,
				500,
			);
			const location = await api.hub.locate(sessionId);
			assert.equal(location?.sessionFile, sessionFile);
			assert.match(lastAssistantText(await readBranch(api, sessionFile)), /AFTER-RELOAD/);
		});
	}
});
