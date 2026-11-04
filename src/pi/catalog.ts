import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { PiRuntime } from "./piRuntime";
import { PiRpcProcess, type RpcData } from "./rpcProcess";

export type PiModel = RpcData<"get_available_models">["models"][number];
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
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * 为一个工作区文件夹启动的、只用于读取模型列表的 Pi 进程。
 * 不创建会话文件；为了取得每个模型的思考级别会在该进程内存中的会话里切换模型，不改写全局默认值。
 */
export class ModelCatalog {
	private process: PiRpcProcess | undefined;
	private snapshotPromise: Promise<CatalogSnapshot> | undefined;

	constructor(
		private readonly runtime: PiRuntime,
		private readonly cwd: string,
		private readonly log: (line: string) => void,
	) {}

	/** 读取失败时结束这次启动的进程，不保留失败的结果，下次读取时重新启动 Pi */
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

	/** 结束当前进程，下次读取时重新启动 */
	async refresh(): Promise<void> {
		this.snapshotPromise = undefined;
		await this.dispose();
	}

	async dispose(): Promise<void> {
		const process = this.process;
		this.process = undefined;
		if (process && !process.hasExited) {
			await process.shutdown();
		}
	}

	private async build(): Promise<CatalogSnapshot> {
		const process = new PiRpcProcess({
			runtime: this.runtime,
			cwd: this.cwd,
			args: ["--no-session", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files"],
			env: {},
			label: `模型列表 ${this.cwd}`,
			log: this.log,
		});
		this.process = process;
		// 用户扩展在该进程中弹出的对话框没有人回答，直接取消
		process.onExtensionUiRequest((request) => {
			if (DIALOG_METHODS.has(request.method)) {
				process.respondUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			}
		});
		const state = await process.send({ type: "get_state" });
		const { models } = await process.send({ type: "get_available_models" });
		const levels = new Map<string, readonly ThinkingLevel[]>();
		for (const model of models) {
			await process.send({ type: "set_model", provider: model.provider, modelId: model.id });
			levels.set(modelKey(model), (await process.send({ type: "get_available_thinking_levels" })).levels);
		}
		return {
			models,
			levels,
			defaultModel: state.model ? modelKey(state.model) : undefined,
			defaultThinking: state.thinkingLevel,
		};
	}
}
