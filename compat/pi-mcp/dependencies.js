import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export let getAgentDir, mcpNamespace, openBrowser, CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME;
export let getMcpToolExposure, loadMcpConfig, updateMcpServerConfig;
export let createMcpResourceToolDefinitions, LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL;
export let loadMcpRuntime, createMcpToolDefinition, createMcpToolName, createMcpToolRenderers, showMcpManager;
let configuredPackage;

export async function configureMcpDependencies(packageDir) {
    if (configuredPackage && configuredPackage !== packageDir)
        throw new Error("同一后台只能使用一个 Pi SDK 安装目录");
    const load = (file) => import(pathToFileURL(join(packageDir, "dist", file)).href);
    const modules = await Promise.all([
        load("config.js"), load("core/mcp-servers.js"), load("utils/open-browser.js"),
        load("extensions/codemode/tool.js"), load("extensions/tool-search/tool.js"),
        load("extensions/mcp/config.js"), load("extensions/mcp/resources.js"),
        load("extensions/mcp/runtime.lazy.js"), load("extensions/mcp/tools.js"), load("extensions/mcp/ui.js"),
    ]);
    ({ getAgentDir } = modules[0]);
    ({ openBrowser } = modules[2]);
    ({ CODEMODE_TOOL_NAME } = modules[3]);
    ({ TOOL_SEARCH_TOOL_NAME } = modules[4]);
    ({ getMcpToolExposure, loadMcpConfig, updateMcpServerConfig } = modules[5]);
    ({ createMcpResourceToolDefinitions, LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL } = modules[6]);
    ({ loadMcpRuntime } = modules[7]);
    ({ createMcpToolDefinition, createMcpToolRenderers } = modules[8]);
    ({ showMcpManager } = modules[9]);
    if (typeof modules[1].mcpNamespace === "function") {
        ({ mcpNamespace } = modules[1]);
        ({ createMcpToolName } = modules[8]);
    } else {
        const manifestPath = findPackageJSON("@earendil-works/pi-mcp", pathToFileURL(join(packageDir, "package.json")));
        if (!manifestPath) throw new Error("当前 Pi 安装目录缺少 MCP 依赖");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const mcp = await import(pathToFileURL(join(dirname(manifestPath), manifest.main)).href);
        ({ mcpNamespace, createMcpToolName } = mcp);
    }
    if (typeof mcpNamespace !== "function" || typeof createMcpToolName !== "function")
        throw new Error("当前 Pi 安装目录缺少 MCP 工具命名接口");
    configuredPackage = packageDir;
}
