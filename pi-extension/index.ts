import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type { AgentToolResult, CustomEntryDraft, ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CancellationTokenSource, createMessageConnection, type MessageConnection, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node";
import {
	CopilotInvoke,
	type CopilotToolDeclaration,
	type CommitIdentity,
	type CommitResult,
	type DiagnosticResult,
	EDIT_ENTRY_TYPE,
	type EditEntryData,
	EditorDefinition,
	EditorDiagnostics,
	EditorReferences,
	FileCommit,
	FileReadBase,
	Hello,
	type HelloResult,
	type LocationResult,
	type ReadBaseResult,
	RecordRequest,
	type RecordRequestParams,
	REQUEST_ENTRY_TYPE,
	type RequestEntryData,
	SetTurnTools,
	type SetTurnToolsParams,
	type ToolTextResult,
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

export interface HarnessExtensionConfig {
	readonly cwd: string;
	readonly role?: "root" | "child";
	readonly identity: () => CommitIdentity;
	readonly connection?: MessageConnection;
	readonly copilotTools?: readonly CopilotToolDeclaration[];
	readonly ipcPath?: string;
	readonly ipcToken?: string;
	readonly onEdit?: (data: EditEntryData, identity: CommitIdentity) => void | Promise<void>;
	readonly onDisconnect?: () => void | Promise<void>;
}

export function createHarnessExtension(config: HarnessExtensionConfig): ExtensionFactory {
	if (!config.cwd || !config.connection && (!config.ipcPath || !config.ipcToken)) throw new Error("Harness 扩展缺少工作目录或编辑器连接");
	return (pi) => bindHarnessExtension(pi, config);
}

export default createHarnessExtension;

function bindHarnessExtension(pi: ExtensionAPI, config: HarnessExtensionConfig): void {

	let connection: MessageConnection | undefined;
	let socket: Socket | undefined;
	let sessionManager: ExtensionContext["sessionManager"] | undefined;
	const toolCalls = new AsyncLocalStorage<{ toolCallId: string; identity: CommitIdentity }>();
	const copilotTools = new Set<string>();
	let stagedCopilotTools: readonly string[] | undefined;
	const pendingDrafts: CustomEntryDraft[] = [];
	const connectionBindings: Array<{ dispose(): void }> = [];
	const assignedUsers = new Set<string>();
	const recordedRequests = new Map<string, string>();

	const requireConnection = (): MessageConnection => {
		if (!connection) {
			throw new Error("与 VS Code 的连接不可用");
		}
		return connection;
	};

	const currentToolCall = (): { toolCallId: string; identity: CommitIdentity } => {
		const call = toolCalls.getStore();
		if (call === undefined) {
			throw new Error("文件操作不在工具调用中执行");
		}
		return call;
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
				const result = await requireConnection().sendRequest<ToolTextResult>(CopilotInvoke.method, { name: declaration.name, input: params, toolCallId }, cancellation.token);
				return textResult(result.text, result.isError);
			},
		});
	};

	const connectToVsCode = async (ctx: ExtensionContext): Promise<void> => {
		let conn = config.connection;
		if (!conn) {
			const pipe = connect(config.ipcPath!);
			await new Promise<void>((resolve, reject) => { pipe.once("connect", resolve); pipe.once("error", reject); });
			socket = pipe;
			conn = createMessageConnection(new SocketMessageReader(pipe), new SocketMessageWriter(pipe));
		}
		if (config.role !== "child") {
		connectionBindings.push(conn.onRequest(SetTurnTools.method, (params: SetTurnToolsParams) => {
			stagedCopilotTools = params.enabledCopilotTools;
		}));
		connectionBindings.push(conn.onRequest(RecordRequest.method, (params: RecordRequestParams) => {
			const manager = sessionManager;
			if (!manager) {
				throw new Error("会话尚未启动");
			}
			const branch = manager.getBranch();
			const recorded = recordedRequests.get(params.requestId);
			if (recorded !== undefined) return { userEntryId: recorded };
			let userEntryId: string | undefined;
			for (let index = 0; index < branch.length; index++) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "user" && !assignedUsers.has(entry.id) && messageText(entry.message.content) === params.messageText) {
					userEntryId = entry.id;
					break;
				}
			}
			if (userEntryId === undefined) {
				throw new Error(`当前分支中没有找到请求 ${params.requestId} 对应的用户消息`);
			}
			const data: RequestEntryData = { requestId: params.requestId, userEntryId, userText: params.userText, references: params.references };
			assignedUsers.add(userEntryId);
			recordedRequests.set(params.requestId, userEntryId);
			pendingDrafts.push({ type: "custom", customType: REQUEST_ENTRY_TYPE, data });
			return { userEntryId };
		}));
		}
		if (!config.connection) conn.listen();
		connection = conn;
		connectionBindings.push(conn.onClose(() => {
			connection = undefined;
			ctx.abort();
			if (config.onDisconnect) void config.onDisconnect(); else ctx.shutdown();
		}));
		const declarations = config.connection ? config.copilotTools ?? [] : (await conn.sendRequest<HelloResult>(Hello.method, {
			token: config.ipcToken!, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
			parentSessionId: config.identity().sessionId, identity: config.identity(), role: "child",
		})).copilotTools;
		for (const declaration of declarations) {
			registerCopilotTool(declaration);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionManager = ctx.sessionManager;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "user") assignedUsers.add(entry.id);
			if (entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE) {
				const data = entry.data as RequestEntryData;
				recordedRequests.set(data.requestId, data.userEntryId);
			}
		}
		if (!connection) {
			await connectToVsCode(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		for (const binding of connectionBindings.splice(0)) binding.dispose();
		if (!config.connection) connection?.dispose();
		connection = undefined;
		socket?.destroy();
		socket = undefined;
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
		// 运行结束后到达的记录直接追加，保持工具调用与结果的顺序。
		for (const draft of pendingDrafts.splice(0)) {
			pi.appendEntry(draft.customType, draft.data);
		}
	});

	const recordEdit = async (data: EditEntryData): Promise<void> => {
		await config.onEdit?.(data, currentToolCall().identity);
		pendingDrafts.push({ type: "custom", customType: EDIT_ENTRY_TYPE, data });
	};

	const cwd = config.cwd;
	const editDefinition = createEditToolDefinition(cwd, {
		operations: {
			access: (path) => access(path, constants.R_OK | constants.W_OK),
			readFile: async (path) => {
				const result = await requireConnection().sendRequest<ReadBaseResult>(FileReadBase.method, { path, ...currentToolCall() });
				if (!result.exists) throw new Error(`文件不存在：${path}`);
				return Buffer.from(result.contentBase64, "base64");
			},
			writeFile: async (path, content) => {
				const { toolCallId, identity } = currentToolCall();
				const result = await requireConnection().sendRequest<CommitResult>(FileCommit.method, {
					path,
					contentBase64: Buffer.from(content, "utf8").toString("base64"),
					toolCallId,
					tool: "edit",
					identity,
				});
				await recordEdit({ toolCallId, tool: "edit", path, beforeHash: result.beforeHash, afterHash: result.afterHash });
			},
		},
	});
	pi.registerTool({
		...editDefinition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => toolCalls.run({ toolCallId, identity: { ...config.identity() } }, () => editDefinition.execute(toolCallId, params, signal, onUpdate, ctx)),
	});

	const writeDefinition = createWriteToolDefinition(cwd, {
		operations: {
			mkdir: async () => {},
			writeFile: async (path, content) => {
				const { toolCallId, identity } = currentToolCall();
				await requireConnection().sendRequest<ReadBaseResult>(FileReadBase.method, { path, toolCallId, identity });
				const result = await requireConnection().sendRequest<CommitResult>(FileCommit.method, {
					path,
					contentBase64: Buffer.from(content, "utf8").toString("base64"),
					toolCallId,
					tool: "write",
					identity,
				});
				await recordEdit({ toolCallId, tool: "write", path, beforeHash: result.beforeHash, afterHash: result.afterHash });
			},
		},
	});
	pi.registerTool({
		...writeDefinition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => toolCalls.run({ toolCallId, identity: { ...config.identity() } }, () => writeDefinition.execute(toolCallId, params, signal, onUpdate, ctx)),
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
			const locations = await requireConnection().sendRequest<readonly LocationResult[]>(EditorDefinition.method, { path: params.path, line: params.line - 1, character: params.character - 1 }, cancellation.token);
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
			const locations = await requireConnection().sendRequest<readonly LocationResult[]>(EditorReferences.method, { path: params.path, line: params.line - 1, character: params.character - 1 }, cancellation.token);
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
			const diagnostics = await requireConnection().sendRequest<readonly DiagnosticResult[]>(EditorDiagnostics.method, { path: params.path }, cancellation.token);
			if (diagnostics.length === 0) {
				return textResult("没有诊断");
			}
			return textResult(
				diagnostics.map((item) => `${item.path}:${item.line + 1}:${item.character + 1} [${item.severity}${item.source ? ` ${item.source}` : ""}] ${item.message}`).join("\n"),
			);
		},
	});
}
