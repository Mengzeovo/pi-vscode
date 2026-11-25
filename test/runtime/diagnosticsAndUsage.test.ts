import * as assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";
import { ProcessHandle } from "../../src/guardian/native";
import type { PiRuntime } from "../../src/pi/piRuntime";
import { SharedBackendClient } from "../../src/pi/sharedBackend";
import { ROOT } from "../environment";

const tempDirs: string[] = [];

after(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function devPackageDir(): string {
	return join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string | (() => string)): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`等待超时：${typeof label === "function" ? label() : label}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeUsageEntry(id: string, timestamp: number, costTotal: number, input: number, output: number, model = "model-a"): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			provider: "test-provider",
			model,
			timestamp,
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + output,
				cost: { input: 0, output: costTotal, cacheRead: 0, cacheWrite: 0, total: costTotal },
			},
		},
	});
}

function makeSessionHeader(id: string, timestamp: number, cwd: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: new Date(timestamp).toISOString(),
		cwd,
	});
}

test("D1: ProcessHandle.exitCode 返回真实退出码，且后端意外退出与断开不会被 disconnect 吞掉", async () => {
	// 1) ProcessHandle.exitCode 在运行期间返回 undefined，退出后返回精确退出码
	const probe = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.once('end', () => process.exit(42));"], {
		stdio: ["pipe", "ignore", "ignore"],
		windowsHide: true,
	});
	await new Promise<void>((resolve, reject) => {
		probe.once("spawn", resolve);
		probe.once("error", reject);
	});
	assert.ok(probe.pid !== undefined, "测试子进程必须具有 PID");
	const handle = ProcessHandle.open(probe.pid);
	try {
		assert.equal(handle.exited, false);
		assert.equal(handle.exitCode, undefined);
		const exited = new Promise<number | null>((resolve) => probe.once("exit", (code) => resolve(code)));
		probe.stdin.end();
		assert.equal(await exited, 42);
		assert.equal(handle.exited, true);
		assert.equal(handle.exitCode, 42);
	} finally {
		handle.close();
	}

	// 2) backend/index.cjs 在未经过 BackendShutdown 时遇到 IPC 断开必须向 stderr 同步记录原因与 exit code=1
	const orphan = fork(join(ROOT, "dist", "backend", "index.cjs"), [], {
		execPath: process.execPath,
		execArgv: [],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	let orphanStderr = "";
	orphan.stderr?.on("data", (chunk: Buffer) => { orphanStderr += chunk.toString(); });
	await new Promise<void>((resolve, reject) => {
		orphan.once("spawn", resolve);
		orphan.once("error", reject);
	});
	const orphanExit = new Promise<number | null>((resolve) => orphan.once("exit", (code) => resolve(code)));
	orphan.disconnect();
	assert.equal(await orphanExit, 1);
	assert.match(orphanStderr, /IPC channel disconnected unexpectedly/, `未记录意外断开日志：${orphanStderr}`);
	assert.match(orphanStderr, /exit code=1 shuttingDown=false/, `未记录退出状态日志：${orphanStderr}`);

	// 3) SharedBackendClient 正常 shutdown 干净退出（无异常日志），被外部强杀时日志保留退出码与守护进程报告
	const temp = await createTempDir("pi-backend-diag-");
	const agentDir = join(temp, "agent");
	const workspace = join(temp, "workspace");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), "{}", "utf8");
	await writeFile(join(agentDir, "settings.json"), "{}", "utf8");

	const runtime = {
		packageDir: devPackageDir(),
		version: "1.5.0",
		cliEntry: join(devPackageDir(), "dist", "cli.js"),
		nodeExecutable: process.execPath,
		nodeVersion: process.versions.node,
	} as unknown as PiRuntime;

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// 3a) 正常关闭
		const cleanLogs: string[] = [];
		const cleanClient = new SharedBackendClient({
			runtime,
			extensionPath: ROOT,
			residencyLimit: () => 2,
			log: (message) => cleanLogs.push(message),
		});
		try {
			await cleanClient.catalog(workspace, true);
			assert.ok(cleanClient.pid !== undefined, "启动后应存在后端 PID");
		} finally {
			await cleanClient.shutdown(Date.now() + 8_000);
		}
		assert.equal(cleanLogs.some((line) => line.includes("Pi 后台连接已经关闭") || line.includes("IPC channel disconnected unexpectedly")), false, `正常关闭不应出现异常断开日志：${cleanLogs.join(" | ")}`);
		assert.equal(cleanLogs.some((line) => line.includes("Pi 后台进程退出")), false, `正常关闭退出码为 0 时不应记录异常退出日志：${cleanLogs.join(" | ")}`);

		// 3b) 运行中被强杀（Windows 下通常先触发 disconnect 再触发 exit）
		const crashLogs: string[] = [];
		const crashClient = new SharedBackendClient({
			runtime,
			extensionPath: ROOT,
			residencyLimit: () => 2,
			log: (message) => crashLogs.push(message),
		});
		try {
			await crashClient.catalog(workspace, true);
			const backendPid = crashClient.pid;
			assert.ok(backendPid !== undefined, "启动后应存在后端 PID");
			const target = ProcessHandle.open(backendPid, false, true);
			try {
				target.terminate(0xC0000005);
			} finally {
				target.close();
			}
			await waitFor(
				() => crashLogs.some((line) => line.includes(`Pi 后台进程退出：PID ${backendPid}`) && line.includes("0xC0000005"))
					&& crashLogs.some((line) => line.includes("退出码") && line.includes("0xC0000005")),
				6_000,
				() => `等待退出码日志，当前日志：${crashLogs.join(" | ")}`,
			);
			assert.equal(crashClient.pid, undefined, "异常退出后客户端应失效");
		} finally {
			await crashClient.shutdown(Date.now() + 8_000);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("D2: pi-token-usage 在 catalogOnly 下跳过激活，session_start/turn_end/footer 仅扫当日文件，/usage 保持全量统计", async () => {
	const temp = await createTempDir("pi-token-usage-");
	const agentDir = join(temp, "agent");
	const workspace = join(temp, "workspace");
	const projectSessionDir = join(agentDir, "sessions", "proj-a");
	await mkdir(projectSessionDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await writeFile(
		join(workspace, ".pi-token-usage.json"),
		JSON.stringify({ enabled: true, items: ["projectTodayCost", "totalTodayCost"], separator: "  •  ", style: "plain", template: "" }),
		"utf8",
	);

	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const todayBase = startOfToday.getTime();
	const twoDaysAgo = todayBase - 2 * 86_400_000;
	const oneDayAgo = todayBase - 86_400_000;
	const oldMtime = new Date(twoDaysAgo);

	// 1) 历史旧文件（mtime 为两天前，总成本 $50.00）
	const oldHistoryFile = join(projectSessionDir, "2025-01-01T10-00-00-000Z_old-history.jsonl");
	await writeFile(
		oldHistoryFile,
		[
			makeSessionHeader("old-history", twoDaysAgo + 1_000, workspace),
			makeUsageEntry("old-1", twoDaysAgo + 2_000, 50, 10_000, 2_000, "model-old"),
		].join("\n") + "\n",
		"utf8",
	);
	await utimes(oldHistoryFile, oldMtime, oldMtime);

	// 2) 跨天恢复会话（mtime 为今天，含昨天 $20.00 + 今天 $3.50）
	const resumedTodayFile = join(projectSessionDir, "2025-01-02T10-00-00-000Z_resumed-today.jsonl");
	await writeFile(
		resumedTodayFile,
		[
			makeSessionHeader("resumed-today", oneDayAgo + 1_000, workspace),
			makeUsageEntry("resumed-old", oneDayAgo + 2_000, 20, 4_000, 1_000, "model-a"),
			makeUsageEntry("resumed-today-1", todayBase + 1_000, 3.5, 1_000, 500, "model-a"),
		].join("\n") + "\n",
		"utf8",
	);

	// 3) 探针文件（mtime 为两天前，但内部故意写入今天时间戳 $99.00；若当日窗口跳过旧 mtime 文件，则绝不会被读到）
	const staleProbeFile = join(projectSessionDir, "2025-01-03T10-00-00-000Z_stale-probe.jsonl");
	await writeFile(
		staleProbeFile,
		[
			makeSessionHeader("stale-probe", twoDaysAgo + 1_000, workspace),
			makeUsageEntry("probe-today", todayBase + 1_500, 99, 5_000, 1_000, "model-probe"),
		].join("\n") + "\n",
		"utf8",
	);
	await utimes(staleProbeFile, oldMtime, oldMtime);

	const sdk = await import(pathToFileURL(join(devPackageDir(), "dist", "index.js")).href) as typeof Pi;
	const harness = await import(pathToFileURL(join(ROOT, "dist", "compat", "pi-subagents", "harness-context.js")).href) as {
		createHarnessScope(options: Record<string, unknown>): Record<string, unknown>;
		runHarnessScope<T>(scope: Record<string, unknown>, action: () => T): T;
		removeHarnessScope(scope: Record<string, unknown>): void;
	};
	const { default: activateTokenUsage } = await import(pathToFileURL(join(ROOT, "dist", "compat", "pi-token-usage", "dist", "index.js")).href) as {
		default(pi: unknown): void;
	};

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// A) catalogOnly 直接调用：不注册任何事件与命令
		let catalogRegistrations = 0;
		const catalogScope = harness.createHarnessScope({
			sessionId: "usage-catalog-direct",
			cwd: workspace,
			agentDir,
			catalogOnly: true,
			loadPiCodingAgent: async () => sdk,
		});
		try {
			harness.runHarnessScope(catalogScope, () => activateTokenUsage({
				on() { catalogRegistrations += 1; },
				registerCommand() { catalogRegistrations += 1; },
			}));
		} finally {
			harness.removeHarnessScope(catalogScope);
		}
		assert.equal(catalogRegistrations, 0, "catalogOnly 模式不应注册 pi-token-usage 事件或命令");

		// B) catalogOnly 通过真实 DefaultResourceLoader 加载：无报错且不注册处理器或命令
		const tokenUsagePackageDir = join(ROOT, "dist", "compat", "pi-token-usage");
		const loaderScope = harness.createHarnessScope({
			sessionId: "usage-catalog-loader",
			cwd: workspace,
			agentDir,
			catalogOnly: true,
			loadPiCodingAgent: async () => sdk,
		});
		try {
			const loader = new sdk.DefaultResourceLoader({
				cwd: workspace,
				agentDir,
				settingsManager: sdk.SettingsManager.inMemory({ packages: [tokenUsagePackageDir] }),
			});
			await harness.runHarnessScope(loaderScope, () => loader.reload());
			assert.deepEqual(loader.getExtensions().errors, []);
			const usageExt = loader.getExtensions().extensions.find((ext) => ext.path.replaceAll("\\", "/").endsWith("/pi-token-usage/dist/index.js"));
			assert.ok(usageExt, "应加载 pi-token-usage 兼容扩展");
			assert.equal(usageExt.handlers.size, 0, "catalogOnly 模式不应注册 pi-token-usage 事件处理器");
			assert.equal(usageExt.commands.size, 0, "catalogOnly 模式不应注册 /usage 命令");
		} finally {
			harness.removeHarnessScope(loaderScope);
		}

		// C) 正常交互会话：session_start / turn_end / /usage footer 仅扫当日 mtime 文件，/usage 扫描全量历史
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
		const interactiveScope = harness.createHarnessScope({
			sessionId: "usage-interactive",
			cwd: workspace,
			agentDir,
			catalogOnly: false,
			loadPiCodingAgent: async () => sdk,
		});
		try {
			harness.runHarnessScope(interactiveScope, () => activateTokenUsage({
				on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
					handlers.set(event, handler);
				},
				registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
					commands.set(name, command);
				},
			}));

			assert.ok(handlers.has("session_start"), "交互会话应注册 session_start");
			assert.ok(handlers.has("turn_end"), "交互会话应注册 turn_end");
			assert.ok(commands.has("usage"), "交互会话应注册 /usage 命令");

			let lastStatus: string | undefined;
			let lastNotify: string | undefined;
			const ctx = {
				cwd: workspace,
				ui: {
					theme: { fg: (_name: string, text: string) => text },
					setStatus(key: string, text: string | undefined) {
						if (key === "token-usage") lastStatus = text;
					},
					notify(text: string) {
						lastNotify = text;
					},
				},
			};

			// session_start: 只统计当日文件，跳过 staleProbeFile ($99.00) 和 oldHistoryFile ($50.00)，仅输出 $3.50
			await handlers.get("session_start")!({}, ctx);
			assert.equal(lastStatus, "Proj today $3.50  •  Total today $3.50");

			// /usage footer show 同样走当日窗口，不读旧 mtime 探针文件
			await commands.get("usage")!.handler("footer show", ctx);
			assert.match(lastNotify ?? "", /Footer: enabled/);
			assert.equal(lastStatus, "Proj today $3.50  •  Total today $3.50");

			// 移除探针文件后向当日会话追加一条 $1.50 消息，验证 turn_end 实时更新到 $5.00
			await rm(staleProbeFile, { force: true });
			await appendFile(resumedTodayFile, makeUsageEntry("resumed-today-2", todayBase + 2_000, 1.5, 500, 250, "model-a") + "\n", "utf8");
			await handlers.get("turn_end")!({}, ctx);
			assert.equal(lastStatus, "Proj today $5.00  •  Total today $5.00");

			// 不调用 /usage refresh 直接调用 /usage：必须绕过当日窗口缓存并汇总全量历史 ($50 + $20 + $5 = $75.0)
			await commands.get("usage")!.handler("", ctx);
			const summary = stripAnsi(lastNotify ?? "");
			assert.match(summary, /Lifetime.*\$75\.0\b/, `Lifetime 应包含历史旧文件与跨天会话旧消息（$75.0），实际：\n${summary}`);
			assert.match(summary, /Today.*\$5\.00\b/, `Today 应为 $5.00，实际：\n${summary}`);

			await commands.get("usage")!.handler("models", ctx);
			const modelsOut = stripAnsi(lastNotify ?? "");
			assert.match(modelsOut, /test-provider\/model-old.*\$50\.0\b/, `models 应包含历史模型，实际：\n${modelsOut}`);
			assert.match(modelsOut, /test-provider\/model-a.*\$25\.0\b/, `models 应包含跨天会话合计模型（$25.0），实际：\n${modelsOut}`);
		} finally {
			harness.removeHarnessScope(interactiveScope);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
