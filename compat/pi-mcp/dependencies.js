import { join } from "node:path";
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
    ({ mcpNamespace } = modules[1]);
    ({ openBrowser } = modules[2]);
    ({ CODEMODE_TOOL_NAME } = modules[3]);
    ({ TOOL_SEARCH_TOOL_NAME } = modules[4]);
    ({ getMcpToolExposure, loadMcpConfig, updateMcpServerConfig } = modules[5]);
    ({ createMcpResourceToolDefinitions, LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL } = modules[6]);
    ({ loadMcpRuntime } = modules[7]);
    ({ createMcpToolDefinition, createMcpToolName, createMcpToolRenderers } = modules[8]);
    ({ showMcpManager } = modules[9]);
    configuredPackage = packageDir;
}
