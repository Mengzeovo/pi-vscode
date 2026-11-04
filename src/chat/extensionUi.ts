import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";

type DialogRequest = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export interface ExtensionUiHost {
	/** 正在处理的 participant 请求的响应流和取消信号；没有时为 undefined */
	readonly participantStream: () => { readonly stream: vscode.ChatResponseStream; readonly token: vscode.CancellationToken } | undefined;
	readonly respond: (response: RpcExtensionUIResponse) => Promise<void>;
	readonly setTitle: (title: string) => void;
	readonly sessionLabel: () => string;
}

const YES = "是";
const NO = "否";

function titledMessage(title: string, message: string): vscode.MarkdownString {
	return new vscode.MarkdownString().appendText(title).appendMarkdown("\n\n").appendText(message);
}

function cancelled(id: string): RpcExtensionUIResponse {
	return { type: "extension_ui_response", id, cancelled: true };
}

/** 关闭 editor 对话框使用的无标题文档，不询问是否保存；用户已经关闭时不处理 */
async function closeWithoutSaving(document: vscode.TextDocument): Promise<void> {
	if (document.isClosed) {
		return;
	}
	await vscode.window.showTextDocument(document);
	await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
}

/** 把 Pi 扩展的界面请求转换为 VS Code 的聊天内提问、QuickPick、InputBox、通知和状态栏 */
export class ExtensionUiBridge implements vscode.Disposable {
	private readonly statusItem: vscode.StatusBarItem;
	private readonly statuses = new Map<string, string>();
	private readonly widgets = new Map<string, readonly string[]>();
	private readonly pending = new Map<string, vscode.CancellationTokenSource>();

	constructor(private readonly host: ExtensionUiHost) {
		this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	}

