import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommitIdentity } from "../../shared/protocol";
import { BackendCommand, BackendReload, BackendSubscribe, BackendUnsubscribe } from "../../src/backend/protocol";
import type { PiSession } from "../../src/session/piSession";
import { canonicalFilePath, OperationStore } from "../../src/backend/operationStore";
import { env, harness, readEntries, TEST_MODEL, toolCalls, waitFor } from "./helpers";

async function waitForChildFile(session: PiSession, file: string): Promise<void> {
	const api = await harness();
	await waitFor("实际子任务写入文件", async () => {
		if (existsSync(file)) return true;
		const failed = (await readEntries(api, session.location.sessionFile!)).find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent" && entry.message.isError);
		if (failed?.type === "message" && failed.message.role === "toolResult") throw new Error(`实际 subagent 调用失败：${JSON.stringify(failed.message.content)}`);
		return undefined;
	}, 600_000);
}

describe("共享后台驻留与重新加载", () => {
	it("目录查询和空白重新加载保持模型默认设置，目录查询不创建持久会话", async () => {
		const api = await harness(); const backend = await api.hub.backend(); const runtime = await api.hub.runtime();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-catalog", randomUUID());
		await mkdir(join(directory, ".pi"), { recursive: true });
		const [provider, ...model] = TEST_MODEL.split("/");
		const projectFile = join(directory, ".pi", "settings.json");
		await writeFile(projectFile, JSON.stringify({ defaultProvider: provider, defaultModel: model.join("/"), defaultThinkingLevel: "low", enabledModels: [TEST_MODEL] }));
		const globalFile = join(runtime.modules.getAgentDir(), "settings.json");
		const defaults = async (path: string) => {
			const data = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> : {};
			return { defaultProvider: data.defaultProvider, defaultModel: data.defaultModel, defaultThinkingLevel: data.defaultThinkingLevel, modelThinkingLevels: data.modelThinkingLevels, enabledModels: data.enabledModels };
		};
		const before = { global: await defaults(globalFile), project: await defaults(projectFile) };
		const sessionDir = await (await api.hub.sessionCatalog()).sessionDirFor(directory);
		const filesBefore = existsSync(sessionDir) ? await readdir(sessionDir) : [];
		const catalog = await backend.catalog(directory, true, true);
		assert.equal(catalog.defaultModel, TEST_MODEL);
		assert.deepEqual(existsSync(sessionDir) ? await readdir(sessionDir) : [], filesBefore);
		assert.deepEqual({ global: await defaults(globalFile), project: await defaults(projectFile) }, before);
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try { await session.reload(); await session.reload(); }
		finally { if (session.isRunning) await session.shutdown(); }
		assert.deepEqual({ global: await defaults(globalFile), project: await defaults(projectFile) }, before);
		assert.equal((await readEntries(api, session.location.sessionFile!)).filter((entry) => entry.type === "message").length, 0);
		await writeFile(join(directory, "results.json"), JSON.stringify({ before, after: { global: await defaults(globalFile), project: await defaults(projectFile) }, catalog, filesBefore }, null, 2));
	});

	it("12 个真实会话共用进程，保留订阅并释放最早空闲会话", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		for (const entry of backend.snapshot?.sessions ?? []) {
			assert.equal(entry.busy, false, `此前会话仍在运行：${entry.sessionId}`);
			await api.hub.existingSession(entry.sessionId)?.shutdown();
		}
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-residency", randomUUID());
		await mkdir(directory, { recursive: true });
		const sessions: PiSession[] = [];
		const ids: string[] = [];
		const observations: unknown[] = [];
		let pid: number | undefined;
		try {
			for (let index = 0; index < 12; index++) {
				const id = randomUUID(); ids.push(id);
				const session = await api.hub.session(await api.hub.allocate(directory, id));
				sessions.push(session);
				await session.reload();
				pid ??= session.processId;
				assert.equal(session.processId, pid);
				const identity = { generationId: backend.generationId!, sessionId: id };
				if (index === 0) await backend.request(BackendSubscribe, { ...identity, subscriptionId: "residency-protected" });
				await backend.request(BackendUnsubscribe, { ...identity, subscriptionId: `view:${id}` });
				observations.push({ id, pid: session.processId, location: await api.hub.locate(id) });
				await writeFile(join(directory, "residency-progress.json"), JSON.stringify({ ids, observations, snapshot: backend.snapshot }, null, 2));
			}
			const snapshot = await waitFor("超过驻留数量后的会话释放", async () => {
				const current = backend.snapshot;
				await writeFile(join(directory, "residency-current.json"), JSON.stringify({ ids, snapshot: current }, null, 2));
				return current?.sessions.length === 10 && !current.sessions.some((entry) => entry.sessionId === ids[1] || entry.sessionId === ids[2]) ? current : undefined;
			}, 90_000);
			assert.ok(snapshot.sessions.some((entry) => entry.sessionId === ids[0]));
			assert.equal(backend.pid, pid);
			const original = await api.hub.locate(ids[0]);
			assert.ok(original?.sessionFile);
			const before = await readEntries(api, original.sessionFile);
			assert.equal(before.filter((entry) => entry.type === "message").length, 0);
			await sessions[0].reload();
			assert.equal((await api.hub.locate(ids[0]))?.sessionFile, original.sessionFile);
			await backend.request(BackendUnsubscribe, { generationId: backend.generationId!, sessionId: ids[0], subscriptionId: "residency-protected" });
			await sessions[0].shutdown();
			await sessions[0].reload();
			assert.equal((await api.hub.locate(ids[0]))?.sessionFile, original.sessionFile);
			const after = await readEntries(api, original.sessionFile);
			assert.equal(after.find((entry) => entry.type === "session")?.id, ids[0]);
			assert.equal(after.filter((entry) => entry.type === "message").length, 0);
			assert.equal(backend.pid, pid);
			await writeFile(join(directory, "results.json"), JSON.stringify({ pid, observations, snapshot, emptySession: { before, after } }, null, 2));
		} finally {
			for (const id of ids) {
				if (api.hub.existingSession(id)?.isRunning) {
					await backend.request(BackendUnsubscribe, { generationId: backend.generationId!, sessionId: id, subscriptionId: "residency-protected" });
					await api.hub.existingSession(id)!.shutdown();
				}
			}
		}
	});

	it("真实运行期间请求重新加载，其他会话保持可用", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-reload", randomUUID());
		await mkdir(directory, { recursive: true });
		const sessions: PiSession[] = [];
		try {
			for (let index = 0; index < 2; index++) {
				const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
				sessions.push(session); await session.reload();
			}
			const identities = sessions.map((session) => ({ generationId: backend.generationId!, sessionId: session.location.sessionId }));
			const pid = backend.pid;
			const running = backend.request(BackendCommand, { ...identities[0], requestId: randomUUID(), command: { type: "bash", command: 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 5; Write-Output runtime-complete"' } });
			await waitFor("实际工具开始运行", () => backend.snapshot?.sessions.find((item) => item.sessionId === identities[0].sessionId && item.busy));
			const reloaded = sessions[0].reload();
			const other = await backend.request(BackendCommand, { ...identities[1], requestId: randomUUID(), command: { type: "get_state" } }) as { sessionId: string };
			assert.equal(other.sessionId, identities[1].sessionId);
			await running; await reloaded;
			assert.equal(backend.pid, pid);
			await writeFile(join(directory, "results.json"), JSON.stringify({ pid, identities, snapshot: backend.snapshot }, null, 2));
		} finally { for (const session of sessions) if (session.isRunning) await session.shutdown(); }
	});

	it("真实扩展资源读取失败完成清理，配置修复后可以重新加载", async () => {
		const api = await harness();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-resource-error", randomUUID());
		const extensions = join(directory, ".pi", "extensions");
		await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log");
		await writeFile(join(extensions, "runtime-fixture.json"), JSON.stringify({ log }));
		await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ themes: [join(directory, "missing-theme.json")] }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await assert.rejects(session.reload(), /资源路径不存在|theme path/);
			assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\n");
			await writeFile(join(directory, ".pi", "settings.json"), "{}");
			await session.reload();
			assert.equal(session.isRunning, true);
			assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\nfactory-created\n");
		} finally { if (session.isRunning) await session.shutdown(); }
		assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\nfactory-created\nfactory-closed\n");
	});

	it("真实扩展加载超过期限时保留加载操作，清理完成后允许重试", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-load-timeout", randomUUID());
		const extensions = join(directory, ".pi", "extensions");
		await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log");
		const configuration = join(extensions, "runtime-fixture.json");
		await writeFile(configuration, JSON.stringify({ log, delayMs: 65_000 }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await assert.rejects(session.reload(), /超过/);
			await assert.rejects(session.reload(), /仍未结束|尚未/);
			await waitFor("超过期限的扩展完成关闭", async () => (await readFile(log, "utf8")).includes("factory-closed"), 30_000);
			await waitFor("所属全部资源完成关闭", () => backend.snapshot?.sessions.find((entry) => entry.sessionId === session.location.sessionId && entry.resourceOperation === undefined), 30_000);
			assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\n");
			await writeFile(configuration, JSON.stringify({ log }));
			await session.reload();
			assert.equal(session.isRunning, true);
		} finally { if (session.isRunning) await session.shutdown(); }
		assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\nfactory-created\nfactory-closed\n");
	});

	it("输入扩展等待期间停止与重新加载均等待所属输入调用", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-input-stop", randomUUID());
		const extensions = join(directory, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log");
		await writeFile(join(extensions, "runtime-fixture.json"), JSON.stringify({ log, inputDelayMs: 5_000 }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const [provider, ...model] = TEST_MODEL.split("/");
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
			const dispatched = backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: "使用write工具创建after-stop.txt，然后回复完成。" } });
			await waitFor("真实输入扩展开始等待", async () => (await readFile(log, "utf8")).includes("input-started"));
			await session.stop(); await dispatched;
			assert.ok((await readFile(log, "utf8")).includes("input-finished"));
			await waitFor("输入处理停止后保持空闲", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && !item.busy));
			assert.equal(existsSync(join(directory, "after-stop.txt")), false);
			const next = backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: "请仅回复输入处理已经完成。" } });
			await waitFor("第二次输入扩展开始等待", async () => (await readFile(log, "utf8")).split("input-started").length === 3);
			const reloading = session.reload();
			await waitFor("输入处理期间重新加载保持等待", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && item.reloadPending && item.busy));
			await next; await reloading;
			assert.equal((await readFile(log, "utf8")).split("input-finished").length, 3);
			const command = await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: "/runtime-reload" } }) as { disposition: string };
			assert.equal(command.disposition, "handled");
			await writeFile(join(directory, "results.json"), JSON.stringify({ lifecycle: await readFile(log, "utf8"), snapshot: backend.snapshot }, null, 2));
		} finally { if (session.isRunning) { await session.stop(); await session.shutdown(); } }
	});

	it("真实交互期间重复重新加载只创建一代，排队请求随后执行一次", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-interaction", randomUUID());
		const extensions = join(directory, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log");
		await writeFile(join(extensions, "runtime-fixture.json"), JSON.stringify({ log, confirmTimeoutMs: 7_000 }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const [provider, ...model] = TEST_MODEL.split("/");
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
			const interaction = backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: "/runtime-confirm" } });
			const waiting = await waitFor("真实交互已经登记", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && item.pendingInteractions === 1));
			const reloads = [0, 1].map(() => backend.request(BackendReload, { ...identity, operationId: randomUUID() }));
			await waitFor("交互期间重新加载等待", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && item.reloadPending && item.pendingInteractions === 1));
			const requestId = randomUUID();
			const queued = backend.request(BackendCommand, { ...identity, requestId, command: { type: "prompt", message: `只回复队列已完成 ${requestId}，不要调用工具。` } });
			await interaction;
			const completed = await Promise.all(reloads); await queued;
			assert.equal(completed[0].runtimeGeneration, waiting.runtimeGeneration + 1);
			assert.equal(completed[1].runtimeGeneration, completed[0].runtimeGeneration);
			await waitFor("排队请求完成", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && !item.busy));
			const entries = await readEntries(api, session.location.sessionFile!);
			assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(requestId)).length, 1);
			assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\nfactory-created\n");
			await writeFile(join(directory, "results.json"), JSON.stringify({ waiting, completed, requestId }, null, 2));
		} finally { if (session.isRunning) { await session.stop(); await session.shutdown(); } }
	});

	it("旧资源关闭超过十秒保持保护，真实关闭完成后才重新加载", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-close-timeout", randomUUID());
		const extensions = join(directory, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log"); const configuration = join(extensions, "runtime-fixture.json");
		await writeFile(configuration, JSON.stringify({ log, shutdownDelayMs: 12_000 }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const started = Date.now();
			await assert.rejects(backend.request(BackendReload, { ...identity, operationId: randomUUID() }), /10 秒/);
			const elapsed = Date.now() - started; assert.ok(elapsed >= 9_500 && elapsed < 12_000, `实际关闭期限 ${elapsed}ms`);
			await assert.rejects(backend.request(BackendReload, { ...identity, operationId: randomUUID() }), /仍未结束/);
			assert.equal(await readFile(log, "utf8"), "factory-created\n");
			await waitFor("真实旧资源关闭完成", () => backend.snapshot?.sessions.find((entry) => entry.sessionId === session.location.sessionId && entry.resourceOperation === undefined), 30_000);
			await writeFile(configuration, JSON.stringify({ log }));
			await backend.request(BackendReload, { ...identity, operationId: randomUUID() });
			assert.equal(await readFile(log, "utf8"), "factory-created\nfactory-closed\nfactory-created\n");
			await writeFile(join(directory, "results.json"), JSON.stringify({ elapsed, snapshot: backend.snapshot }, null, 2));
		} finally {
			if (session.isRunning) {
				await waitFor("关闭测试的真实资源操作完成", () => backend.snapshot?.sessions.find((entry) => entry.sessionId === session.location.sessionId && entry.resourceOperation === undefined), 30_000);
				await session.stop(); await session.shutdown();
			}
		}
	});

	it("实际模型配置增加和移除后重新校验目录与当前模型", async () => {
		const api = await harness(); const backend = await api.hub.backend(); const runtime = await api.hub.runtime();
		const models = JSON.parse(await readFile(join(runtime.modules.getAgentDir(), "models.json"), "utf8")) as { providers: Record<string, { models: { id: string }[] }> };
		const configuration = Object.values(models.providers).find((provider) => provider.models.length > 0); assert.ok(configuration);
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-model-config", randomUUID());
		const extensions = join(directory, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-provider.js"), join(extensions, "runtime-provider.js"));
		const providerFile = join(extensions, "runtime-provider.json");
		await writeFile(providerFile, JSON.stringify({ enabled: true, configuration }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const modelId = configuration.models[0].id;
			const before = await backend.catalog(directory, true, true, identity.sessionId);
			assert.ok(before.models.some((model) => model.provider === "runtime-resources" && model.id === modelId));
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider: "runtime-resources", modelId } });
			await writeFile(providerFile, JSON.stringify({ enabled: false, configuration }));
			const reloading = session.reload();
			await waitFor("模型配置重新加载开始", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && item.reloadPending));
			const queued = backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: "只回复模型已经就绪。" } });
			await Promise.all([assert.rejects(reloading, /模型不可用/), assert.rejects(queued, /模型不可用/)]);
			const removed = await backend.catalog(directory, true, true);
			assert.equal(removed.models.some((model) => model.provider === "runtime-resources"), false);
			assert.equal((await readEntries(api, session.location.sessionFile!)).filter((entry) => entry.type === "message").length, 0);
			await writeFile(providerFile, JSON.stringify({ enabled: true, configuration })); await session.reload();
			const after = await backend.catalog(directory, true, true, identity.sessionId);
			assert.ok(after.models.some((model) => model.provider === "runtime-resources" && model.id === modelId));
			await writeFile(join(directory, "results.json"), JSON.stringify({ modelId, before: before.models.map((model) => `${model.provider}/${model.id}`), removed: removed.models.map((model) => `${model.provider}/${model.id}`), after: after.models.map((model) => `${model.provider}/${model.id}`) }, null, 2));
		} finally { if (session.isRunning) await session.shutdown(); }
	});
});

