import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type * as Pi from "@earendil-works/pi-coding-agent";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection, type NotificationType } from "vscode-jsonrpc/node";
import { Hello } from "../../shared/protocol";
import { OperationStore } from "../../src/backend/operationStore";
import { BackendEvent, BackendSessionChanged } from "../../src/backend/protocol";
import { BackendRegistry } from "../../src/backend/registry";
import { ROOT } from "../environment";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

after(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix = "pi-mem-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function devPackageDir(): string {
	return join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
}

function createTestModelsConfig() {
	return {
		providers: {
			"test-provider": {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "model-a",
						name: "Model A",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
					{
						id: "model-b",
						name: "Model B",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			},
		},
	};
}

async function startMockBridge(): Promise<{ path: string; close(): Promise<void> }> {
	const pipePath = process.platform === "win32"
		? `\\\\.\\pipe\\pi-harness-memtest-${randomUUID()}`
		: join(await createTempDir("pi-bridge-"), "bridge.sock");
	const sockets = new Set<Socket>();
	const connections = new Set<MessageConnection>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
		connections.add(connection);
		connection.onRequest(Hello, () => ({ copilotTools: [] }));
		connection.listen();
		socket.once("close", () => {
			sockets.delete(socket);
			connections.delete(connection);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(pipePath, resolve);
	});
	return {
		path: pipePath,
		async close() {
			for (const connection of connections) connection.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("T1: pi-lens 构建移除 inline sourcemap，且多轮激活关闭与激活抛错后沙箱闭包可被 GC 回收", async () => {
	const runtimePath = join(ROOT, "dist", "compat", "pi-lens", "dist", "runtime.cjs");
	const info = await stat(runtimePath);
	assert.ok(info.size < 10 * 1024 * 1024, `runtime.cjs 体积过大：${info.size} bytes`);
	const tail = (await readFile(runtimePath, "utf8")).slice(-2048);
	assert.equal(tail.includes("sourceMappingURL=data:"), false, "runtime.cjs 不应内联 sourcemap");

	const temp = await createTempDir("pi-lens-leak-");
	const homeDir = join(temp, "home");
	const agentDir = join(temp, "agent");
	const workspace = join(temp, "workspace");
	await mkdir(homeDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(workspace, "src"), { recursive: true });
	for (let i = 0; i < 60; i++) {
		await writeFile(
			join(workspace, "src", `mod_${i}.ts`),
			`export function computeValue_${i}(input: number): number { return input * ${i + 1} + ${i}; }\nexport const TOKEN_${i} = "symbol_token_${i}_alpha_beta";\n`,
			"utf8",
		);
	}

	const childScript = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.TEST_ROOT;
const workspace = process.env.TEST_WORKSPACE;
const agentDir = process.env.TEST_AGENT_DIR;
const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

const sdk = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
const harness = await import(pathToFileURL(join(root, "dist", "compat", "pi-subagents", "harness-context.js")).href);
const { default: activate } = await import(pathToFileURL(join(root, "dist", "compat", "pi-lens", "index.js")).href);

// pi-lens 在 Windows 上通过 unref() 子进程查询自身进程启动时间；保持事件循环活跃直到测试结束
const keepAlive = setInterval(() => {}, 1_000);
try {
async function forceGc() {
	for (let i = 0; i < 5; i++) {
		global.gc();
		await new Promise((r) => setTimeout(r, 25));
	}
	global.gc();
}

// 1) 激活阶段抛错也必须释放沙箱资源与 perf_hooks，不泄漏闭包
async function runFailedActivation() {
	let failedHandlerRef;
	const scope = harness.createHarnessScope({
		sessionId: "fail-activation",
		cwd: workspace,
		agentDir,
		loadPiCodingAgent: async () => sdk,
	});
	const failingApi = {
		on(event, handler) {
			if (!failedHandlerRef && event === "session_start") failedHandlerRef = new WeakRef(handler);
			if (event === "context") throw new Error("simulated-activation-failure");
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() { return undefined; },
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry() {},
		setActiveTools() {},
		getActiveTools() { return []; },
		getAllTools() { return []; },
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		events: { on() {}, emit() {} },
	};
	let rejected = false;
	try {
		await harness.runHarnessScope(scope, () => activate(failingApi));
	} catch (error) {
		rejected = String(error).includes("simulated-activation-failure");
	}
	harness.removeHarnessScope(scope);
	if (!rejected) throw new Error("expected simulated activation failure to reject");
	if (!failedHandlerRef) throw new Error("expected session_start handler WeakRef before failure");
	return failedHandlerRef;
}

const failedHandlerRef = await runFailedActivation();
await forceGc();
const failedReclaimed = failedHandlerRef.deref() === undefined;

// 2) 多轮完整激活 -> session_start -> session_shutdown -> dispose 闭环（独立函数帧确保测试自身不持有局部引用）
async function runCycle(i) {
	let cycleRef;
	const scope = harness.createHarnessScope({
		sessionId: "cycle-" + i,
		cwd: workspace,
		agentDir,
		loadPiCodingAgent: async () => sdk,
	});
	const scopeRef = new WeakRef(scope);
	const settingsManager = sdk.SettingsManager.inMemory();
	const loader = new sdk.DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [{
			name: "pi-lens",
			factory: async (api) => {
				const proxy = new Proxy(api, {
					get(target, property) {
						if (property === "on") {
							return (event, handler) => {
								if (!cycleRef && event === "session_start") cycleRef = new WeakRef(handler);
								return target.on(event, handler);
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				await activate(proxy);
			},
		}],
	});
	await harness.runHarnessScope(scope, () => loader.reload());
	const loadErrors = loader.getExtensions().errors;
	if (loadErrors.length > 0) throw new Error("pi-lens load errors: " + JSON.stringify(loadErrors));
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const { session } = await sdk.createAgentSession({
		cwd: workspace,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader: loader,
		sessionManager: sdk.SessionManager.inMemory(workspace),
		noTools: "all",
	});
	const bindErrors = [];
	await harness.runHarnessScope(scope, () => session.bindExtensions({
		mode: "print",
		onError: (err) => bindErrors.push(err.error),
	}));
	if (bindErrors.length > 0) throw new Error("pi-lens bind errors: " + JSON.stringify(bindErrors));
	await harness.runHarnessScope(scope, () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
	session.dispose();
	harness.removeHarnessScope(scope);
	if (!cycleRef) throw new Error("failed to capture pi-lens session_start handler WeakRef on cycle " + i);
	return { cycleRef, scopeRef };
}

const handlerRefs = [];
const scopeRefs = [];
const memorySamples = [];
const cycles = 6;
for (let i = 0; i < cycles; i++) {
	const { cycleRef, scopeRef } = await runCycle(i);
	handlerRefs.push(cycleRef);
	scopeRefs.push(scopeRef);
	await forceGc();
	const mem = process.memoryUsage();
	memorySamples.push({ cycle: i, heapUsed: mem.heapUsed, arrayBuffers: mem.arrayBuffers });
}

await forceGc();
const survivingRefs = handlerRefs.filter((ref) => ref.deref() !== undefined).length;
const survivingScopes = scopeRefs.filter((ref) => ref.deref() !== undefined).length;
console.log(JSON.stringify({ failedReclaimed, survivingRefs, survivingScopes, cycles, memorySamples }));
} finally {
	clearInterval(keepAlive);
}
`;

	const { stdout } = await execFileAsync(process.execPath, ["--expose-gc", "--input-type=module", "-e", childScript], {
		env: {
			...process.env,
			HOME: homeDir,
			USERPROFILE: homeDir,
			PI_CODING_AGENT_DIR: agentDir,
			TEST_ROOT: ROOT,
			TEST_WORKSPACE: workspace,
			TEST_AGENT_DIR: agentDir,
		},
		maxBuffer: 4 * 1024 * 1024,
	});

	const line = stdout.trim().split(/\r?\n/).at(-1);
	assert.ok(line, `子进程未输出检测结果：${stdout}`);
	const report = JSON.parse(line) as {
		failedReclaimed: boolean;
		survivingRefs: number;
		survivingScopes: number;
		cycles: number;
		memorySamples: { cycle: number; heapUsed: number; arrayBuffers: number }[];
	};
	assert.equal(report.failedReclaimed, true, "激活失败路径的 pi-lens 闭包未被 GC 回收");
	assert.equal(report.survivingRefs, 0, `仍有 ${report.survivingRefs} 个已关闭 pi-lens 沙箱闭包未被回收`);
	assert.equal(report.survivingScopes, 0, `仍有 ${report.survivingScopes} 个已关闭 HarnessScope 未被回收`);
	const baseline = report.memorySamples[1];
	const finalSample = report.memorySamples.at(-1)!;
	const heapDeltaMiB = (finalSample.heapUsed - baseline.heapUsed) / (1024 * 1024);
	const abDeltaMiB = (finalSample.arrayBuffers - baseline.arrayBuffers) / (1024 * 1024);
	assert.ok(heapDeltaMiB < 20, `多轮回收后 heapUsed 增量过大：${heapDeltaMiB.toFixed(2)} MiB`);
	assert.ok(abDeltaMiB < 5, `多轮回收后 arrayBuffers 增量过大：${abDeltaMiB.toFixed(2)} MiB`);
});

test("T2: pi-lens 在 catalogOnly 模式下跳过重型 runtime 初始化且保留 skills 发现", async () => {
	const temp = await createTempDir("pi-lens-catalog-only-");
	const agentDir = join(temp, "agent");
	const workspace = join(temp, "workspace");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });

	const sdk = await import(pathToFileURL(join(devPackageDir(), "dist", "index.js")).href) as typeof Pi;
	const harness = await import(pathToFileURL(join(ROOT, "dist", "compat", "pi-subagents", "harness-context.js")).href) as {
		createHarnessScope(options: Record<string, unknown>): Record<string, unknown>;
		runHarnessScope<T>(scope: Record<string, unknown>, action: () => T): T;
		removeHarnessScope(scope: Record<string, unknown>): void;
	};
	const { default: activate } = await import(pathToFileURL(join(ROOT, "dist", "compat", "pi-lens", "index.js")).href) as {
		default(pi: unknown): Promise<void>;
	};

	// 直接调用：catalogOnly 应立即返回，不加载 SDK、不注册任何工具或事件
	let loadedSdk = false;
	let calls = 0;
	const directScope = harness.createHarnessScope({
		sessionId: "catalog-direct",
		cwd: workspace,
		agentDir,
		catalogOnly: true,
		loadPiCodingAgent: async () => { loadedSdk = true; return sdk; },
	});
	try {
		await harness.runHarnessScope(directScope, () => activate({
			on() { calls += 1; },
			registerTool() { calls += 1; },
			registerCommand() { calls += 1; },
		}));
	} finally {
		harness.removeHarnessScope(directScope);
	}
	assert.equal(loadedSdk, false);
	assert.equal(calls, 0);

	// 通过真实 DefaultResourceLoader 加载 compat/pi-lens 包：skills 仍可发现且不注册 pi-lens 工具
	const piLensPackageDir = join(ROOT, "dist", "compat", "pi-lens");
	const settingsManager = sdk.SettingsManager.inMemory({ packages: [piLensPackageDir] });
	const loaderScope = harness.createHarnessScope({
		sessionId: "catalog-loader",
		cwd: workspace,
		agentDir,
		catalogOnly: true,
		loadPiCodingAgent: async () => sdk,
	});
	try {
		const loader = new sdk.DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager,
		});
		await harness.runHarnessScope(loaderScope, () => loader.reload());
		assert.deepEqual(loader.getExtensions().errors, []);
		const skillNames = loader.getSkills().skills.map((skill) => skill.name);
		assert.ok(skillNames.includes("pi-lens-ast-grep"), `未发现 pi-lens-ast-grep，实际 skills: ${skillNames.join(", ")}`);
		assert.ok(skillNames.includes("pi-lens-lsp-navigation"), `未发现 pi-lens-lsp-navigation，实际 skills: ${skillNames.join(", ")}`);
		const lensExt = loader.getExtensions().extensions.find((ext) => ext.path.replaceAll("\\", "/").endsWith("/pi-lens/index.js"));
		assert.ok(lensExt, "应加载 pi-lens 入口扩展");
		assert.equal(lensExt.tools.size, 0, "catalogOnly 模式不应注册 pi-lens 工具");
		assert.equal(lensExt.handlers.size, 0, "catalogOnly 模式不应注册 pi-lens 事件处理器");
	} finally {
		harness.removeHarnessScope(loaderScope);
	}
});

test("T3 & T4: catalog 复用常驻会话且不污染工作区默认模型；snapshot 不含 messages 且 message_update 不触发 sessionChanged", async () => {
	const temp = await createTempDir("pi-registry-mem-");
	const agentDir = join(temp, "agent");
	const workspace = join(temp, "WorkSpace");
	const sessionDir = join(temp, "sessions");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
	await mkdir(sessionDir, { recursive: true });

	await writeFile(join(agentDir, "models.json"), JSON.stringify(createTestModelsConfig()), "utf8");
	await writeFile(join(agentDir, "auth.json"), "{}", "utf8");
	await writeFile(join(agentDir, "settings.json"), "{}", "utf8");

	const countLog = join(workspace, "extension-loads.log");
	await writeFile(
		join(workspace, ".pi", "extensions", "load-counter.js"),
		`import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(countLog)}, "loaded\\n", "utf8"); }\n`,
		"utf8",
	);
	await writeFile(
		join(workspace, ".pi", "settings.json"),
		JSON.stringify({ defaultProvider: "test-provider", defaultModel: "model-a", defaultThinkingLevel: "low" }),
		"utf8",
	);

	const notifications: { method: string; params: unknown }[] = [];
	const transport = {
		sendNotification(type: NotificationType<unknown> | string, params: unknown) {
			const method = typeof type === "string" ? type : type.method;
			notifications.push({ method, params });
			return Promise.resolve();
		},
	} as unknown as MessageConnection;

	const generationId = randomUUID();
	const bridge = await startMockBridge();
	const registry = await BackendRegistry.create({
		generationId,
		packageDir: devPackageDir(),
		compatRoot: join(ROOT, "dist", "compat"),
		piExtensionPath: join(ROOT, "dist", "pi-extension", "index.js"),
		agentDir,
		residencyLimit: 10,
		authorization: {
			backendPid: process.pid,
			guardianPid: process.pid,
			hostPid: process.pid,
			jobName: "test-job",
			token: "test-token",
			backendCreationTime: "0",
			guardianCreationTime: "0",
			hostCreationTime: "0",
		},
	}, transport);

	try {
		const sessionId = randomUUID();
		const ownershipId = randomUUID();
		const { sessionFile } = registry.prepare({ generationId, sessionId, cwd: workspace, sessionDir });
		const store = new OperationStore(sessionFile);
		try {
			store.claimOwnership({
				ownershipId,
				sessionId,
				generationId,
				jobName: "test-job",
				hostPid: process.pid,
				hostCreationTime: "0",
				guardianPid: process.pid,
				guardianCreationTime: "0",
				backendPid: process.pid,
				backendCreationTime: "0",
				state: "running",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		} finally {
			store.close();
		}

		const opened = await registry.open({
			generationId,
			sessionId,
			cwd: workspace,
			sessionDir,
			sessionFile,
			ownershipId,
			bridge: { path: bridge.path, token: "test-token" },
			projectTrusted: true,
		});

		// T4.1: snapshot 与已发布变更均不应包含 messages 字段
		assert.equal("messages" in opened, false, "BackendSessionSnapshot 不应包含 messages 字段");
		for (const item of notifications.filter((entry) => entry.method === BackendSessionChanged.method)) {
			assert.equal("messages" in (item.params as Record<string, unknown>), false, "BackendSessionChanged 快照不应包含 messages");
		}

		const loadCount = async () => (await readFile(countLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).length;
		assert.equal(await loadCount(), 1, "打开常驻会话应加载项目扩展 1 次");

		// 临时切换常驻会话模型与思考级别（persist: false）
		await registry.command({
			generationId,
			sessionId,
			requestId: randomUUID(),
			command: { type: "set_model", provider: "test-provider", modelId: "model-b" },
		});
		await registry.command({
			generationId,
			sessionId,
			requestId: randomUUID(),
			command: { type: "set_thinking_level", level: "high" },
		});

		// T3.1: Windows 下不同大小写 cwd 的 workspace 级 catalog 应复用常驻会话，不触发新加载，且不被临时切换污染
		const queryCwd = process.platform === "win32" ? workspace.toLowerCase() : workspace;
		const workspaceCatalog = await registry.catalog({ generationId, cwd: queryCwd, projectTrusted: true, refresh: false });
		assert.equal(await loadCount(), 1, "非 refresh catalog 应复用同目录常驻会话，不应新建临时目录会话");
		assert.equal(workspaceCatalog.cwd, queryCwd);
		assert.equal(workspaceCatalog.defaultModel, "test-provider/model-a", "工作区级 catalog 默认模型不应被会话临时切换污染");
		assert.equal(workspaceCatalog.defaultThinking, "low", "工作区级 catalog 默认思考级别不应被会话临时切换污染");

		// T3.2: 显式传 sessionId 的 catalog 仍反映当前会话的活动模型与思考级别
		const sessionCatalog = await registry.catalog({ generationId, cwd: workspace, projectTrusted: true, sessionId });
		assert.equal(sessionCatalog.defaultModel, "test-provider/model-b");
		assert.equal(sessionCatalog.defaultThinking, "high");

		// T3.3: refresh=true 必须绕过复用，重新从磁盘读取变更后的配置
		await writeFile(
			join(workspace, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: "test-provider", defaultModel: "model-b", defaultThinkingLevel: "medium" }),
			"utf8",
		);
		const refreshed = await registry.catalog({ generationId, cwd: workspace, projectTrusted: true, refresh: true });
		assert.equal(await loadCount(), 2, "refresh=true 必须新建目录会话重新加载项目扩展与配置");
		assert.equal(refreshed.defaultModel, "test-provider/model-b");
		assert.equal(refreshed.defaultThinking, "medium");

		// T4.2: 高频 message_update 仅发 BackendEvent，不触发 BackendSessionChanged；非 message_update 事件仍触发
		notifications.length = 0;
		const recovery = registry.getRecoveryContext({ generationId, sessionId });
		const emitter = recovery.session as unknown as { _emit(event: unknown): void };
		for (let i = 0; i < 200; i++) {
			emitter._emit({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `chunk-${i}` }],
					usage: { input: 1, output: i + 1, cacheRead: 0, cacheWrite: 0, totalTokens: i + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "x",
					partial: { role: "assistant", content: [{ type: "text", text: `chunk-${i}` }] },
				},
			});
		}
		assert.equal(notifications.filter((entry) => entry.method === BackendEvent.method).length, 200);
		assert.equal(notifications.filter((entry) => entry.method === BackendSessionChanged.method).length, 0);

		emitter._emit({
			type: "tool_execution_update",
			toolCallId: "tc-1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "running" }], details: {} },
		});
		assert.equal(notifications.filter((entry) => entry.method === BackendSessionChanged.method).length, 1);
	} finally {
		await registry.shutdown(Date.now() + 15_000);
		await bridge.close();
	}
});
