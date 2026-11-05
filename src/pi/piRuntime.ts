import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type * as Pi from "@earendil-works/pi-coding-agent";
import * as semver from "semver";
import { parseJson } from "../util/json";

const execFileAsync = promisify(execFile);

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const SUPPORTED_PI_RANGE = "1.5.0";

export interface PiModules {
	readonly SessionManager: typeof Pi.SessionManager;
	readonly parseSessionEntries: typeof Pi.parseSessionEntries;
	readonly getAgentDir: typeof Pi.getAgentDir;
	readonly expandTildePath: (path: string) => string;
	readonly serializeJsonLine: (value: unknown) => string;
	readonly attachJsonlLineReader: (stream: Readable, onLine: (line: string) => void) => () => void;
}

export interface PiRuntime {
	readonly packageDir: string;
	readonly version: string;
	readonly cliEntry: string;
	readonly nodeExecutable: string;
	readonly nodeVersion: string;
	readonly modules: PiModules;
}

interface PiPackageJson {
	readonly name: string;
	readonly version: string;
	readonly bin: { readonly pi: string };
	readonly engines: { readonly node: string };
}

async function resolvePackageDir(configuredPath: string): Promise<string> {
	if (configuredPath.length > 0) {
		return configuredPath;
	}
	// Windows 上 npm 是 npm.cmd，需要经过 shell 启动
	const { stdout } = await execFileAsync("npm", ["root", "-g"], { shell: process.platform === "win32", windowsHide: true });
	return join(stdout.trim(), "@earendil-works", "pi-coding-agent");
}

async function resolveNode(engineRange: string): Promise<{ execPath: string; version: string }> {
	const { stdout } = await execFileAsync("node", ["-p", "JSON.stringify({ execPath: process.execPath, version: process.version })"], { windowsHide: true });
	const info = parseJson<{ execPath: string; version: string }>(stdout, "node -p");
	if (!semver.satisfies(info.version, engineRange)) {
		throw new Error(`PATH 中的 node ${info.version}（${info.execPath}）不满足 Pi 要求的 ${engineRange}`);
	}
	if (!semver.satisfies(info.version, ">=24.15.0")) {
		throw new Error(`Pi Harness 后台需要 Node.js 24.15.0 或更新版本，当前为 ${info.version}（${info.execPath}）`);
	}
	return info;
}

async function importFile<T>(file: string): Promise<T> {
	return (await import(pathToFileURL(file).href)) as T;
}

export async function loadPiRuntime(configuredPackagePath: string): Promise<PiRuntime> {
	const packageDir = await resolvePackageDir(configuredPackagePath);
	const manifestPath = join(packageDir, "package.json");
	const manifest = parseJson<PiPackageJson>(await readFile(manifestPath, "utf8"), manifestPath);
	if (manifest.name !== PI_PACKAGE_NAME) {
		throw new Error(`${packageDir} 中的包是 ${manifest.name}，需要 ${PI_PACKAGE_NAME}`);
	}
	if (!semver.satisfies(manifest.version, SUPPORTED_PI_RANGE)) {
		throw new Error(`已安装的 Pi 版本 ${manifest.version} 不在支持范围 ${SUPPORTED_PI_RANGE} 内`);
	}
	const node = await resolveNode(manifest.engines.node);

	// 只导入导入时不写文件的模块；settings-manager 会加文件锁并修改全局 fs，不在扩展宿主中加载
	const sessionModule = await importFile<Pick<PiModules, "SessionManager" | "parseSessionEntries">>(join(packageDir, "dist", "core", "session-manager.js"));
	const configModule = await importFile<Pick<PiModules, "getAgentDir" | "expandTildePath">>(join(packageDir, "dist", "config.js"));
	const jsonlModule = await importFile<Pick<PiModules, "serializeJsonLine" | "attachJsonlLineReader">>(join(packageDir, "dist", "modes", "rpc", "jsonl.js"));

	return {
		packageDir,
		version: manifest.version,
		cliEntry: join(packageDir, manifest.bin.pi),
		nodeExecutable: node.execPath,
		nodeVersion: node.version,
		modules: {
			SessionManager: sessionModule.SessionManager,
			parseSessionEntries: sessionModule.parseSessionEntries,
			getAgentDir: configModule.getAgentDir,
			expandTildePath: configModule.expandTildePath,
			serializeJsonLine: jsonlModule.serializeJsonLine,
			attachJsonlLineReader: jsonlModule.attachJsonlLineReader,
		},
	};
}

