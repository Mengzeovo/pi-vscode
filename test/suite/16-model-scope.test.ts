import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { BackendCommand } from "../../src/backend/protocol";
import { PiModelProvider, THINKING_LEVEL_KEY } from "../../src/chat/piModels";
import { modelKey } from "../../src/pi/catalog";
import type { RpcData } from "../../src/pi/rpcProcess";
import { folderKey } from "../../src/session/hub";
import { env, harness, lastAssistantText, readBranch, startSession, TEST_MODEL, waitFor, waitForIdle } from "./helpers";

const OTHER_MODEL = process.env.PI_HARNESS_TEST_OTHER_MODEL ?? "cliproxyapi/gpt-6-luna";
const TEST_PROVIDER = TEST_MODEL.slice(0, TEST_MODEL.indexOf("/"));
const MISSING_MODEL = "pi-harness-missing-provider/missing-model";

async function project(name: string, settings: Record<string, unknown>): Promise<{ cwd: string; file: string }> {
	const cwd = join(env("PI_HARNESS_TEST_WORK"), "model-scope", name, randomUUID());
	const file = join(cwd, ".pi", "settings.json");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(file, JSON.stringify(settings));
	return { cwd, file };
}

async function withWorkspaceSettings(action: (file: string) => Promise<void>): Promise<void> {
	const api = await harness();
	const file = join(env("PI_HARNESS_TEST_WORKSPACE_A"), ".pi", "settings.json");
	const original = existsSync(file) ? await readFile(file) : undefined;
	await mkdir(join(file, ".."), { recursive: true });
	try {
		await action(file);
	} finally {
		if (original) await writeFile(file, original);
		else await rm(file, { force: true });
		await api.hub.refreshChoices();
	}
}

async function selectableModels(): Promise<string[]> {
	return (await vscode.lm.selectChatModels({ vendor: "pi-harness" })).map((model) => model.id).sort();
}

async function updateWorkspaceFolders(start: number, deleteCount: number, ...folders: { uri: vscode.Uri }[]): Promise<void> {
	let changed = false;
	const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { changed = true; });
	try {
		assert.equal(vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...folders), true);
		await waitFor("工作目录变更事件", () => changed);
	} finally {
		subscription.dispose();
	}
}

