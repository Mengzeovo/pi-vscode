import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type * as Pi from "@earendil-works/pi-coding-agent";
import * as semver from "semver";
import { parseJson } from "../util/json";

const execFileAsync = promisify(execFile);

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MANAGED_INSTALL_MARKER = "managed-install.json";
const MANAGED_VERSION_RE = /^[0-9A-Za-z._+-]+$/;

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
	readonly managedInstallRoot?: string;
	readonly version: string;
	readonly cliEntry: string;
	readonly nodeExecutable: string;
	readonly nodeVersion: string;
	readonly modules: PiModules;
}

export interface PiPackageResolution {
	readonly packageDir: string;
	readonly managedInstallRoot?: string;
}

export interface PiPackageResolveOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly npmGlobalRoot?: () => Promise<string>;
}

interface PiPackageJson {
	readonly name: string;
	readonly version: string;
	readonly bin?: string | { readonly pi?: string };
	readonly engines?: { readonly node?: string };
}

interface ManagedInstallMarker {
	readonly kind?: unknown;
	readonly schemaVersion?: unknown;
	readonly layout?: unknown;
}

function stripBom(text: string): string {
	return text.replace(/^\uFEFF/, "");
}

function expandLeadingTilde(value: string, homeDir: string): string {
	if (value === "~") {
		return resolve(homeDir);
	}
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolve(homeDir, value.slice(2));
	}
	return resolve(value);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function defaultNpmGlobalRoot(): Promise<string> {
	// Windows 上 npm 是 npm.cmd，经 cmd.exe 调用可避免 Node 24 的 DEP0190 警告
	const { stdout } = process.platform === "win32"
		? await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { windowsHide: true })
		: await execFileAsync("npm", ["root", "-g"], { windowsHide: true });
	return stdout.trim();
}

function collectManagedCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
	const rawCandidates: string[] = [];
	const configuredRoot = env.PI_MANAGED_INSTALL_ROOT?.trim();
	if (configuredRoot) {
		rawCandidates.push(expandLeadingTilde(configuredRoot, homeDir));
	}
	const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configuredAgentDir ? expandLeadingTilde(configuredAgentDir, homeDir) : join(homeDir, ".pi", "agent");
	rawCandidates.push(resolve(agentDir, "install"));

	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of rawCandidates) {
		const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(candidate);
		}
	}
	return unique;
}

async function tryResolveManagedInstall(installRoot: string): Promise<{ resolution?: PiPackageResolution; reason: string }> {
	const markerPath = join(installRoot, MANAGED_INSTALL_MARKER);
	let markerText: string;
	try {
		markerText = await readFile(markerPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { reason: `未找到 ${MANAGED_INSTALL_MARKER}` };
		}
		return { reason: `读取 ${MANAGED_INSTALL_MARKER} 失败：${error instanceof Error ? error.message : String(error)}` };
	}

	try {
		const marker = parseJson<ManagedInstallMarker>(stripBom(markerText), markerPath);
		if (
			marker === null ||
			typeof marker !== "object" ||
			marker.kind !== "pi-managed-install" ||
			marker.schemaVersion !== 1 ||
			marker.layout !== "releases-v1"
		) {
			return { reason: `${MANAGED_INSTALL_MARKER} 格式无效` };
		}
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}

	const currentVersionPath = join(installRoot, "current-version");
	let currentVersion: string;
	try {
		currentVersion = stripBom(await readFile(currentVersionPath, "utf8")).trim();
	} catch (error) {
		return { reason: `读取 current-version 失败：${error instanceof Error ? error.message : String(error)}` };
	}

	if (!currentVersion || currentVersion === "." || currentVersion === ".." || !MANAGED_VERSION_RE.test(currentVersion)) {
		return { reason: `current-version 内容无效：${JSON.stringify(currentVersion)}` };
	}

	const packageDir = join(installRoot, "releases", currentVersion, "node_modules", "@earendil-works", "pi-coding-agent");
	if (!(await fileExists(join(packageDir, "package.json")))) {
		return { reason: `缺少版本 ${currentVersion} 的 ${PI_PACKAGE_NAME}（${packageDir}）` };
	}

	return {
		resolution: { packageDir, managedInstallRoot: installRoot },
		reason: "",
	};
}

/** 解析 Pi 包目录：显式配置 > Pi 托管安装（PI_MANAGED_INSTALL_ROOT / PI_CODING_AGENT_DIR / ~/.pi/agent/install）> npm root -g */
export async function resolvePiPackage(configuredPath: string, options?: PiPackageResolveOptions): Promise<PiPackageResolution> {
	const explicit = configuredPath.trim();
	if (explicit.length > 0) {
		return { packageDir: explicit };
	}

	const env = options?.env ?? process.env;
	const homeDir = options?.homeDir ?? homedir();
	const managedCandidates = collectManagedCandidates(env, homeDir);
	const checkedManaged: string[] = [];

	for (const installRoot of managedCandidates) {
		const attempt = await tryResolveManagedInstall(installRoot);
		if (attempt.resolution) {
			return attempt.resolution;
		}
		checkedManaged.push(`${installRoot}（${attempt.reason}）`);
	}

	const getNpmRoot = options?.npmGlobalRoot ?? defaultNpmGlobalRoot;
	let globalDetail: string;
	try {
		const root = (await getNpmRoot()).trim();
		if (root.length === 0) {
			globalDetail = "npm root -g 返回空路径";
		} else {
			const globalDir = join(root, "@earendil-works", "pi-coding-agent");
			if (await fileExists(join(globalDir, "package.json"))) {
				return { packageDir: globalDir };
			}
			globalDetail = `缺少 ${join(globalDir, "package.json")}`;
		}
	} catch (error) {
		globalDetail = `执行 npm root -g 失败：${error instanceof Error ? error.message : String(error)}`;
	}

	const details = [...checkedManaged.map((item) => `- 托管安装：${item}`), `- 全局 npm：${globalDetail}`].join("\n");
	throw new Error(`未找到 ${PI_PACKAGE_NAME}：\n${details}\n请先安装 Pi，或在设置中配置 piHarness.piPackagePath。`);
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
	const { packageDir, managedInstallRoot } = await resolvePiPackage(configuredPackagePath);
	const manifestPath = join(packageDir, "package.json");
	const manifest = parseJson<PiPackageJson>(stripBom(await readFile(manifestPath, "utf8")), manifestPath);
	if (manifest.name !== PI_PACKAGE_NAME) {
		throw new Error(`${packageDir} 中的包是 ${manifest.name}，需要 ${PI_PACKAGE_NAME}`);
	}
	const binRelative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (!binRelative) {
		throw new Error(`${manifestPath} 未声明 pi 可执行入口`);
	}
	const node = await resolveNode(manifest.engines?.node ?? ">=24.15.0");

	// 只导入导入时不写文件的模块；settings-manager 会加文件锁并修改全局 fs，不在扩展宿主中加载
	const sessionModule = await importFile<Pick<PiModules, "SessionManager" | "parseSessionEntries">>(join(packageDir, "dist", "core", "session-manager.js"));
	const configModule = await importFile<Pick<PiModules, "getAgentDir" | "expandTildePath">>(join(packageDir, "dist", "config.js"));
	const jsonlModule = await importFile<Pick<PiModules, "serializeJsonLine" | "attachJsonlLineReader">>(join(packageDir, "dist", "modes", "rpc", "jsonl.js"));

	return {
		packageDir,
		...(managedInstallRoot ? { managedInstallRoot } : {}),
		version: manifest.version,
		cliEntry: join(packageDir, binRelative),
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

