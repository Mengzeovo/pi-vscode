import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import { COPILOT_TOOL_NAMES } from "../../shared/protocol";
import { createToolPart, toolResultText } from "./toolParts";

const COPILOT_TOOLS = new Set<string>(COPILOT_TOOL_NAMES);

export interface RenderContext {
	readonly sessionId: string;
	readonly cwd: string;
	/** 该工具调用是否已由 VS Code 执行并显示 */
	readonly shownByVsCode: (toolCallId: string) => boolean;
}

interface ToolCallState {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

interface AssistantMessageLike {
	readonly role: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

/** 把 Pi 的 RPC 事件写入一个 VS Code 响应流；引导消息到达后可以切换到新的响应流 */
export class StreamRenderer {
	private stream: vscode.ChatResponseStream;
	private readonly tools = new Map<string, ToolCallState>();
	private assistantIndex = 0;
	private lastError: string | undefined;

	constructor(
		stream: vscode.ChatResponseStream,
		private readonly context: RenderContext,
	) {
		this.stream = stream;
	}

	retarget(stream: vscode.ChatResponseStream): void {
		this.stream = stream;
	}

	/** 本次运行最后一条助手消息的错误；成功时为 undefined */
	get error(): string | undefined {
		return this.lastError;
	}

	handle(event: JsonAgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.assistantIndex++;
				}
				return;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") {
					this.stream.markdown(update.delta);
				} else if (update.type === "thinking_delta") {
					this.stream.thinkingProgress({ text: update.delta, id: `${this.context.sessionId}-${this.assistantIndex}-${update.contentIndex}` });
				}
				return;
			}
			case "message_end": {
				const message = event.message as AssistantMessageLike;
				if (message.role !== "assistant") {
					return;
				}
				if (message.usage) {
					this.stream.usage({
						promptTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
						completionTokens: message.usage.output,
					});
				}
				this.lastError = message.stopReason === "error" ? (message.errorMessage ?? "Pi 返回了错误") : undefined;
				return;
			}
			case "tool_execution_start": {
				const args = (event.args ?? {}) as Record<string, unknown>;
				this.tools.set(event.toolCallId, { toolName: event.toolName, args });
				if (!COPILOT_TOOLS.has(event.toolName)) {
					this.stream.push(this.part(event.toolCallId, { complete: false, isError: false, outputText: undefined }));
				}
				return;
			}
			case "tool_execution_update": {
				if (!COPILOT_TOOLS.has(event.toolName) && (event.toolName === "bash" || event.toolName === "powershell")) {
					this.stream.push(this.part(event.toolCallId, { complete: false, isError: false, outputText: toolResultText(event.partialResult) }));
				}
				return;
			}
			case "tool_execution_end": {
				if (COPILOT_TOOLS.has(event.toolName) && this.context.shownByVsCode(event.toolCallId)) {
					return;
				}
				if (!this.tools.has(event.toolCallId)) {
					this.tools.set(event.toolCallId, { toolName: event.toolName, args: {} });
				}
				this.stream.push(this.part(event.toolCallId, { complete: true, isError: event.isError, outputText: toolResultText(event.result) }));
				return;
			}
			case "compaction_start":
				this.stream.progress("Pi 正在压缩上下文");
				return;
			case "compaction_end":
				if (event.result) {
					this.stream.markdown(`\n\n_已压缩上下文：${event.result.tokensBefore} 个 token 之前的内容改为摘要。_\n\n`);
				} else if (!event.aborted) {
					this.stream.warning(`压缩上下文失败${"errorMessage" in event && typeof event.errorMessage === "string" ? `：${event.errorMessage}` : ""}`);
				}
				return;
			case "auto_retry_start":
				this.stream.progress(`Pi 正在第 ${event.attempt} 次重试（共 ${event.maxAttempts} 次）：${event.errorMessage}`);
				return;
			default:
				return;
		}
	}

	private part(toolCallId: string, outcome: { complete: boolean; isError: boolean; outputText: string | undefined }): vscode.ChatToolInvocationPart {
		const state = this.tools.get(toolCallId);
		if (!state) {
			throw new Error(`没有工具调用 ${toolCallId} 的开始事件`);
		}
		return createToolPart(
			{ sessionId: this.context.sessionId, cwd: this.context.cwd, toolCallId, toolName: state.toolName, args: state.args },
			outcome,
		);
	}
}