	handle(request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				void this.handleDialog(request);
				return;
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`Pi：${request.message}`);
				return;
			}
			case "setStatus":
				if (request.statusText === undefined) {
					this.statuses.delete(request.statusKey);
				} else {
					this.statuses.set(request.statusKey, request.statusText);
				}
				this.renderStatus();
				return;
			case "setWidget":
				if (request.widgetLines === undefined) {
					this.widgets.delete(request.widgetKey);
				} else {
					this.widgets.set(request.widgetKey, request.widgetLines);
				}
				this.renderStatus();
				return;
			case "setTitle":
				this.host.setTitle(request.title);
				return;
			case "set_editor_text":
				void this.offerEditorText(request.text);
				return;
		}
	}

	/** 请求被取消时，尚未回答的对话框回复 cancelled */
	cancelPending(): void {
		for (const [id, source] of this.pending) {
			source.cancel();
			void this.host.respond(cancelled(id));
		}
		this.pending.clear();
	}

	dispose(): void {
		this.cancelPending();
		this.statusItem.dispose();
	}

	private renderStatus(): void {
		const texts = [...this.statuses.values()];
		if (texts.length === 0 && this.widgets.size === 0) {
			this.statusItem.hide();
			return;
		}
		this.statusItem.text = `$(hubot) ${texts.join(" · ") || this.host.sessionLabel()}`;
		const tooltip = new vscode.MarkdownString();
		for (const [key, lines] of this.widgets) {
			tooltip.appendMarkdown(`**${key}**\n\n`);
			tooltip.appendCodeblock(lines.join("\n"), "text");
		}
		this.statusItem.tooltip = tooltip;
		this.statusItem.show();
	}

	private async offerEditorText(text: string): Promise<void> {
		const action = await vscode.window.showInformationMessage(`Pi 请求把文字填入输入框：${text.slice(0, 120)}`, "填入输入框");
		if (action === "填入输入框") {
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: text, isPartialQuery: true });
		}
	}

	private async handleDialog(request: DialogRequest): Promise<void> {
		const source = new vscode.CancellationTokenSource();
		this.pending.set(request.id, source);
		const timeout = "timeout" in request && request.timeout !== undefined ? setTimeout(() => source.cancel(), request.timeout) : undefined;
		try {
			const participant = this.host.participantStream();
			const timed = "timeout" in request && request.timeout !== undefined;
			// editor 需要多行编辑，聊天内的文本题只有单行输入框，始终在编辑器中处理
			const response =
				participant !== undefined && !timed && request.method !== "editor"
					? await this.askInChat(request, participant.stream)
					: await this.askWithQuickInput(request, source.token);
			if (this.pending.delete(request.id)) {
				await this.host.respond(response);
			}
		} finally {
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			source.dispose();
		}
	}

	private async askInChat(request: Exclude<DialogRequest, { method: "editor" }>, stream: vscode.ChatResponseStream): Promise<RpcExtensionUIResponse> {
		const id = "answer";
		let question: vscode.ChatQuestion;
		switch (request.method) {
			case "select":
				question = new vscode.ChatQuestion(id, vscode.ChatQuestionType.SingleSelect, request.title, {
					options: request.options.map((option, index) => ({ id: String(index), label: option, value: option })),
					allowFreeformInput: false,
				});
				break;
			case "confirm":
				// 聊天内提问在有 message 时只显示 message，标题和说明一起放入 message
				question = new vscode.ChatQuestion(id, vscode.ChatQuestionType.SingleSelect, request.title, {
					message: titledMessage(request.title, request.message),
					options: [
						{ id: "yes", label: YES, value: YES },
						{ id: "no", label: NO, value: NO },
					],
					allowFreeformInput: false,
				});
				break;
			case "input":
				question = new vscode.ChatQuestion(id, vscode.ChatQuestionType.Text, request.title, {
					message: request.placeholder !== undefined ? titledMessage(request.title, request.placeholder) : undefined,
				});
				break;
		}
		const answers = await stream.questionCarousel([question], true);
		const answer = answers?.[id];
		if (answer === undefined || answer === null) {
			return cancelled(request.id);
		}
		if (request.method === "confirm") {
			const selected = (answer as { selectedValue?: unknown }).selectedValue;
			return { type: "extension_ui_response", id: request.id, confirmed: selected === YES };
		}
		if (typeof answer === "string") {
			return { type: "extension_ui_response", id: request.id, value: answer };
		}
		const single = answer as { selectedValue?: unknown; freeformValue?: unknown };
		const value = typeof single.freeformValue === "string" && single.freeformValue.length > 0 ? single.freeformValue : single.selectedValue;
		return typeof value === "string" ? { type: "extension_ui_response", id: request.id, value } : cancelled(request.id);
	}

	private async askWithQuickInput(request: DialogRequest, token: vscode.CancellationToken): Promise<RpcExtensionUIResponse> {
		switch (request.method) {
			case "select": {
				const value = await vscode.window.showQuickPick(request.options, { title: `Pi：${request.title}`, ignoreFocusOut: true }, token);
				return value === undefined ? cancelled(request.id) : { type: "extension_ui_response", id: request.id, value };
			}
			case "confirm": {
				const value = await vscode.window.showQuickPick([YES, NO], { title: `Pi：${request.title}`, placeHolder: request.message, ignoreFocusOut: true }, token);
				return value === undefined ? cancelled(request.id) : { type: "extension_ui_response", id: request.id, confirmed: value === YES };
			}
			case "input": {
				const value = await vscode.window.showInputBox({ title: `Pi：${request.title}`, placeHolder: request.placeholder, ignoreFocusOut: true }, token);
				return value === undefined ? cancelled(request.id) : { type: "extension_ui_response", id: request.id, value };
			}
			case "editor": {
				const document = await vscode.workspace.openTextDocument({ content: request.prefill ?? "" });
				await vscode.window.showTextDocument(document);
				const action = await vscode.window.showInformationMessage(`Pi：${request.title}。在打开的编辑器中修改后点击“完成”。`, "完成", "取消");
				const text = document.getText();
				await closeWithoutSaving(document);
				return action === "完成" ? { type: "extension_ui_response", id: request.id, value: text } : cancelled(request.id);
			}
		}
	}
}
