import type { ProcessIdentity } from "./native";
import type { OwnershipRecord } from "../backend/operationStore";

export interface GuardianStart { host: ProcessIdentity; nonce: string; }
export interface GuardianReady { guardian: ProcessIdentity; }
export interface GenerationRequest { generationId: string; token: string; backend: ProcessIdentity; }
export interface GenerationAuthorization {
	generationId: string; jobName: string; token: string;
	hostPid: number; hostCreationTime: string;
	guardianPid: number; guardianCreationTime: string;
	backendPid: number; backendCreationTime: string;
}
export interface SessionOwnershipRequest { sessionId: string; sessionFile: string; cwd: string; generationId: string; }
export interface OwnershipProof { sessionFile: string; record: OwnershipRecord; }
export interface ProcessUsage { pid: number; cpuPercent: number; rssBytes: number; sampledAt: number; }
export interface GuardianSnapshot { generationId?: string; state: "running" | "cleaning"; sessionIds: string[]; usage: ProcessUsage; }
