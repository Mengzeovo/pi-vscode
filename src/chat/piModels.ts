import { countTokens } from "gpt-tokenizer";
import * as vscode from "vscode";
import { modelKey, type PiModel } from "../pi/catalog";
import { folderKey, type ModelChoices, type PiHub } from "../session/hub";
import type { ModelSelection } from "../session/piSession";
import { SESSION_TYPE } from "../sessions/sessionUri";

/** 语言模型提供方的 vendor；package.json 的 languageModelChatProviders 使用同一个值 */
export const PI_MODEL_VENDOR = "pi-harness";
/** 模型配置中表示思考级别的属性；group 为 navigation 时 VS Code 在模型选择器中显示为思考强度选项 */
export const THINKING_LEVEL_KEY = "thinkingLevel";
/** 模型不可用的提示中重新读取模型列表的按钮，与命令 piHarness.refreshModels 的标题相同 */
const REFRESH_ACTION = "刷新 Pi 模型列表";
/** Pi 的思考级别从低到高的顺序，与 pi-ai 的 getSupportedThinkingLevels 一致 */
const LEVEL_ORDER: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 与 Pi 的 clampThinkingLevel 相同：取不低于 desired 的第一个可用级别，没有时取低于它的最高可用级别 */
function clampLevel(levels: readonly string[], desired: string): string {
	if (levels.includes(desired)) {
		return desired;
	}
	const index = LEVEL_ORDER.indexOf(desired);
	for (let candidate = index; candidate < LEVEL_ORDER.length; candidate++) {
		if (levels.includes(LEVEL_ORDER[candidate])) {
			return LEVEL_ORDER[candidate];
		}
	}
	for (let candidate = index - 1; candidate >= 0; candidate--) {
		if (levels.includes(LEVEL_ORDER[candidate])) {
			return LEVEL_ORDER[candidate];
		}
	}
	return levels[0];
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join("");
}

/**
 * 把 Pi 的可用模型提供给 VS Code 的模型选择器，只在 Pi 会话中显示（`targetChatSessionType`）。
 * 用户在选择器中选择的模型和思考级别随每个请求到达 participant（`request.model`、`request.modelConfiguration`），
 * 由扩展在 Pi 进程中切换；这些模型不直接处理 VS Code 的语言模型请求。
 */
export class PiModelProvider implements vscode.LanguageModelChatProvider {
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
	private lastProblem: string | undefined;

	constructor(private readonly hub: PiHub) {
		this.onDidChangeLanguageModelChatInformation = hub.onDidChangeChoices;
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		let choices: ModelChoices;
		try {
			choices = await this.hub.modelChoices();
		} catch (error) {
			// 没有模型时 VS Code 禁止在 Pi 会话中发送；原因写入输出通道，并对同一原因只提示一次
			const reason = error instanceof Error ? error.message : String(error);
			this.hub.log(`读取 Pi 模型列表失败：${reason}`);
			if (reason !== this.lastProblem) {
				this.lastProblem = reason;
				void this.offerRefresh(reason);
			}
			return [];
		}
		this.lastProblem = undefined;
		const folders = this.hub.folders();
		// 新会话默认使用第一个工作区文件夹中 Pi 的默认模型和思考级别
		const defaults = choices.defaults.get(folderKey(folders[0]));
		return choices.models.map((model) => this.information(model, choices, defaults?.model, defaults?.thinking ?? "off"));
	}

	/** 提示模型不可用的原因；用户点击“刷新 Pi 模型列表”后重新读取，并通知 VS Code 更新模型选择器 */
	private async offerRefresh(reason: string): Promise<void> {
		const action = await vscode.window.showWarningMessage(`Pi 模型不可用：${reason}`, REFRESH_ACTION);
		if (action === REFRESH_ACTION) {
			await vscode.commands.executeCommand("piHarness.refreshModels");
		}
	}

	private information(model: PiModel, choices: ModelChoices, defaultModel: string | undefined, defaultThinking: string): vscode.LanguageModelChatInformation {
		const key = modelKey(model);
		const levels = choices.levels.get(key) ?? ["off"];
		const name = model.name.length > 0 ? model.name : model.id;
		return {
			id: key,
			name,
			family: model.id,
			version: model.provider,
			detail: model.provider,
			tooltip: `${name}（${key}）`,
			maxInputTokens: model.contextWindow,
			maxOutputTokens: model.maxTokens,
			capabilities: { imageInput: model.input.includes("image"), toolCalling: true },
			targetChatSessionType: SESSION_TYPE,
			isUserSelectable: true,
			isDefault: key === defaultModel ? true : undefined,
			configurationSchema:
				levels.length > 1
					? {
							properties: {
								[THINKING_LEVEL_KEY]: {
									type: "string",
									title: "思考级别",
									enum: [...levels],
									enumItemLabels: [...levels],
									default: clampLevel(levels, defaultThinking),
									group: "navigation",
								},
							},
						}
					: undefined,
		};
	}

	provideLanguageModelChatResponse(): Thenable<void> {
		throw new Error("Pi 的模型只用于 Pi 会话：请在 Pi 会话中发送消息，由 Pi 进程调用模型。");
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		return countTokens(typeof text === "string" ? text : messageText(text));
	}
}

/** 从请求携带的模型和模型配置确定要在 Pi 中使用的模型和思考级别 */
export function selectionFromRequest(request: vscode.ChatRequest): ModelSelection {
	if (request.model.vendor !== PI_MODEL_VENDOR) {
		throw new Error(`当前选择的模型 ${request.model.name} 不是 Pi 的模型，请在模型选择器中选择 Pi 提供的模型。`);
	}
	const slash = request.model.id.indexOf("/");
	const thinking = request.modelConfiguration?.[THINKING_LEVEL_KEY];
	return {
		provider: request.model.id.slice(0, slash),
		modelId: request.model.id.slice(slash + 1),
		thinkingLevel: typeof thinking === "string" ? thinking : undefined,
	};
}
