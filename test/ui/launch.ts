import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "../../src/util/json";
import { CDP_PORT, portableEnvironment, ROOT, type TestLayout, VSCODE_EXECUTABLE } from "../environment";

const TIMEOUT_MS = 90 * 60_000;

interface TestOutcome {
	readonly title: string;
	readonly state: "passed" | "failed";
	readonly durationMs: number | undefined;
	readonly error: string | undefined;
}

export interface DriverRun {
	readonly layout: TestLayout;
	readonly runName: string;
	/** dist/test 下的测试目录名 */
	readonly suite: string;
	/**
	 * source：从源码目录以开发模式加载 Pi Harness，用命令行参数授权实验接口；
	 * installed：使用已安装到便携数据目录 extensions 中的 Pi Harness，授权来自便携数据目录中的 argv.json。
	 */
	readonly piHarness: "source" | "installed";
	readonly phase?: string;
	readonly grep?: string;
}

/**
 * 以普通方式启动 VS Code（不使用 --extensionTestsPath，VS Code 才会显示模态对话框），
 * 由驱动扩展在扩展宿主中运行 suite 中的测试，测试通过 Chrome DevTools Protocol 操作工作台。
 * VS Code 以便携模式运行，便携数据目录为本次运行的目录。返回测试是否全部通过。
 */
export async function runWithDriver(run: DriverRun): Promise<boolean> {
	const done = join(run.layout.base, "ui-done.json");
	const results = join(run.layout.base, "ui-results.json");
	rmSync(done, { force: true });
	rmSync(results, { force: true });
	const portable = portableEnvironment(run.layout);
	const sourceArgs =
		run.piHarness === "source"
			? [`--extensionDevelopmentPath=${ROOT}`, "--enable-proposed-api=local.pi-harness", "--no-sandbox", "--disable-gpu-sandbox", "--no-cached-data"]
			: [];
	const child = spawn(
		VSCODE_EXECUTABLE,
		[
			run.layout.workspaceA,
			`--user-data-dir=${run.layout.userDataDir}`,
			`--extensions-dir=${run.layout.extensionsDir}`,
			"--new-window",
			...sourceArgs,
			`--extensionDevelopmentPath=${join(ROOT, "test", "driver-extension")}`,
			`--remote-debugging-port=${CDP_PORT}`,
			"--disable-updates",
			"--skip-welcome",
			"--skip-release-notes",
			"--disable-workspace-trust",
		],
		{
			env: {
				...process.env,
				...portable,
				PI_CODING_AGENT_SESSION_DIR: run.layout.sessionDir,
				PI_SUBAGENTS_TEMP_ROOT: join(run.layout.base, "subagents"),
				PI_HARNESS_TEST_RUN: run.runName,
				PI_HARNESS_TEST_WORKSPACE_A: run.layout.workspaceA,
				PI_HARNESS_TEST_WORKSPACE_B: run.layout.workspaceB,
				PI_HARNESS_TEST_SESSIONS: run.layout.sessionDir,
				PI_HARNESS_TEST_CDP_PORT: String(CDP_PORT),
				PI_HARNESS_TEST_ROOT: ROOT,
				PI_HARNESS_TEST_WORK: run.layout.base,
				PI_HARNESS_TEST_RESULTS: results,
				PI_HARNESS_UI_SUITE: join(ROOT, "dist", "test", run.suite, "index.js"),
				PI_HARNESS_UI_DONE: done,
				...(run.phase !== undefined ? { PI_HARNESS_UI_PHASE: run.phase } : {}),
				...(run.grep !== undefined ? { PI_HARNESS_TEST_GREP: run.grep } : {}),
			},
			stdio: "inherit",
		},
	);
	let processExited = false;
	let forcedExit = false;
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => { processExited = true; resolve(code); }));
	const killTree = (): void => {
		if (!processExited && child.pid !== undefined) {
			forcedExit = true;
			spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
		}
	};
	const timer = setTimeout(killTree, TIMEOUT_MS);
	let forcedExitTimer: ReturnType<typeof setTimeout> | undefined;
	// 驱动扩展写入结束标记后请求退出；仍有 Pi 会话在运行时 VS Code 会询问是否退出，等待一段时间后结束进程树
	const poll = setInterval(() => {
		if (existsSync(done)) {
			clearInterval(poll);
			forcedExitTimer = setTimeout(killTree, 20_000);
		}
	}, 1000);
	const code = await exited;
	clearTimeout(timer);
	clearTimeout(forcedExitTimer);
	clearInterval(poll);
	console.log(`VS Code 退出，退出码 ${code ?? "无"}；测试目录 ${run.layout.base}`);
	if (existsSync(results)) {
		for (const outcome of parseJson<TestOutcome[]>(readFileSync(results, "utf8"), results)) {
			console.log(`${outcome.state === "passed" ? "通过" : "失败"}  ${outcome.title}${outcome.durationMs !== undefined ? `（${outcome.durationMs} ms）` : ""}`);
			if (outcome.error !== undefined) {
				console.log(outcome.error);
			}
		}
	}
	if (!existsSync(done)) {
		console.log("测试没有完成（没有结束标记文件）");
		return false;
	}
	const outcome = parseJson<{ ok: boolean; error?: string }>(readFileSync(done, "utf8"), done);
	if (!outcome.ok) {
		console.log(`测试失败：${outcome.error ?? ""}`);
	}
	if (forcedExit) console.log("测试窗口未正常退出，进程已终止");
	return outcome.ok && !forcedExit && code === 0;
}
