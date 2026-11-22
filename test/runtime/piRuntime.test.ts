import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPiRuntime, PI_PACKAGE_NAME, resolvePiPackage } from "../../src/pi/piRuntime";
import { ROOT } from "../environment";

const tempDirs: string[] = [];

after(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-runtime-test-"));
	tempDirs.push(dir);
	return dir;
}

async function createFakePackage(packageDir: string, version = "1.6.0"): Promise<string> {
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: PI_PACKAGE_NAME, version }), "utf8");
	return packageDir;
}

async function createManagedInstall(
	installRoot: string,
	options?: {
		readonly version?: string;
		readonly currentVersionText?: string;
		readonly markerText?: string;
		readonly createPackage?: boolean;
	},
): Promise<string> {
	const version = options?.version ?? "1.6.0";
	await mkdir(installRoot, { recursive: true });
	await writeFile(
		join(installRoot, "managed-install.json"),
		options?.markerText ?? JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
		"utf8",
	);
	await writeFile(join(installRoot, "current-version"), options?.currentVersionText ?? `${version}\n`, "utf8");
	const packageDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	if (options?.createPackage !== false) {
		await createFakePackage(packageDir, version);
	}
	return packageDir;
}

async function verifyRuntime(packagePath: string): Promise<void> {
	const runtime = await loadPiRuntime(packagePath);
	const manifest = JSON.parse(await readFile(join(runtime.packageDir, "package.json"), "utf8"));
	assert.equal(runtime.version, manifest.version);
	assert.equal(typeof runtime.modules.SessionManager.create, "function");
	assert.equal(typeof runtime.modules.getAgentDir(), "string");
	assert.equal(typeof runtime.modules.expandTildePath("~"), "string");
	assert.equal(typeof runtime.modules.attachJsonlLineReader, "function");
	assert.deepEqual(runtime.modules.parseSessionEntries(""), []);
	assert.equal(JSON.parse(runtime.modules.serializeJsonLine({ version: runtime.version })).version, runtime.version);
}

test("加载本机默认定位的 Pi 并使用真实模块", async () => {
	await verifyRuntime("");
});

test("通过指定目录加载本机安装的 Pi", async () => {
	const runtime = await loadPiRuntime("");
	await verifyRuntime(runtime.packageDir);
});

