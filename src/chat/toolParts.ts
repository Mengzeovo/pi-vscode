import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";

export const OPEN_DIFF_COMMAND = "piHarness.openDiff";

interface ToolResultLike {
	readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export function toolResultText(result: unknown): string {
	const content = (result as ToolResultLike | undefined)?.content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function fileUri(cwd: string, path: string): vscode.Uri {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	return vscode.Uri.file(isAbsolute(normalized) ? normalized : resolve(cwd, normalized));
}

function fileLink(cwd: string, path: string): string {
	const uri = fileUri(cwd, path);
	return `[${path}](${uri.toString()})`;
}

function diffLink(sessionId: string, toolCallId: string): string {
	const args = encodeURIComponent(JSON.stringify([sessionId, toolCallId]));
	return `[打开差异](command:${OPEN_DIFF_COMMAND}?${args})`;
}

function trustedMarkdown(value: string): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(value);
	markdown.isTrusted = { enabledCommands: [OPEN_DIFF_COMMAND] };
	return markdown;
}

export interface ToolPartInput {
	readonly sessionId: string;
	readonly cwd: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

export interface ToolPartOutcome {
	readonly complete: boolean;
	readonly isError: boolean;
	readonly outputText: string | undefined;
}

/** 按工具类型生成聊天中的工具调用条目；同一 toolCallId 的多次输出会更新同一条目 */
export function createToolPart(input: ToolPartInput, outcome: ToolPartOutcome): vscode.ChatToolInvocationPart {
	const part = new vscode.ChatToolInvocationPart(input.toolName, input.toolCallId, outcome.isError ? outcome.outputText : undefined);
	part.enablePartialUpdate = true;
	part.isComplete = outcome.complete;
	part.isError = outcome.isError;
	const path = typeof input.args.path === "string" ? input.args.path : undefined;
	switch (input.toolName) {
		case "bash":
		case "powershell": {
			const command = typeof input.args.command === "string" ? input.args.command : "";
			part.invocationMessage = "运行命令";
			part.pastTenseMessage = outcome.isError ? "命令失败" : "已运行命令";
			part.toolSpecificData = {
				commandLine: { original: command },
				language: input.toolName === "bash" ? "bash" : "powershell",
				output: outcome.outputText !== undefined ? { text: outcome.outputText } : undefined,
			};
			break;
		}
		case "read": {
			const link = path ? fileLink(input.cwd, path) : "文件";
			part.invocationMessage = trustedMarkdown(`读取 ${link}`);
			part.pastTenseMessage = trustedMarkdown(`已读取 ${link}`);
			break;
		}
		case "edit":
		case "write": {
			const link = path ? fileLink(input.cwd, path) : "文件";
			const verb = input.toolName === "edit" ? "修改" : "写入";
			part.invocationMessage = trustedMarkdown(`${verb} ${link}`);
			part.pastTenseMessage = trustedMarkdown(
				outcome.isError ? `${verb}失败：${link}` : `已${verb} ${link} · ${diffLink(input.sessionId, input.toolCallId)}`,
			);
			if (outcome.isError && outcome.outputText !== undefined) {
				part.toolSpecificData = { input: JSON.stringify(input.args, null, 2), output: outcome.outputText };
			}
			break;
		}
		default: {
			part.invocationMessage = `调用 ${input.toolName}`;
			part.pastTenseMessage = `已调用 ${input.toolName}`;
			part.toolSpecificData = { input: JSON.stringify(input.args, null, 2), output: outcome.outputText ?? "" };
			break;
		}
	}
	return part;
}
