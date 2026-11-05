import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { BackendSkill } from "../backend/protocol";
import type { SharedBackendClient } from "./sharedBackend";

export type PiModel = NonNullable<RpcSessionState["model"]>;
export type ThinkingLevel = RpcSessionState["thinkingLevel"];

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export interface CatalogSnapshot {
	readonly models: readonly PiModel[];
	/** 模型键 → 该模型支持的思考级别 */
	readonly levels: ReadonlyMap<string, readonly ThinkingLevel[]>;
	/** Pi 为该工作目录中的新会话选择的模型；没有可用模型时为 undefined */
	readonly defaultModel: string | undefined;
	readonly defaultThinking: ThinkingLevel;
	readonly skills: readonly BackendSkill[];
}

/** 工作目录的资源目录由窗口共享后台读取。 */
export class ModelCatalog {
	private snapshotPromise: Promise<CatalogSnapshot> | undefined;

	constructor(
		private readonly backend: () => Promise<SharedBackendClient>,
		private readonly cwd: string,
		private readonly trusted: () => boolean,
	) {}

	/** 读取失败时清除缓存，后续请求重新检查后台与资源。 */
	snapshot(): Promise<CatalogSnapshot> {
		if (!this.snapshotPromise) {
			const building: Promise<CatalogSnapshot> = this.build().catch(async (error: unknown) => {
				if (this.snapshotPromise === building) {
					this.snapshotPromise = undefined;
					await this.dispose();
				}
				throw error;
			});
			this.snapshotPromise = building;
		}
		return this.snapshotPromise;
	}

	/** 重新加载该目录的查询资源。 */
	async refresh(): Promise<void> {
		this.invalidate();
		await (await this.backend()).catalog(this.cwd, this.trusted(), true);
	}

	invalidate(): void { this.snapshotPromise = undefined; }

	async dispose(): Promise<void> {
		this.invalidate();
	}

	private async build(): Promise<CatalogSnapshot> {
		const snapshot = await (await this.backend()).catalog(this.cwd, this.trusted());
		return { ...snapshot, defaultModel: snapshot.defaultModel, levels: new Map(Object.entries(snapshot.levels)) };
	}
}