describe("已保存 scoped-models", () => {
	it("精确范围控制目录和默认模型，思考级别与设置文件保持正确", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const slash = OTHER_MODEL.indexOf("/");
		const directory = await project("exact", { enabledModels: [`${TEST_MODEL}:high`, TEST_MODEL], defaultProvider: OTHER_MODEL.slice(0, slash), defaultModel: OTHER_MODEL.slice(slash + 1) });
		const before = await readFile(directory.file, "utf8");
		const runtime = await api.hub.runtime();
		const globalFile = join(runtime.modules.getAgentDir(), "settings.json");
		const globalBefore = await readFile(globalFile, "utf8");
		const catalog = await backend.catalog(directory.cwd, true, true);
		assert.deepEqual(catalog.models.map(modelKey), [TEST_MODEL]);
		assert.deepEqual(Object.keys(catalog.levels), [TEST_MODEL]);
		assert.equal(catalog.defaultModel, TEST_MODEL);
		assert.equal(catalog.defaultThinking, "high");
		assert.equal(await readFile(directory.file, "utf8"), before);
		assert.equal(await readFile(globalFile, "utf8"), globalBefore);
	});

	it("通配符、重复项和部分无匹配项使用 Pi 解析规则，空范围显示全部可用模型", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const directory = await project("patterns", { enabledModels: [] });
		const all = await backend.catalog(directory.cwd, true, true);
		assert.ok(all.models.some((model) => modelKey(model) === TEST_MODEL));
		assert.ok(all.models.some((model) => modelKey(model) === OTHER_MODEL));
		await writeFile(directory.file, JSON.stringify({ enabledModels: [`${TEST_PROVIDER}/*:low`, TEST_MODEL, MISSING_MODEL] }));
		const scoped = await backend.catalog(directory.cwd, true, true);
		assert.deepEqual(scoped.models.map(modelKey).sort(), all.models.filter((model) => model.provider === TEST_PROVIDER).map(modelKey).sort());
		assert.ok(scoped.models.length >= 2);
		assert.equal(scoped.defaultThinking, "low");
		await writeFile(directory.file, JSON.stringify({ enabledModels: [] }));
		assert.deepEqual((await backend.catalog(directory.cwd, true, true)).models.map(modelKey).sort(), all.models.map(modelKey).sort());
	});

	it("无匹配范围明确报错，修正设置后同一目录可以重新读取", async () => {
		const backend = await (await harness()).hub.backend();
		const directory = await project("unavailable", { enabledModels: [MISSING_MODEL] });
		await assert.rejects(backend.catalog(directory.cwd, true, true), /scoped-models 范围没有匹配到可用模型/);
		await writeFile(directory.file, JSON.stringify({ enabledModels: [OTHER_MODEL] }));
		const catalog = await backend.catalog(directory.cwd, true, true);
		assert.deepEqual(catalog.models.map(modelKey), [OTHER_MODEL]);
		assert.equal(catalog.defaultModel, OTHER_MODEL);
	});

	it("保存范围后刷新真实 VS Code 模型列表，失败刷新清除旧选项", async () => {
		const api = await harness();
		await withWorkspaceSettings(async (file) => {
			await writeFile(file, JSON.stringify({ enabledModels: [`${TEST_MODEL}:high`] }));
			await vscode.commands.executeCommand("piHarness.refreshModels");
			await waitFor("仅显示第一个已保存模型", async () => (await selectableModels()).join() === TEST_MODEL);
			const provider = new PiModelProvider(api.hub);
			const information = await provider.provideLanguageModelChatInformation();
			assert.deepEqual(information.map((model) => model.id), [TEST_MODEL]);
			assert.equal(information[0].isDefault, true);
			assert.equal(information[0].configurationSchema?.properties?.[THINKING_LEVEL_KEY].default, "high");
			await writeFile(file, JSON.stringify({ enabledModels: [OTHER_MODEL] }));
			await vscode.commands.executeCommand("piHarness.refreshModels");
			await waitFor("仅显示更新后的已保存模型", async () => (await selectableModels()).join() === OTHER_MODEL);
			await writeFile(file, JSON.stringify({ enabledModels: [MISSING_MODEL] }));
			await assert.rejects(api.hub.refreshChoices(), /scoped-models 范围没有匹配到可用模型/);
			await waitFor("无匹配时清除旧模型选项", async () => (await selectableModels()).length === 0);
			await writeFile(file, JSON.stringify({ enabledModels: [TEST_MODEL] }));
			await vscode.commands.executeCommand("piHarness.refreshModels");
			await waitFor("修正范围后恢复模型选项", async () => (await selectableModels()).join() === TEST_MODEL);
		});
	});

	it("会话初始化、模型轮换和重新加载使用已保存范围", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const directory = await project("session", { enabledModels: [`${TEST_MODEL}:high`, OTHER_MODEL] });
		const session = await api.hub.session(await api.hub.allocate(directory.cwd, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const request = async <T extends "get_state" | "cycle_model">(type: T): Promise<RpcData<T>> =>
				await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type } }) as RpcData<T>;
			const state = await request("get_state");
			assert.ok(state.model);
			assert.equal(modelKey(state.model), TEST_MODEL);
			assert.equal(state.thinkingLevel, "high");
			const second = await request("cycle_model");
			assert.ok(second?.isScoped);
			assert.equal(modelKey(second.model), OTHER_MODEL);
			const first = await request("cycle_model");
			assert.ok(first?.isScoped);
			assert.equal(modelKey(first.model), TEST_MODEL);
			await writeFile(directory.file, JSON.stringify({ enabledModels: [OTHER_MODEL] }));
			await session.reload();
			const catalog = await backend.catalog(directory.cwd, true, false, session.location.sessionId);
			assert.deepEqual(catalog.models.map(modelKey), [OTHER_MODEL]);
			assert.equal(catalog.defaultModel, OTHER_MODEL);
			assert.equal(await request("cycle_model"), null);
			const unchanged = await request("get_state");
			assert.ok(unchanged.model);
			assert.equal(modelKey(unchanged.model), TEST_MODEL);
		} finally {
			if (session.isRunning) await session.shutdown();
		}
	});

	it("多目录工作区合并各自保存的范围并去除重复项", async () => {
		const api = await harness();
		await withWorkspaceSettings(async (file) => {
			await writeFile(file, JSON.stringify({ enabledModels: [TEST_MODEL] }));
			const second = await project("workspace", { enabledModels: [OTHER_MODEL] });
			const uri = vscode.Uri.file(second.cwd);
			await updateWorkspaceFolders(1, 0, { uri });
			try {
				assert.equal(api.hub.folders().length, 2);
				await api.hub.refreshChoices();
				const choices = await api.hub.modelChoices();
				assert.deepEqual(choices.models.map(modelKey).sort(), [TEST_MODEL, OTHER_MODEL].sort());
				assert.equal(choices.defaults.get(folderKey(second.cwd))?.model, OTHER_MODEL);
				await writeFile(second.file, JSON.stringify({ enabledModels: [TEST_MODEL] }));
				await api.hub.refreshChoices();
				assert.deepEqual((await api.hub.modelChoices()).models.map(modelKey), [TEST_MODEL]);
			} finally {
				const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.toString() === uri.toString());
				assert.ok(index !== undefined && index >= 1);
				await updateWorkspaceFolders(index, 1);
				assert.equal(api.hub.folders().length, 1);
			}
		});
	});

	it("范围内模型通过真实 Chat 会话完成请求", async () => {
		const api = await harness();
		await withWorkspaceSettings(async (file) => {
			await writeFile(file, JSON.stringify({ enabledModels: [TEST_MODEL] }));
			await vscode.commands.executeCommand("piHarness.refreshModels");
			await waitFor("真实会话模型已显示", async () => (await selectableModels()).join() === TEST_MODEL);
			const sessionId = await startSession(api, "只回复 SCOPED-MODEL-OK，不要使用任何工具。");
			try {
				const branch = await readBranch(api, await waitForIdle(api, sessionId));
				assert.match(lastAssistantText(branch), /SCOPED-MODEL-OK/);
				const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
				assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
				assert.equal(`${assistant.message.provider}/${assistant.message.model}`, TEST_MODEL);
			} finally {
				await api.hub.existingSession(sessionId)?.shutdown();
			}
		});
	});
});
