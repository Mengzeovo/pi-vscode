import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import { EDIT_ENTRY_TYPE, type EditEntryData, REQUEST_ENTRY_TYPE, type ReferenceRecord, type RequestEntryData } from "../../shared/protocol";
import { SESSION_TYPE } from "../sessions/sessionUri";
import { createToolPart, toolResultText } from "./toolParts";

type HistoryTurn = vscode.ChatRequestTurn | vscode.ChatResponseTurn2;
type ResponsePart = vscode.ChatResponseTurn2["response"][number];

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: Record<string, unknown>;
}

export interface SessionRecords {
	/** 用户消息条目 ID → 请求记录 */
	readonly requests: ReadonlyMap<string, RequestEntryData>;
	/** 按会话中的顺序排列的修改记录，附带其所在位置之前最近一条用户消息的条目 ID */
	readonly edits: ReadonlyArray<{ readonly userEntryId: string | undefined; readonly data: EditEntryData }>;
}

function blocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function userMessageText(content: unknown): string {
	return blocks(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** 从当前分支中读取 Pi 扩展写入的请求记录和修改记录 */
export function readSessionRecords(branch: readonly SessionEntry[]): SessionRecords {
	const requests = new Map<string, RequestEntryData>();
	const edits: Array<{ userEntryId: string | undefined; data: EditEntryData }> = [];
	let currentUserEntryId: string | undefined;
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			currentUserEntryId = entry.id;
		} else if (entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE) {
			const data = entry.data as RequestEntryData;
			requests.set(data.userEntryId, data);
		} else if (entry.type === "custom" && entry.customType === EDIT_ENTRY_TYPE) {
			edits.push({ userEntryId: currentUserEntryId, data: entry.data as EditEntryData });
		}
	}
	return { requests, edits };
}

export function toPromptReference(record: ReferenceRecord): vscode.ChatPromptReference {
	const uri = record.uri !== undefined ? vscode.Uri.parse(record.uri) : undefined;
	const value =
		uri !== undefined && record.range !== undefined
			? new vscode.Location(uri, new vscode.Range(record.range.startLine, record.range.startCharacter, record.range.endLine, record.range.endCharacter))
			: (uri ?? record.name);
	return { id: record.id, name: record.name, value, modelDescription: undefined, range: undefined };
}

class ResponseBuilder {
	readonly parts: ResponsePart[] = [];
	private readonly toolArgs = new Map<string, { name: string; args: Record<string, unknown> }>();
	private error: string | undefined;

	constructor(
		private readonly sessionId: string,
		private readonly cwd: string,
	) {}

	addAssistant(message: { content: unknown; stopReason?: string; errorMessage?: string }): void {
		for (const block of blocks(message.content)) {
			if (block.type === "text" && block.text) {
				this.parts.push(new vscode.ChatResponseMarkdownPart(block.text));
			} else if (block.type === "thinking" && block.thinking) {
				this.parts.push(new vscode.ChatResponseThinkingProgressPart(block.thinking));
			} else if (block.type === "toolCall" && block.id && block.name) {
				this.toolArgs.set(block.id, { name: block.name, args: block.arguments ?? {} });
			}
		}
		this.error = message.stopReason === "error" ? (message.errorMessage ?? "Pi 返回了错误") : undefined;
	}

	addToolResult(message: { toolCallId: string; toolName: string; content: unknown; isError: boolean }): void {
		const call = this.toolArgs.get(message.toolCallId) ?? { name: message.toolName, args: {} };
		this.parts.push(
			createToolPart(
				{ sessionId: this.sessionId, cwd: this.cwd, toolCallId: message.toolCallId, toolName: call.name, args: call.args },
				{ complete: true, isError: message.isError, outputText: toolResultText({ content: message.content }) },
			),
		);
	}

	addNote(text: string): void {
		this.parts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(`_${text}_`)));
	}

	build(): vscode.ChatResponseTurn2 {
		const result: vscode.ChatResult = this.error ? { errorDetails: { message: this.error } } : {};
		return new vscode.ChatResponseTurn2(this.parts, result, SESSION_TYPE);
	}
}

export interface RenderedHistory {
	readonly turns: HistoryTurn[];
	/** inFlight 为 true 时，最后一条请求已经完成的响应部分；由 activeResponseCallback 先行写入 */
	readonly tailParts: ResponsePart[];
}

/**
 * 把 Pi 会话当前分支转换为 VS Code 的历史轮次。
 * inFlight 为 true 时 Pi 仍在运行：历史以最后一条请求结束，其已完成的响应部分另行返回。
 */
export function renderHistory(sessionId: string, cwd: string, branch: readonly SessionEntry[], inFlight = false): RenderedHistory {
	const records = readSessionRecords(branch);
	const turns: HistoryTurn[] = [];
	let response: ResponseBuilder | undefined;
	const flush = (): void => {
		if (response) {
			turns.push(response.build());
			response = undefined;
		}
	};
	const ensureResponse = (): ResponseBuilder => {
		response ??= new ResponseBuilder(sessionId, cwd);
		return response;
	};
	for (const entry of branch) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				flush();
				const record = records.requests.get(entry.id);
				const prompt = record ? record.userText : userMessageText(message.content);
				const references = record ? record.references.map(toPromptReference) : [];
				turns.push(new vscode.ChatRequestTurn2(prompt, undefined, references, SESSION_TYPE, [], undefined, entry.id, undefined, undefined));
			} else if (message.role === "assistant") {
				ensureResponse().addAssistant(message);
			} else if (message.role === "toolResult") {
				ensureResponse().addToolResult(message);
			} else if (message.role === "bashExecution") {
				ensureResponse().addNote(`用户在终端执行了 \`${message.command}\``);
			}
		} else if (entry.type === "compaction") {
			ensureResponse().addNote(`已压缩上下文：${entry.tokensBefore} 个 token 之前的内容改为摘要`);
		} else if (entry.type === "branch_summary") {
			ensureResponse().addNote("已切换分支，之前分支的内容改为摘要");
		}
	}
	if (inFlight) {
		const tail: ResponseBuilder | undefined = response;
		return { turns, tailParts: tail ? tail.parts : [] };
	}
	flush();
	return { turns, tailParts: [] };
}
