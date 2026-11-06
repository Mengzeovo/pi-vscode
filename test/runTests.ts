import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTests } from "@vscode/test-electron";
import { createLayout, portableEnvironment, ROOT, VSCODE_EXECUTABLE } from "./environment";

/**
 * 在扩展宿主中运行扩展测试。参数 `--no-proposed` 时不传入 --enable-proposed-api，只运行缺少授权的测试；
 * 其余参数作为测试名称过滤条件。
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const withoutProposed = args.includes("--no-proposed");
	const grep = args.find((arg) => !arg.startsWith("--"));
	const runName = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const layout = createLayout(runName);
	const workspaceFile = join(layout.base, "tests.code-workspace");
	writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: layout.workspaceA }] }));
	const suite = withoutProposed ? "no-proposed-suite" : "suite";
	const portable = portableEnvironment(layout);
	await runTests({
		vscodeExecutablePath: VSCODE_EXECUTABLE,
		extensionDevelopmentPath: ROOT,
		extensionTestsPath: join(ROOT, "dist", "test", suite, "index.js"),
		launchArgs: [
			workspaceFile,
			...(withoutProposed ? [] : ["--enable-proposed-api=local.pi-harness"]),
			// 与便携模式的目录相同；不传入时 @vscode/test-electron 会改用 .vscode-test 中的目录
			`--user-data-dir=${layout.userDataDir}`,
			`--extensions-dir=${layout.extensionsDir}`,
			...(process.env.PI_HARNESS_TEST_TRACE === "1" ? ["--log=trace"] : []),
		],
		// @vscode/test-electron 把这些变量加入 VS Code 进程的环境，主进程启动时读取 VSCODE_PORTABLE
		extensionTestsEnv: {
			...portable,
			PI_CODING_AGENT_SESSION_DIR: layout.sessionDir,
			PI_SUBAGENTS_TEMP_ROOT: join(layout.base, "subagents"),
			PI_HARNESS_TEST_RUN: runName,
			PI_HARNESS_TEST_WORKSPACE_A: layout.workspaceA,
			PI_HARNESS_TEST_WORKSPACE_B: layout.workspaceB,
			PI_HARNESS_TEST_SESSIONS: layout.sessionDir,
			PI_HARNESS_TEST_ROOT: ROOT,
			PI_HARNESS_TEST_WORK: layout.base,
			PI_HARNESS_TEST_RESULTS: join(layout.base, "results.json"),
			...(grep !== undefined ? { PI_HARNESS_TEST_GREP: grep } : {}),
		},
	});
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
