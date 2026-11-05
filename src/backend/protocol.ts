import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { NotificationType, RequestType } from "vscode-jsonrpc";
import type { CommitIdentity, EditEntryData, ReferenceRecord } from "../../shared/protocol";
import type { RestoreInput, RestoreOperation } from "./operationStore";
import type { McpState } from "./resources";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type BackendRpcCommand = WithoutId<RpcCommand>;
export interface BackendCommandInput {
	readonly userText: string;
	readonly contextBlock?: string;
	readonly references: readonly ReferenceRecord[];
}

export interface BackendIdentity {
	readonly generationId: string;
	readonly sessionId: string;
}

export interface BackendInitializeParams {
	readonly generationId: string;
	readonly packageDir: string;
	readonly compatRoot: string;
	readonly piExtensionPath: string;
	readonly agentDir?: string;
	readonly residencyLimit: number;
	readonly authorization: { readonly backendPid: number; readonly guardianPid: number; readonly hostPid: number; readonly jobName: string; readonly token: string; readonly backendCreationTime: string; readonly guardianCreationTime: string; readonly hostCreationTime: string };
}

export interface BackendOpenParams extends BackendIdentity {
	readonly cwd: string;
	readonly sessionDir: string;
	readonly sessionFile: string;
	readonly ownershipId: string;
	readonly bridge: { readonly path: string; readonly token: string };
	readonly projectTrusted: boolean;
	readonly initialSubscriptions?: readonly string[];
	readonly name?: string;
	readonly model?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel?: RpcSessionState["thinkingLevel"] };
}

export interface BackendSessionSnapshot extends BackendIdentity {
	readonly runtimeGeneration: number;
	readonly sequence: number;
	readonly name: string;
	readonly cwd: string;
	readonly sessionFile: string;
	readonly state: "loading" | "loaded" | "running" | "waiting" | "reload-pending" | "reloading" | "reload-failed" | "releasing" | "released" | "protected";
	readonly busy: boolean;
	readonly subscriptions: number;
	readonly childTasks: number;
	readonly pendingInteractions: number;
	readonly pendingCommits: number;
	readonly reloadPending: boolean;
	readonly resourceOperation?: "loading" | "closing";
	readonly error?: string;
	readonly mcp?: McpState;
	readonly runId?: string;
	readonly requestId?: string;
	readonly messages: readonly unknown[];
	readonly rpcState?: RpcSessionState;
}

export interface BackendEventParams extends BackendIdentity {
	readonly runtimeGeneration: number;
	readonly sequence: number;
	readonly requestId?: string;
	readonly runId?: string;
	readonly event: JsonAgentSessionEvent;
}

export interface BackendUiParams extends BackendIdentity {
	readonly runtimeGeneration: number;
	readonly sequence: number;
	readonly requestId?: string;
	readonly runId?: string;
	readonly request: RpcExtensionUIRequest;
}

export interface BackendSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly source: string;
	readonly disableModelInvocation: boolean;
}

export interface BackendCatalogSnapshot {
	readonly cwd: string;
	readonly models: readonly NonNullable<RpcSessionState["model"]>[];
	readonly levels: Readonly<Record<string, readonly RpcSessionState["thinkingLevel"][]>>;
	readonly defaultModel?: string;
	readonly defaultThinking: RpcSessionState["thinkingLevel"];
	readonly skills: readonly BackendSkill[];
}

export interface BackendProcessSnapshot {
	readonly generationId: string;
	readonly pid: number;
	readonly cpuPercent: number;
	readonly rssBytes: number;
	readonly sessions: readonly BackendSessionSnapshot[];
}

export const BackendInitialize = new RequestType<BackendInitializeParams, { readonly pid: number; readonly generationId: string }, void>("pi-backend/initialize");
export const BackendPrepareSession = new RequestType<BackendIdentity & { readonly cwd: string; readonly sessionDir: string; readonly sessionFile?: string }, { readonly sessionFile: string }, void>("pi-backend/prepareSession");
export const BackendOpen = new RequestType<BackendOpenParams, BackendSessionSnapshot, void>("pi-backend/open");
export const BackendCommand = new RequestType<BackendIdentity & { readonly requestId: string; readonly command: BackendRpcCommand; readonly input?: BackendCommandInput }, unknown, void>("pi-backend/command");
export const BackendSubscribe = new RequestType<BackendIdentity & { readonly subscriptionId: string }, BackendSessionSnapshot, void>("pi-backend/subscribe");
export const BackendUnsubscribe = new RequestType<BackendIdentity & { readonly subscriptionId: string }, void, void>("pi-backend/unsubscribe");
export const BackendReload = new RequestType<BackendIdentity & { readonly operationId: string }, BackendSessionSnapshot, void>("pi-backend/reload");
export const BackendRelease = new RequestType<BackendIdentity & { readonly stop: boolean; readonly reason: "release" | "archive" | "delete" | "terminal" }, void, void>("pi-backend/release");
export const BackendCatalog = new RequestType<{ readonly generationId: string; readonly cwd: string; readonly projectTrusted: boolean; readonly refresh?: boolean; readonly sessionId?: string }, BackendCatalogSnapshot, void>("pi-backend/catalog");
export const BackendRespondUi = new NotificationType<BackendIdentity & { readonly runtimeGeneration: number; readonly response: RpcExtensionUIResponse }>("pi-backend/respondUi");
export const BackendSetProtection = new RequestType<BackendIdentity & { readonly recovery: boolean; readonly commits?: number; readonly archived?: boolean; readonly name?: string }, void, void>("pi-backend/protection");
export const BackendValidateIdentity = new RequestType<CommitIdentity, void, void>("pi-backend/validateIdentity");
export const BackendRecordFileIntent = new RequestType<{ readonly identity: CommitIdentity; readonly edit: EditEntryData }, void, void>("pi-backend/recordFileIntent");
export type BackendRestoreInput = Omit<RestoreInput, "sessionId" | "operationEpoch" | "sourceLeaf">;
export const BackendRestore = new RequestType<BackendIdentity & { readonly input: BackendRestoreInput }, RestoreOperation, void>("pi-backend/restore");
export const BackendResumeRecovery = new RequestType<BackendIdentity, RestoreOperation | null, void>("pi-backend/resumeRecovery");
export const BackendPendingRecovery = new RequestType<BackendIdentity & { readonly sessionFile: string }, RestoreOperation | null, void>("pi-backend/pendingRecovery");
export const BackendMarkSubmitted = new RequestType<BackendIdentity & { readonly requestId: string; readonly userEntryId: string }, void, void>("pi-backend/markSubmitted");
export const BackendShutdown = new RequestType<{ readonly generationId: string; readonly deadline: number }, void, void>("pi-backend/shutdown");
export const BackendEvent = new NotificationType<BackendEventParams>("pi-backend/event");
export const BackendUi = new NotificationType<BackendUiParams>("pi-backend/ui");
export const BackendSnapshot = new NotificationType<BackendProcessSnapshot>("pi-backend/snapshot");
export const BackendSessionChanged = new NotificationType<BackendSessionSnapshot>("pi-backend/sessionChanged");
export const BackendSessionReleased = new NotificationType<BackendIdentity & { readonly ownershipId: string }>("pi-backend/sessionReleased");
export const BackendCatalogChanged = new NotificationType<{ readonly generationId: string; readonly cwd: string; readonly sessionId?: string }>("pi-backend/catalogChanged");
