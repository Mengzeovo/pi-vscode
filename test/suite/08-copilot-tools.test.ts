import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { COPILOT_TOOL_NAMES } from "../../shared/protocol";
import { harness } from "./helpers";

describe("Copilot 工具", () => {
	it("列出 VS Code 中实际存在的 Copilot 工具", async () => {
		await harness();
		const names = vscode.lm.tools.map((tool) => tool.name);
		console.log(`[测试] vscode.lm.tools（${names.length} 个）：${names.join(", ")}`);
		const present = COPILOT_TOOL_NAMES.filter((name) => names.includes(name));
		console.log(`[测试] 支持的 Copilot 工具中存在：${present.join(", ") || "无"}`);
		assert.ok(Array.isArray(names));
	});
});
