import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadPiRuntime } from "../../src/pi/piRuntime";
import { ROOT } from "../environment";

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

test("加载全局安装的 Pi 并使用真实模块", async () => {
	await verifyRuntime("");
});

test("通过指定目录加载全局安装的 Pi", async () => {
	const runtime = await loadPiRuntime("");
	await verifyRuntime(runtime.packageDir);
});

test("加载开发依赖中的 Pi 并使用真实模块", async () => {
	await verifyRuntime(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
});
