import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type { AgentToolResult, CustomEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CancellationTokenSource, createMessageConnection, type MessageConnection, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node";
import {
	CopilotInvoke,
	type CopilotToolDeclaration,
	EDIT_ENTRY_TYPE,
	type EditEntryData,
	EditorDefinition,
	EditorDiagnostics,
	EditorReferences,
	ENV_IPC_PATH,
	ENV_IPC_TOKEN,
	FileCommit,
	FileReadBase,
	Hello,
	type LocationResult,
	RecordRequest,
	REQUEST_ENTRY_TYPE,
	REWIND_COMMAND,
	type RequestEntryData,
	SetTurnTools,
} from "../shared/protocol";

function textResult(text: string, isError = false): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

function formatLocations(locations: readonly LocationResult[]): string {
	if (locations.length === 0) {
		return "没有找到结果";
	}
	return locations.map((location) => `${location.path}:${location.startLine + 1}:${location.startCharacter + 1}  ${location.preview}`).join("\n");
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** 在取消信号触发时取消 IPC 请求 */
function tokenFor(signal: AbortSignal | undefined): CancellationTokenSource {
	const source = new CancellationTokenSource();
	if (signal?.aborted) {
		source.cancel();
	}
	signal?.addEventListener("abort", () => source.cancel(), { once: true });
	return source;
}

export default function piHarness(pi: ExtensionAPI): void {
	const ipcPath = process.env[ENV_IPC_PATH];
	const ipcToken = process.env[ENV_IPC_TOKEN];
	// bash 启动的命令继承环境变量，读取后立即删除，避免命令连接到编辑器通道
	delete process.env[ENV_IPC_PATH];
	delete process.env[ENV_IPC_TOKEN];
	if (ipcPath === undefined || ipcToken === undefined) {
		throw new Error("pi-harness 扩展只能由 VS Code 的 Pi Harness 扩展启动");
	}

	let connection: MessageConnection | undefined;
	let socket: Socket | undefined;
	let sessionManager: ExtensionContext["sessionManager"] | undefined;
	const toolCallIds = new AsyncLocalStorage<string>();
	const copilotTools = new Set<string>();
	let stagedCopilotTools: readonly string[] | undefined;
	const pendingDrafts: CustomEntryDraft[] = [];

	const requireConnection = (): MessageConnection => {
		if (!connection) {
			throw new Error("与 VS Code 的连接不可用");
		}
		return connection;
	};

	const currentToolCallId = (): string => {
		const id = toolCallIds.getStore();
		if (id === undefined) {
			throw new Error("文件操作不在工具调用中执行");
		}
		return id;
	};

	const registerCopilotTool = (declaration: CopilotToolDeclaration): void => {
		copilotTools.add(declaration.name);
		pi.registerTool({
			name: declaration.name,
			label: declaration.name,
			description: declaration.description,
			parameters: Type.Unsafe<Record<string, unknown>>(declaration.inputSchema),
			defaultActive: false,
			async execute(toolCallId, params, signal) {
				const cancellation = tokenFor(signal);
				const result = await requireConnection().sendRequest(CopilotInvoke, { name: declaration.name, input: params, toolCallId }, cancellation.token);
				return textResult(result.text, result.isError);
			},
		});
	};

	const connectToVsCode = async (ctx: ExtensionContext): Promise<void> => {
		const pipe = connect(ipcPath);
		await new Promise<void>((resolve, reject) => {
			pipe.once("connect", resolve);
			pipe.once("error", reject);
		});
		socket = pipe;
		const conn = createMessageConnection(new SocketMessageReader(pipe), new SocketMessageWriter(pipe));
		conn.onRequest(SetTurnTools, (params) => {
			stagedCopilotTools = params.enabledCopilotTools;
		});
		conn.onRequest(RecordRequest, (params) => {
			const manager = sessionManager;
			if (!manager) {
				throw new Error("会话尚未启动");
			}
			const branch = manager.getBranch();
			let userEntryId: string | undefined;
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "user" && messageText(entry.message.content) === params.messageText) {
					userEntryId = entry.id;
					break;
				}
			}
			if (userEntryId === undefined) {
				throw new Error(`当前分支中没有找到请求 ${params.requestId} 对应的用户消息`);
			}
			const data: RequestEntryData = { requestId: params.requestId, userEntryId, userText: params.userText, references: params.references };
			pendingDrafts.push({ type: "custom", customType: REQUEST_ENTRY_TYPE, data });
			return { userEntryId };
		});
		conn.listen();
		connection = conn;
		pipe.on("close", () => {
			connection = undefined;
			// VS Code 一侧已经断开：中止当前运行并退出，避免在没有编辑器的情况下继续修改文件
			ctx.abort();
			ctx.shutdown();
		});
		const hello = await conn.sendRequest(Hello, {
			token: ipcToken,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
		for (const declaration of hello.copilotTools) {
			registerCopilotTool(declaration);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionManager = ctx.sessionManager;
		if (!connection) {
			await connectToVsCode(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		connection?.dispose();
		connection = undefined;
		socket?.destroy();
		socket = undefined;
	});

	// VS Code 中编辑请求时移除了之后的请求：把当前分支退回到第一条被移除的用户消息之前，原分支保留在会话文件中
	pi.registerCommand(REWIND_COMMAND, {
		description: "VS Code 内部使用：把当前分支退回到指定用户消息之前",
		handler: async (args, ctx) => {
			const entryId = args.trim();
			const entry = ctx.sessionManager.getEntry(entryId);
			if (entry?.type !== "message" || entry.message.role !== "user") {
				throw new Error(`${entryId} 不是用户消息条目`);
			}
			const result = await ctx.navigateTree(entryId, { summarize: false });
			if (result.cancelled) {
				throw new Error(`退回到 ${entryId} 之前被取消`);
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "user") {
			return;
		}
		const enabled = stagedCopilotTools ?? [];
		stagedCopilotTools = undefined;
		const selected = event.systemPromptOptions.selectedTools;
		const next = [...selected.filter((name) => !copilotTools.has(name)), ...enabled.filter((name) => copilotTools.has(name))];
		selected.splice(0, selected.length, ...next);
	});

	pi.on("turn_end", (event) => {
		if (pendingDrafts.length === 0) {
			return;
		}
		return { entries: [...event.entries, ...pendingDrafts.splice(0)] };
	});

	pi.on("agent_settled", () => {
		// 运行结束后才到达的记录直接追加，运行之外追加条目不会落在工具调用和结果之间
		for (const draft of pendingDrafts.splice(0)) {
			pi.appendEntry(draft.customType, draft.data);
		}
	});

	const recordEdit = (data: EditEntryData): void => {
		pendingDrafts.push({ type: "custom", customType: EDIT_ENTRY_TYPE, data });
	};

	const cwd = process.cwd();
	const editDefinition = createEditToolDefinition(cwd, {
		operations: {
			access: (path) => access(path, constants.R_OK | constants.W_OK),
			readFile: async (path) => {
				const result = await requireConnection().sendRequest(FileReadBase, { path, toolCallId: currentToolCallId() });
				return Buffer.from(result.contentBase64, "base64");
			},
			writeFile: async (path, content) => {
				const toolCallId = currentToolCallId();
				const result = await requireConnection().sendRequest(FileCommit, {
					path,
					contentBase64: Buffer.from(content, "utf8").toString("base64"),
					toolCallId,
					tool: "edit",
				});
				recordEdit({ toolCallId, tool: "edit", path, beforeHash: result.beforeHash, afterHash: result.afterHash });
			},
		},
	});
	pi.registerTool({
		...editDefinition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => toolCallIds.run(toolCallId, () => editDefinition.execute(toolCallId, params, signal, onUpdate, ctx)),
	});

	const writeDefinition = createWriteToolDefinition(cwd, {
		operations: {
			mkdir: async (dir) => {
				await mkdir(dir, { recursive: true });
			},
			writeFile: async (path, content) => {
				const toolCallId = currentToolCallId();
				const result = await requireConnection().sendRequest(FileCommit, {
					path,
					contentBase64: Buffer.from(content, "utf8").toString("base64"),
					toolCallId,
					tool: "write",
				});
				recordEdit({ toolCallId, tool: "write", path, beforeHash: result.beforeHash, afterHash: result.afterHash });
			},
		},
	});
	pi.registerTool({
		...writeDefinition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => toolCallIds.run(toolCallId, () => writeDefinition.execute(toolCallId, params, signal, onUpdate, ctx)),
	});

	const positionSchema = Type.Object({
		path: Type.String({ description: "文件的绝对路径或相对于工作目录的路径" }),
		line: Type.Integer({ minimum: 1, description: "行号，从 1 开始" }),
		character: Type.Integer({ minimum: 1, description: "列号，从 1 开始" }),
	});

	pi.registerTool({
		name: "vscode_definition",
		label: "VS Code 定义",
		description: "使用 VS Code 的语言服务查找某个位置上符号的定义",
		promptSnippet: "Find symbol definitions through the VS Code language service",
		parameters: positionSchema,
		async execute(_toolCallId, params, signal) {
			const cancellation = tokenFor(signal);
			const locations = await requireConnection().sendRequest(EditorDefinition, { path: params.path, line: params.line - 1, character: params.character - 1 }, cancellation.token);
			return textResult(formatLocations(locations));
		},
	});

	pi.registerTool({
		name: "vscode_references",
		label: "VS Code 引用",
		description: "使用 VS Code 的语言服务查找某个位置上符号的全部引用",
		promptSnippet: "Find symbol references through the VS Code language service",
		parameters: positionSchema,
		async execute(_toolCallId, params, signal) {
			const cancellation = tokenFor(signal);
			const locations = await requireConnection().sendRequest(EditorReferences, { path: params.path, line: params.line - 1, character: params.character - 1 }, cancellation.token);
			return textResult(formatLocations(locations));
		},
	});

	pi.registerTool({
		name: "vscode_diagnostics",
		label: "VS Code 诊断",
		description: "读取 VS Code 当前的诊断（错误、警告）。不传 path 时返回整个工作区的诊断",
		promptSnippet: "Read current VS Code diagnostics",
		parameters: Type.Object({ path: Type.Optional(Type.String({ description: "文件路径；省略时返回全部诊断" })) }),
		async execute(_toolCallId, params, signal) {
			const cancellation = tokenFor(signal);
			const diagnostics = await requireConnection().sendRequest(EditorDiagnostics, { path: params.path }, cancellation.token);
			if (diagnostics.length === 0) {
				return textResult("没有诊断");
			}
			return textResult(
				diagnostics.map((item) => `${item.path}:${item.line + 1}:${item.character + 1} [${item.severity}${item.source ? ` ${item.source}` : ""}] ${item.message}`).join("\n"),
			);
		},
	});
}
