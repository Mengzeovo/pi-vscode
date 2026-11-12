import * as assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadPiRuntime } from "../../src/pi/piRuntime";
import { ROOT } from "../environment";

for (const [name, packagePath] of [["全局安装", ""], ["开发依赖", join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent")]]) {
	test(`${name}的 Pi 提供完整 MCP 接口`, async () => {
		const runtime = await loadPiRuntime(packagePath);
		const moduleUrl = pathToFileURL(join(ROOT, "compat", "pi-mcp", "dependencies.js"));
		moduleUrl.searchParams.set("installation", name);
		const dependencies = await import(moduleUrl.href);
		await dependencies.configureMcpDependencies(runtime.packageDir);
		for (const key of ["getAgentDir", "mcpNamespace", "openBrowser", "getMcpToolExposure", "loadMcpConfig", "updateMcpServerConfig",
			"createMcpResourceToolDefinitions", "loadMcpRuntime", "createMcpToolDefinition", "createMcpToolName", "createMcpToolRenderers", "showMcpManager"]) {
			assert.equal(typeof dependencies[key], "function", key);
		}
		for (const key of ["CODEMODE_TOOL_NAME", "TOOL_SEARCH_TOOL_NAME", "LIST_MCP_RESOURCE_TEMPLATES_TOOL", "LIST_MCP_RESOURCES_TOOL", "READ_MCP_RESOURCE_TOOL"]) {
			assert.equal(typeof dependencies[key], "string", key);
		}
		assert.equal(dependencies.mcpNamespace("claude-mem"), "mcp__claude_mem");
		assert.equal(dependencies.createMcpToolName("claude-mem", "work_state_read"), "mcp__claude_mem__work_state_read");
	});
}