describe("共享后台子任务", () => {
	it("同文 follow-up 与 steer 按实际队列消费顺序归属文件提交", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-identical-queues", randomUUID()); await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "queue-order.txt"), "开始\n");
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const [provider, ...model] = TEST_MODEL.split("/");
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "prompt", message: '请使用bash工具执行 powershell.exe -NoProfile -Command "Start-Sleep -Seconds 20"，然后回复已等待。' } });
			await waitFor("真实模型进入命令等待", async () => toolCalls((await readEntries(api, session.location.sessionFile!)).filter((entry) => entry.type !== "session")).some((call) => call.name === "bash"));
			const message = "每次收到本条消息都读取queue-order.txt，使用edit工具在实际文件末尾新增一行完成。每次只新增一行，即使此前已经收到相同文字，也需要完成本次新增。";
			const followup = randomUUID(); const steer = randomUUID();
			assert.equal((await backend.request(BackendCommand, { ...identity, requestId: followup, command: { type: "follow_up", message } }) as { disposition: string }).disposition, "queued");
			assert.equal((await backend.request(BackendCommand, { ...identity, requestId: steer, command: { type: "steer", message } }) as { disposition: string }).disposition, "queued");
			await waitFor("两个同文请求均完成", async () => {
				const snapshot = backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId);
				return snapshot && !snapshot.busy && (await readEntries(api, session.location.sessionFile!)).filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(message)).length === 2 ? snapshot : undefined;
			}, 300_000);
			const database = new DatabaseSync(OperationStore.pathFor(session.location.sessionFile!), { readOnly: true });
			try {
				const commits = database.prepare("SELECT root_request_id,identity_json,edit_json FROM file_commits WHERE root_request_id IN (?,?) ORDER BY commit_id").all(followup, steer);
				assert.ok(commits.length >= 2); assert.equal(commits[0].root_request_id, steer); assert.equal(commits.at(-1)!.root_request_id, followup);
				assert.equal((await readFile(join(directory, "queue-order.txt"), "utf8")).trim().split(/\r?\n/).length, 3);
				await writeFile(join(directory, "results.json"), JSON.stringify({ followup, steer, commits }, null, 2));
			} finally { database.close(); }
		} finally { if (session.isRunning) { await session.stop(); await session.shutdown(); } }
	});

	it("真实 steer 消息后的文件提交归属追加请求", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-steer", randomUUID());
		await mkdir(directory, { recursive: true });
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		const first = randomUUID(); const second = randomUUID();
		try {
			await session.reload();
			const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
			const [provider, ...model] = TEST_MODEL.split("/");
			await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
			await backend.request(BackendCommand, { ...identity, requestId: first, command: { type: "prompt", message: `使用write工具创建before-steer.txt，内容为${first}。随后必须使用bash工具运行 powershell.exe -NoProfile -Command "Start-Sleep -Seconds 15"。完成后回复已完成。` } });
			await waitFor("真实工具进入等待", async () => toolCalls((await readEntries(api, session.location.sessionFile!)).filter((entry) => entry.type !== "session")).some((call) => call.name === "bash"));
			const accepted = await backend.request(BackendCommand, { ...identity, requestId: second, command: { type: "prompt", streamingBehavior: "steer", message: `追加任务：使用write工具创建after-steer.txt，内容为${second}，然后回复已完成。` } }) as { disposition: string };
			assert.equal(accepted.disposition, "queued");
			await waitFor("追加请求完成写入", () => existsSync(join(directory, "after-steer.txt")), 300_000);
			await waitFor("追加请求结束", () => backend.snapshot?.sessions.find((item) => item.sessionId === identity.sessionId && !item.busy));
			const store = new OperationStore(session.location.sessionFile!);
			try {
				const firstEdits = store.editsFor([first]); const secondEdits = store.editsFor([second]);
				assert.ok(firstEdits.some((edit) => edit.path === canonicalFilePath(join(directory, "before-steer.txt"))));
				assert.equal(firstEdits.some((edit) => edit.path === canonicalFilePath(join(directory, "after-steer.txt"))), false);
				assert.ok(secondEdits.some((edit) => edit.path === canonicalFilePath(join(directory, "after-steer.txt"))));
				await writeFile(join(directory, "results.json"), JSON.stringify({ first, second, accepted, firstEdits, secondEdits }, null, 2));
			} finally { store.close(); }
		} finally { if (session.isRunning) { await session.stop(); await session.shutdown(); } }
	});

	it("真实模型并发启动前台 child 和独立后台 runner，写入保持所属请求身份", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const sessions: PiSession[] = [];
		let control: PiSession | undefined;
		const observations: unknown[] = [];
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-subagents", randomUUID());
		try {
			for (const mode of ["foreground", "background"]) {
				const cwd = join(directory, mode); await mkdir(cwd, { recursive: true });
				const session = await api.hub.session(await api.hub.allocate(cwd, randomUUID()));
				sessions.push(session); await session.reload();
				const [provider, ...model] = TEST_MODEL.split("/");
				await backend.request(BackendCommand, { generationId: backend.generationId!, sessionId: session.location.sessionId, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
			}
			await mkdir(join(directory, "control"), { recursive: true });
			control = await api.hub.session(await api.hub.allocate(join(directory, "control"), randomUUID())); await control.reload();
			const requests = sessions.map(() => randomUUID());
			const seenTasks = new Set<string>();
			const unsubscribe = backend.onChanged(() => { for (const item of backend.snapshot?.sessions ?? []) if (item.childTasks > 0) seenTasks.add(item.sessionId); });
			try {
				await Promise.all(sessions.map((session, index) => backend.request(BackendCommand, {
					generationId: backend.generationId!, sessionId: session.location.sessionId, requestId: requests[index],
					command: { type: "prompt", message: `请直接调用 subagent 工具启动一个 worker，顶层参数async=${index === 1}，model 使用 ${TEST_MODEL}，禁止工作流脚本。任务内容：使用 write 工具创建当前目录的 child-before.txt，内容为 ${session.location.sessionId}；使用 bash 工具执行 powershell.exe -NoProfile -Command "Start-Sleep -Seconds 45"；随后使用 write 工具创建 child-after.txt，内容相同。只需要完成这项任务。父会话不要自行写文件。` },
				})));
				const background = sessions[1];
				await waitForChildFile(background, join(background.location.cwd, "child-before.txt"));
				const followup = randomUUID();
				const beforeReload = backend.snapshot?.sessions.find((item) => item.sessionId === background.location.sessionId); assert.ok(beforeReload && beforeReload.childTasks > 0);
				await Promise.all([control.reload(), backend.request(BackendCommand, { generationId: backend.generationId!, sessionId: background.location.sessionId, requestId: followup,
					command: { type: "prompt", streamingBehavior: "steer", message: `依次直接调用mcp__claude_mem__work_state_read读取当前工作记录，调用vscode_diagnostics读取当前目录诊断，然后使用write工具创建parent-followup.txt，内容为${followup}。已有后台任务继续完成。` } })]);
				const afterReload = backend.snapshot?.sessions.find((item) => item.sessionId === background.location.sessionId); assert.ok(afterReload);
				assert.equal(afterReload.runtimeGeneration, beforeReload.runtimeGeneration);
				assert.ok(afterReload.mcp?.servers.filter((server) => server.enabled).every((server) => server.state === "connected"));
				for (const [index, session] of sessions.entries()) {
					const completed = join(session.location.cwd, "child-after.txt");
					await waitForChildFile(session, completed);
					await waitFor("所属子任务全部结束", () => backend.snapshot?.sessions.find((item) => item.sessionId === session.location.sessionId && !item.busy && item.childTasks === 0), 600_000);
					assert.equal((await readFile(completed, "utf8")).trim(), session.location.sessionId);
					assert.ok(seenTasks.has(session.location.sessionId));
					const entries = await readEntries(api, session.location.sessionFile!);
					const calls = toolCalls(entries.filter((entry) => entry.type !== "session"));
					assert.ok(calls.some((call) => call.name === "subagent"), "实际模型必须调用 subagent 工具");
					const store = new OperationStore(session.location.sessionFile!);
					try {
						const edits = store.editsFor([requests[index]]);
						assert.ok(edits.some((entry) => entry.path === canonicalFilePath(completed)), "child 文件提交必须保存到父请求的恢复记录");
						if (index === 1) {
							assert.equal(edits.some((entry) => entry.path === canonicalFilePath(join(session.location.cwd, "parent-followup.txt"))), false);
							assert.ok(store.editsFor([followup]).some((entry) => entry.path === canonicalFilePath(join(session.location.cwd, "parent-followup.txt"))));
							assert.ok(calls.some((call) => call.name === "mcp__claude_mem__work_state_read"));
							assert.ok(calls.some((call) => call.name === "vscode_diagnostics"));
							for (const name of ["mcp__claude_mem__work_state_read", "vscode_diagnostics"]) assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name && !entry.message.isError));
						}
						observations.push({ sessionId: session.location.sessionId, mode: index === 0 ? "foreground" : "background", edits, calls });
					} finally { store.close(); }
				}
				assert.equal(sessions[0].processId, sessions[1].processId);
				await writeFile(join(directory, "results.json"), JSON.stringify({ pid: backend.pid, observations, beforeReload, afterReload }, null, 2));
			} finally { unsubscribe(); }
		} finally { for (const session of [...sessions, ...control ? [control] : []]) if (session.isRunning) { await session.stop(); await session.shutdown(); } }
	});

	it("多层 child 和后台 runner 执行期间恢复父请求，撤销原身份并完成明确重发", async () => {
		const api = await harness();
		const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-child-stop", randomUUID());
		const results: unknown[] = [];
		for (const mode of ["nested", "runner"]) {
			const cwd = join(directory, mode); const agents = join(cwd, ".pi", "agents");
			await mkdir(agents, { recursive: true });
			await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "harness-parent.md"), join(agents, "harness-parent.md"));
			const session = await api.hub.session(await api.hub.allocate(cwd, randomUUID()));
			const requestId = randomUUID();
			try {
				await session.reload();
				const identity = { generationId: backend.generationId!, sessionId: session.location.sessionId };
				const [provider, ...model] = TEST_MODEL.split("/");
				await backend.request(BackendCommand, { ...identity, requestId: randomUUID(), command: { type: "set_model", provider, modelId: model.join("/") } });
				const workerTask = `使用 write 工具创建当前目录的 before-stop.txt，内容为 ${requestId}。随后使用 bash 工具执行 powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120"，命令完成以后使用write工具创建 after-stop.txt，内容相同。`;
				await backend.request(BackendCommand, { ...identity, requestId, command: { type: "prompt", message: mode === "nested"
					? `调用 subagent 工具，agent=harness-parent，顶层参数async=false，model=${TEST_MODEL}。给它的任务：必须再调用subagent工具启动worker，顶层参数async=false，model=${TEST_MODEL}，worker任务：${workerTask}。所有步骤使用当前工作目录。父会话等待子任务。`
					: `直接调用 subagent 工具启动worker，顶层参数async=true，model=${TEST_MODEL}。任务：${workerTask}。禁止使用工作流脚本，父会话不要写文件。` } });
				await waitForChildFile(session, join(cwd, "before-stop.txt"));
				const active = await waitFor("子任务所属请求身份", () => backend.snapshot?.sessions.find((item) => item.sessionId === session.location.sessionId && item.childTasks > 0 && item.runId));
				const store = new OperationStore(session.location.sessionFile!);
				try {
					const reader = new DatabaseSync(store.path, { readOnly: true });
					let commit: CommitIdentity;
					try {
						const row = reader.prepare("SELECT identity_json FROM file_commits WHERE root_request_id=? ORDER BY commit_id LIMIT 1").get(requestId); assert.ok(row);
						commit = JSON.parse(String(row.identity_json)) as CommitIdentity;
					} finally { reader.close(); }
					await backend.validateIdentity(commit);
					const user = (await readEntries(api, session.location.sessionFile!)).find((entry) => entry.type === "message" && entry.message.role === "user");
					assert.ok(user && user.type === "message");
					const replacement = randomUUID(); const prompt = `只回复已恢复 ${replacement}，不要使用工具。`;
					await session.rewindBefore(user.id, user.parentId, { requestId: replacement, promptText: prompt, userText: prompt, references: [], images: [], enabledCopilotTools: [], selection: undefined }, [requestId]);
					await assert.rejects(backend.validateIdentity(commit), /失效/);
					assert.equal(existsSync(join(cwd, "before-stop.txt")), false);
					assert.equal(existsSync(join(cwd, "after-stop.txt")), false);
					const stopped = await waitFor("停止后全部所属任务结束", () => backend.snapshot?.sessions.find((item) => item.sessionId === session.location.sessionId && !item.busy && item.childTasks === 0));
					assert.ok(store.editsFor([requestId]).some((entry) => entry.path === canonicalFilePath(join(cwd, "before-stop.txt"))));
					const pending = store.getPendingRestore(); assert.equal(pending?.stage, "restored");
					await backend.request(BackendCommand, { ...identity, requestId: replacement, command: { type: "prompt", message: prompt } });
					const submitted = await waitFor("明确重发产生真实用户条目", async () => (await readEntries(api, session.location.sessionFile!)).find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(replacement)));
					assert.ok(submitted.type === "message");
					await backend.markSubmitted(identity.sessionId, replacement, submitted.id);
					await waitFor("明确重发完成", () => backend.snapshot?.sessions.find((item) => item.sessionId === session.location.sessionId && !item.busy));
					assert.equal(store.getPendingRestore(), undefined);
					results.push({ mode, commit, active, stopped, pending, submitted });
				} finally { store.close(); }
			} finally { if (session.isRunning) { await session.stop(); await session.shutdown(); } }
		}
		await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
	});

	it("真实扩展关闭读取失败保持所属资源保护，其他会话继续可用", async () => {
		const api = await harness(); const backend = await api.hub.backend();
		const directory = join(env("PI_HARNESS_TEST_WORK"), "runtime-shutdown-error", randomUUID());
		const extensions = join(directory, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
		await copyFile(join(env("PI_HARNESS_TEST_ROOT"), "test", "fixtures", "runtime-lifecycle.js"), join(extensions, "runtime-lifecycle.js"));
		const log = join(directory, "lifecycle.log");
		await writeFile(join(extensions, "runtime-fixture.json"), JSON.stringify({ log, shutdownRequiredFile: join(directory, "required-shutdown.txt") }));
		const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
		const otherDirectory = join(directory, "other"); await mkdir(otherDirectory, { recursive: true });
		const other = await api.hub.session(await api.hub.allocate(otherDirectory, randomUUID()));
		try {
			await session.reload(); await other.reload(); const pid = backend.pid;
			await assert.rejects(session.reload(), /ENOENT|required-shutdown/);
			await assert.rejects(session.reload(), /仍未结束|关闭失败|ENOENT/);
			const protectedEntry = await waitFor("关闭失败保留保护", () => backend.snapshot?.sessions.find((item) => item.sessionId === session.location.sessionId && item.state === "protected" && item.resourceOperation === "closing"));
			assert.equal(await readFile(log, "utf8"), "factory-created\n");
			const state = await backend.request(BackendCommand, { generationId: backend.generationId!, sessionId: other.location.sessionId, requestId: randomUUID(), command: { type: "get_state" } }) as { sessionId: string };
			assert.equal(state.sessionId, other.location.sessionId); assert.equal(backend.pid, pid);
			await writeFile(join(directory, "results.json"), JSON.stringify({ pid, protectedEntry, state }, null, 2));
		} finally { if (other.isRunning) await other.shutdown(); }
	});
});
