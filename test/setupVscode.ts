import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseJson } from "../src/util/json";
import { WORK } from "./environment";

const TEST_VSCODE = join(WORK, "vscode");

/** Code.exe 文件版本信息中的产品版本 */
function productVersion(executable: string): string {
	const literal = executable.replaceAll("'", "''");
	return execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion`], {
		encoding: "utf8",
		windowsHide: true,
	}).trim();
}

/**
 * 准备测试用的 VS Code：把已安装的 VS Code 复制到 .test-work/vscode，删去 product.json 中的 target，并在 Code.exe 旁建立 data 目录。
 * product.json 没有 target 时 VS Code 支持便携模式：测试通过 VSCODE_PORTABLE 让每次运行使用自己的数据目录，
 * 直接启动副本时使用旁边的 data 目录，两种情况都不读写本机 VS Code 的配置。参数为已安装的 Code.exe 路径。
 */
function main(): void {
	const executable = process.argv[2];
	if (executable === undefined || !existsSync(executable)) {
		throw new Error("用法：node dist/test/setupVscode.js <已安装的 Code.exe 路径>");
	}
	const installDir = dirname(executable);
	const version = productVersion(executable);
	// 安装程序在后台准备更新时，安装目录中同时有新旧两个版本目录，选取与 Code.exe 版本相同的目录
	const versionDirs = readdirSync(installDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(installDir, entry.name, "resources", "app", "package.json")))
		.map((entry) => entry.name)
		.filter((name) => {
			const file = join(installDir, name, "resources", "app", "package.json");
			return parseJson<{ version: string }>(readFileSync(file, "utf8"), file).version === version;
		});
	if (versionDirs.length !== 1) {
		throw new Error(`${installDir} 中版本为 ${version} 的版本目录应当正好有一个，实际有 ${versionDirs.length} 个`);
	}
	const [versionDir] = versionDirs;
	rmSync(TEST_VSCODE, { recursive: true, force: true });
	mkdirSync(TEST_VSCODE, { recursive: true });
	copyFileSync(executable, join(TEST_VSCODE, basename(executable)));
	const manifest = join(installDir, `${basename(executable, ".exe")}.VisualElementsManifest.xml`);
	if (existsSync(manifest)) {
		copyFileSync(manifest, join(TEST_VSCODE, basename(manifest)));
	}
	cpSync(join(installDir, versionDir), join(TEST_VSCODE, versionDir), { recursive: true });
	const productFile = join(TEST_VSCODE, versionDir, "resources", "app", "product.json");
	const product = parseJson<Record<string, unknown>>(readFileSync(productFile, "utf8"), productFile);
	delete product.target;
	writeFileSync(productFile, `${JSON.stringify(product, null, "\t")}\n`);
	mkdirSync(join(TEST_VSCODE, "data"), { recursive: true });
	console.log(`测试用的 VS Code：${join(TEST_VSCODE, basename(executable))}（版本 ${version}，提交 ${String(product.commit)}）`);
}

main();
