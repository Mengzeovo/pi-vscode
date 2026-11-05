import { RequestType } from "vscode-jsonrpc";

/** 传给 Pi 子进程的环境变量：命名管道路径和握手令牌，Pi 扩展读取后立即从环境中删除 */
export const ENV_IPC_PATH = "PI_HARNESS_IPC_PATH";
export const ENV_IPC_TOKEN = "PI_HARNESS_IPC_TOKEN";

/** 会话文件中由 Pi 扩展写入的条目类型 */
export const REQUEST_ENTRY_TYPE = "pi-harness.request";
export const EDIT_ENTRY_TYPE = "pi-harness.edit";

/** Pi 扩展注册的内部命令：把当前分支退回到指定用户消息之前（VS Code 中编辑请求后使用） */
export const REWIND_COMMAND = "pi-harness-rewind";

/** 支持的 Copilot 工具 */
export const COPILOT_TOOL_NAMES = ["copilot_searchWorkspaceSymbols", "copilot_searchCodebase", "copilot_getErrors"] as const;

export type ReferenceKind = "file" | "selection" | "symbol" | "diagnostic" | "image" | "other";

export interface RangeRecord {
	/** 零起始行列 */
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;
}

export interface ReferenceRecord {
	readonly kind: ReferenceKind;
	readonly name: string;
	/** VS Code 引用 ID，例如 vscode.implicit.selection */
	readonly id: string;
	/** 文件 URI 字符串 */
	readonly uri?: string;
	readonly range?: RangeRecord;
	readonly documentVersion?: number;
}

/** `pi-harness.request` 条目的数据：VS Code 请求与 Pi 用户消息条目的对应关系 */
export interface RequestEntryData {
	readonly requestId: string;
	readonly userEntryId: string;
	readonly userText: string;
	readonly references: readonly ReferenceRecord[];
}

/** `pi-harness.edit` 条目的数据：Pi 通过 edit/write 写入的一次修改 */
export interface EditEntryData {
	readonly toolCallId: string;
	readonly tool: "edit" | "write";
	readonly path: string;
	/** 修改前内容的 SHA-256；文件原先不存在时为 null */
	readonly beforeHash: string | null;
	readonly afterHash: string;
}

export interface CopilotToolDeclaration {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

export interface HelloParams {
	readonly token: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly parentSessionId?: string;
	readonly role: "root" | "child";
	readonly identity: Pick<CommitIdentity, "sessionId" | "generationId" | "ownershipId" | "runtimeGeneration"> & Partial<Pick<CommitIdentity, "rootRequestId" | "runId" | "operationEpoch">>;
}

export interface HelloResult {
	readonly copilotTools: readonly CopilotToolDeclaration[];
}

export interface SetTurnToolsParams {
	/** 下一次运行启用的 Copilot 工具名称 */
	readonly enabledCopilotTools: readonly string[];
}

export interface RecordRequestParams {
	readonly requestId: string;
	/** 用户消息的完整文字，用于在当前分支中定位条目 */
	readonly messageText: string;
	readonly userText: string;
	readonly references: readonly ReferenceRecord[];
}

export interface RecordRequestResult {
	readonly userEntryId: string;
}

export interface PositionParams {
	readonly path: string;
	/** 零起始行列 */
	readonly line: number;
	readonly character: number;
}

export interface LocationResult {
	readonly path: string;
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;
	readonly preview: string;
}

export interface DiagnosticsParams {
	readonly path: string | undefined;
}

export interface DiagnosticResult {
	readonly path: string;
	readonly line: number;
	readonly character: number;
	readonly severity: "error" | "warning" | "information" | "hint";
	readonly source: string | undefined;
	readonly message: string;
}

export interface CopilotInvokeParams {
	readonly name: string;
	readonly input: unknown;
	readonly toolCallId: string;
}

export interface ToolTextResult {
	readonly text: string;
	readonly isError: boolean;
}

export interface CommitIdentity {
	readonly sessionId: string;
	readonly generationId: string;
	readonly ownershipId: string;
	readonly runtimeGeneration: number;
	readonly rootRequestId: string;
	readonly runId: string;
	readonly operationEpoch: number;
}

export interface ReadBaseParams {
	readonly path: string;
	readonly toolCallId: string;
	readonly identity: CommitIdentity;
}

export interface ReadBaseResult {
	readonly contentBase64: string;
	readonly exists: boolean;
	readonly hash: string | null;
	readonly documentVersion: number | null;
}

export interface CommitParams {
	readonly path: string;
	readonly contentBase64: string;
	readonly toolCallId: string;
	readonly tool: "edit" | "write";
	readonly identity: CommitIdentity;
}

export interface CommitResult {
	readonly beforeHash: string | null;
	readonly afterHash: string;
}

/** Pi 扩展 → 扩展宿主 */
export const Hello = new RequestType<HelloParams, HelloResult, void>("pi-harness/hello");
export const EditorDefinition = new RequestType<PositionParams, readonly LocationResult[], void>("pi-harness/editor/definition");
export const EditorReferences = new RequestType<PositionParams, readonly LocationResult[], void>("pi-harness/editor/references");
export const EditorDiagnostics = new RequestType<DiagnosticsParams, readonly DiagnosticResult[], void>("pi-harness/editor/diagnostics");
export const CopilotInvoke = new RequestType<CopilotInvokeParams, ToolTextResult, void>("pi-harness/copilot/invoke");
export const FileReadBase = new RequestType<ReadBaseParams, ReadBaseResult, void>("pi-harness/file/readBase");
export const FileCommit = new RequestType<CommitParams, CommitResult, void>("pi-harness/file/commit");

/** 扩展宿主 → Pi 扩展 */
export const SetTurnTools = new RequestType<SetTurnToolsParams, void, void>("pi-harness/setTurnTools");
export const RecordRequest = new RequestType<RecordRequestParams, RecordRequestResult, void>("pi-harness/recordRequest");

export interface RestoreCandidate {
	readonly path: string;
	readonly beforeHash: string | null;
	readonly lastAfterHash: string;
	readonly sourceHashes?: readonly string[];
}

export interface RestoreFileData {
	readonly path: string;
	readonly expectedBase64: string | null;
	readonly targetBase64: string | null;
	readonly expectedHash: string | null;
	readonly targetHash: string | null;
	readonly documentVersion: number | null;
	readonly snapshotHashes: readonly string[];
	readonly restored: boolean;
}

export interface RestorePrepareParams {
	readonly operationId: string;
	readonly rootRequestIds: readonly string[];
	readonly files: readonly RestoreCandidate[];
}

export interface RestoreApplyParams {
	readonly operationId: string;
	readonly file: RestoreFileData;
	readonly reopened: boolean;
}

export const FileRestorePrepare = new RequestType<RestorePrepareParams, readonly RestoreFileData[], void>("pi-harness/file/restorePrepare");
export const FileRestoreApply = new RequestType<RestoreApplyParams, void, void>("pi-harness/file/restoreApply");
export const FileWaitForIdle = new RequestType<void, void, void>("pi-harness/file/waitForIdle");
