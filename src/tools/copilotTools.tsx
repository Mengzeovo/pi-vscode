import { type BasePromptElementProps, type ITokenizer, OutputMode, PromptElement, Raw, renderPrompt, ToolResult, UserMessage } from "@vscode/prompt-tsx";
import { countTokens } from "gpt-tokenizer";
import * as vscode from "vscode";
import { COPILOT_TOOL_NAMES, type CopilotToolDeclaration, type ToolTextResult } from "../../shared/protocol";

const TOKEN_BUDGET = 12_000;

const SUPPORTED = new Set<string>(COPILOT_TOOL_NAMES);

/** VS Code 实际提供的受支持 Copilot 工具及其参数定义 */
export function availableCopilotTools(): CopilotToolDeclaration[] {
	return vscode.lm.tools
		.filter((tool) => SUPPORTED.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: "object", properties: {} } }));
}

/**
 * 本轮启用的 Copilot 工具：VS Code 实际提供，并且在 request.tools 中不为 false；
 * 用户用 # 引用的工具总是启用。
 */
export function enabledCopilotTools(request: vscode.ChatRequest): string[] {
	const available = new Set(availableCopilotTools().map((tool) => tool.name));
	const referenced = new Set(request.toolReferences.map((reference) => reference.name));
	const disabled = new Set<string>();
	for (const [info, enabled] of request.tools) {
		if (!enabled) {
			disabled.add(info.name);
		}
	}
	return [...available].filter((name) => referenced.has(name) || !disabled.has(name));
}

function countText(text: string): number {
	return countTokens(text);
}

function countMessage(message: vscode.LanguageModelChatMessage): number {
	let total = 0;
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += countText(part.value);
		}
	}
	return total;
}

const tokenizer: ITokenizer<OutputMode.VSCode> = {
	mode: OutputMode.VSCode,
	tokenLength: (part: Raw.ChatCompletionContentPart) => (part.type === Raw.ChatCompletionContentPartKind.Text ? countText(part.text) : 0),
	countMessageTokens: (message: vscode.LanguageModelChatMessage) => countMessage(message),
};

interface ToolResultPromptProps extends BasePromptElementProps {
	readonly result: vscode.LanguageModelToolResult;
}

class ToolResultPrompt extends PromptElement<ToolResultPromptProps> {
	render() {
		return (
			<UserMessage>
				<ToolResult data={this.props.result} />
			</UserMessage>
		);
	}
}

async function renderResultText(result: vscode.LanguageModelToolResult, token: vscode.CancellationToken): Promise<string> {
	const hasPromptTsx = result.content.some((part) => part instanceof vscode.LanguageModelPromptTsxPart);
	if (!hasPromptTsx) {
		return result.content
			.map((part) => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return part.value;
				}
				if (part instanceof vscode.LanguageModelDataPart) {
					return part.mimeType.startsWith("text/") || part.mimeType === "application/json" ? Buffer.from(part.data).toString("utf8") : `[${part.mimeType} 数据]`;
				}
				return "";
			})
			.join("\n");
	}
	const rendered = await renderPrompt(ToolResultPrompt, { result }, { modelMaxPromptTokens: TOKEN_BUDGET }, tokenizer, undefined, token, OutputMode.VSCode);
	return rendered.messages
		.flatMap((message) => message.content)
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map((part) => part.value)
		.join("\n");
}

export async function invokeCopilotTool(
	name: string,
	input: unknown,
	toolInvocationToken: vscode.ChatParticipantToolToken,
	token: vscode.CancellationToken,
): Promise<ToolTextResult> {
	if (!SUPPORTED.has(name)) {
		throw new Error(`不支持的 Copilot 工具：${name}`);
	}
	const result = await vscode.lm.invokeTool(
		name,
		{
			input: input as object,
			toolInvocationToken,
			tokenizationOptions: { tokenBudget: TOKEN_BUDGET, countTokens: async (text) => countText(text) },
		},
		token,
	);
	const text = await renderResultText(result, token);
	if (text.trim().length === 0) {
		return { text: `${name} 没有返回可用的结果。`, isError: false };
	}
	return { text, isError: false };
}
