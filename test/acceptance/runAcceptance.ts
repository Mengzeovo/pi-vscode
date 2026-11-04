import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJson } from "../../src/util/json";
import { createLayout, portableEnvironment, ROOT, VSCODE_EXECUTABLE, vscodeAppDirectory } from "../environment";
import { runWithDriver } from "../ui/launch";

const EXTENSION_ID = "local.pi-harness";
const USER_EXTENSIONS = join(homedir(), ".vscode", "extensions");

function installedIn(dir: string): boolean {
	return existsSync(dir) && readdirSync(dir).some((name) => name.toLowerCase().startsWith(EXTENSION_ID));
}

/**
 * 安装验收：VS Code 以便携模式运行，便携数据目录为本次验收的目录，argv.json、用户数据和扩展都在其中。
 * 用 VS Code 的命令行把 VSIX 安装到该目录，在 argv.json 中按扩展 ID 授权实验接口，以普通方式启动，
 * 由驱动扩展运行验收步骤并写出 acceptance.json。参数为 VSIX 路径，默认使用 npm run package 生成的文件。
 */
async function main(): Promise<void> {
	const manifest = parseJson<{ name: string; version: string }>(readFileSync(join(ROOT, "package.json"), "utf8"), "package.json");
	const vsix = process.argv[2] ?? join(ROOT, `${manifest.name}-${manifest.version}.vsix`);
	if (!existsSync(vsix)) {
		throw new Error(`没有找到 VSIX：${vsix}`);
	}
	if (installedIn(USER_EXTENSIONS)) {
		throw new Error(`${USER_EXTENSIONS} 中已有 ${EXTENSION_ID}，验收需要本机 VS Code 配置中没有这个扩展`);
	}

	const runName = `acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const layout = createLayout(runName);
	const portable = portableEnvironment(layout);
	writeFileSync(join(layout.base, "argv.json"), JSON.stringify({ "enable-proposed-api": [EXTENSION_ID] }, null, "\t"));

	const install = spawnSync(VSCODE_EXECUTABLE, [join(vscodeAppDirectory(), "out", "cli.js"), "--install-extension", vsix], {
		env: { ...process.env, ...portable, ELECTRON_RUN_AS_NODE: "1" },
		encoding: "utf8",
		windowsHide: true,
	});
	console.log(install.stdout, install.stderr);
	if (install.status !== 0) {
		throw new Error(`安装 VSIX 失败，退出码 ${install.status}`);
	}
	if (installedIn(USER_EXTENSIONS)) {
		throw new Error(`VSIX 被安装到了 ${USER_EXTENSIONS}，请卸载 ${EXTENSION_ID} 后检查 VSCODE_PORTABLE 为什么没有生效`);
	}
	if (!installedIn(layout.extensionsDir)) {
		throw new Error(`${layout.extensionsDir} 中没有 ${EXTENSION_ID}`);
	}

	const passed = await runWithDriver({ layout, runName, suite: "acceptance-suite", piHarness: "installed" });
	const record = join(layout.base, "acceptance.json");
	if (existsSync(record)) {
		console.log(readFileSync(record, "utf8"));
	}
	if (installedIn(USER_EXTENSIONS)) {
		throw new Error(`验收结束后 ${USER_EXTENSIONS} 中出现了 ${EXTENSION_ID}`);
	}
	if (!passed) {
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