test("加载开发依赖中的 Pi 并使用真实模块", async () => {
	await verifyRuntime(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
});

test("resolvePiPackage 优先使用显式配置路径且不查询全局 npm", async () => {
	const temp = await createTempDir();
	await createManagedInstall(join(temp, "home", ".pi", "agent", "install"));
	const explicitPath = join(temp, "custom-pi");
	let npmCalled = false;

	const resolved = await resolvePiPackage(`  ${explicitPath}  `, {
		homeDir: join(temp, "home"),
		env: { PI_MANAGED_INSTALL_ROOT: join(temp, "managed") },
		npmGlobalRoot: async () => {
			npmCalled = true;
			return join(temp, "npm-global");
		},
	});

	assert.deepEqual(resolved, { packageDir: explicitPath });
	assert.equal(npmCalled, false);
});

test("resolvePiPackage 优先使用 PI_MANAGED_INSTALL_ROOT", async () => {
	const temp = await createTempDir();
	const homeDir = join(temp, "home");
	const managedRoot = join(temp, "custom-managed");
	const expectedPkg = await createManagedInstall(managedRoot, { version: "1.6.1" });
	await createManagedInstall(join(temp, "agent-dir", "install"), { version: "1.6.0" });
	await createManagedInstall(join(homeDir, ".pi", "agent", "install"), { version: "1.5.9" });

	const resolved = await resolvePiPackage("", {
		homeDir,
		env: {
			PI_MANAGED_INSTALL_ROOT: managedRoot,
			PI_CODING_AGENT_DIR: join(temp, "agent-dir"),
		},
		npmGlobalRoot: async () => {
			throw new Error("should not call npmGlobalRoot");
		},
	});

	assert.deepEqual(resolved, { packageDir: expectedPkg, managedInstallRoot: managedRoot });
});

test("resolvePiPackage 支持 PI_CODING_AGENT_DIR 并展开开头 ~", async () => {
	const temp = await createTempDir();
	const homeDir = join(temp, "home");
	const expectedRoot = join(homeDir, "custom-agent", "install");
	const expectedPkg = await createManagedInstall(expectedRoot, { version: "1.6.2" });

	const resolved = await resolvePiPackage("", {
		homeDir,
		env: { PI_CODING_AGENT_DIR: "~/custom-agent" },
		npmGlobalRoot: async () => join(temp, "npm-global"),
	});

	assert.deepEqual(resolved, { packageDir: expectedPkg, managedInstallRoot: expectedRoot });
});

test("resolvePiPackage 从默认 ~/.pi/agent/install 解析托管安装并兼容 UTF-8 BOM", async () => {
	const temp = await createTempDir();
	const homeDir = join(temp, "home");
	const installRoot = join(homeDir, ".pi", "agent", "install");
	const expectedPkg = await createManagedInstall(installRoot, {
		version: "1.6.0",
		markerText: `\uFEFF${JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" })}`,
		currentVersionText: "\uFEFF  1.6.0 \r\n",
	});

	const resolved = await resolvePiPackage("", {
		homeDir,
		env: {},
		npmGlobalRoot: async () => join(temp, "npm-global"),
	});

	assert.deepEqual(resolved, { packageDir: expectedPkg, managedInstallRoot: installRoot });
});

test("resolvePiPackage 在无 managed-install.json 时回退到 npm root -g", async () => {
	const temp = await createTempDir();
	const homeDir = join(temp, "home");
	const npmRoot = join(temp, "npm-root");
	const expectedPkg = await createFakePackage(join(npmRoot, "@earendil-works", "pi-coding-agent"), "1.5.2");

	const resolved = await resolvePiPackage("", {
		homeDir,
		env: {},
		npmGlobalRoot: async () => npmRoot,
	});

	assert.deepEqual(resolved, { packageDir: expectedPkg });
});

test("resolvePiPackage 在 current-version 非法或 release 缺失时回退并在全部失败时给出明确错误", async () => {
	const temp = await createTempDir();
	const homeDir = join(temp, "home");
	const installRoot = join(homeDir, ".pi", "agent", "install");
	const npmRoot = join(temp, "npm-root");
	const fallbackPkg = await createFakePackage(join(npmRoot, "@earendil-works", "pi-coding-agent"), "1.5.2");

	await createManagedInstall(installRoot, { currentVersionText: "../bad", createPackage: false });
	const fallbackOnBadVersion = await resolvePiPackage("", {
		homeDir,
		env: {},
		npmGlobalRoot: async () => npmRoot,
	});
	assert.deepEqual(fallbackOnBadVersion, { packageDir: fallbackPkg });

	await createManagedInstall(installRoot, { version: "1.6.0", createPackage: false });
	const fallbackOnMissingRelease = await resolvePiPackage("", {
		homeDir,
		env: {},
		npmGlobalRoot: async () => npmRoot,
	});
	assert.deepEqual(fallbackOnMissingRelease, { packageDir: fallbackPkg });

	const emptyNpmRoot = join(temp, "empty-npm-root");
	await assert.rejects(
		resolvePiPackage("", {
			homeDir,
			env: {},
			npmGlobalRoot: async () => emptyNpmRoot,
		}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /未找到 @earendil-works\/pi-coding-agent/);
			assert.ok(error.message.includes(installRoot));
			assert.ok(error.message.includes("1.6.0"));
			assert.ok(error.message.includes(emptyNpmRoot));
			assert.match(error.message, /piHarness\.piPackagePath/);
			return true;
		},
	);
});
