import { basename } from "node:path";
import * as vscode from "vscode";
import type { PiHub } from "../session/hub";
import { isUntitledResource, parseSessionResource } from "../sessions/sessionUri";

export const FOLDER_GROUP = "folder";

type OptionItem = vscode.ChatSessionProviderOptionItem;
type OptionGroup = vscode.ChatSessionProviderOptionGroup;
type NativeInputState = vscode.ChatSessionInputState & { readonly untitledSessionResource?: vscode.Uri; _setGroups(groups: readonly OptionGroup[]): void; _fireDidChange(): void };

function nativeInputState(state: vscode.ChatSessionInputState): NativeInputState {
	const native = state as Partial<NativeInputState>;
	if (!("untitledSessionResource" in native) || typeof native._setGroups !== "function" || typeof native._fireDidChange !== "function") throw new Error("当前 VS Code 不支持 Pi 所需的会话输入状态接口，请使用兼容的 VS Code 版本");
	return state as NativeInputState;
}

/** VS Code 为该会话保存的选项值（选项组 ID → 选中项 ID） */
export function valuesFromOptions(options: ReadonlyArray<{ optionId: string; value: string | OptionItem }> | undefined): Map<string, string> {
	const values = new Map<string, string>();
	for (const option of options ?? []) {
		values.set(option.optionId, typeof option.value === "string" ? option.value : option.value.id);
	}
	return values;
}

/** 输入状态中各组的选中项，用作会话内容的 options */
export function optionsOfState(state: vscode.ChatSessionInputState): Record<string, OptionItem> {
	const options: Record<string, OptionItem> = {};
	for (const group of state.groups) {
		if (group.selected) {
			options[group.id] = group.selected;
		}
	}
	return options;
}

function folderItem(folder: string, locked: boolean): OptionItem {
	return { id: folder, name: basename(folder), description: folder, icon: new vscode.ThemeIcon("folder"), locked };
}

/**
 * 管理 Pi 会话输入区的“工作目录”选项组（工作区有多个文件夹时显示），并跟踪 VS Code 何时释放会话内容。
 *
 * VS Code 1.144.0 按会话类型保存选项组、按会话保存选中项，因此所有输入状态使用同一组条目：
 * 新会话可以选择工作目录，已有会话的选中项为锁定的会话工作目录。
 */
export class SessionOptions implements vscode.Disposable {
	private readonly liveStates = new Set<vscode.ChatSessionInputState>();
	private readonly stateSubscriptions = new Map<vscode.ChatSessionInputState, vscode.Disposable[]>();
	private readonly subscriptions: vscode.Disposable[];
	private disposed = false;

	constructor(
		private readonly hub: PiHub,
		private readonly controller: vscode.ChatSessionItemController,
	) {
		this.subscriptions = [vscode.workspace.onDidChangeWorkspaceFolders(() => void this.pushGroups())];
	}

	/** 没有输入状态时，VS Code 已经释放了该会话的内容 */
	isReleased(sessionId: string): boolean {
		return this.hub.inputSubscriptionCount(sessionId) === 0;
	}

	async provide(resource: vscode.Uri | undefined, previous: vscode.ChatSessionInputState | undefined): Promise<vscode.ChatSessionInputState> {
		const sessionId = resource !== undefined && !isUntitledResource(resource) ? parseSessionResource(resource) : undefined;
		const cwd = sessionId !== undefined ? await this.cwdOf(sessionId) : undefined;
		const previousFolder = previous?.groups.find((group) => group.id === FOLDER_GROUP)?.selected?.id;
		const state = this.controller.createChatSessionInputState(this.groups(cwd, previousFolder));
		nativeInputState(state);
		this.track(state, resource);
		return state;
	}

	/** VS Code 1.144 在返回输入状态后设置 untitledSessionResource；正式会话使用公开的 sessionResource。 */
	private resourceOf(state: vscode.ChatSessionInputState): vscode.Uri | undefined {
		const resource = state.sessionResource ?? nativeInputState(state).untitledSessionResource;
		if (resource !== undefined && (!(resource instanceof vscode.Uri) || resource.scheme !== "pi-harness")) throw new Error("Pi 输入状态缺少有效的会话 URI");
		return resource;
	}

	private registerState(state: vscode.ChatSessionInputState, knownResource?: vscode.Uri): void {
		if (this.disposed || !this.liveStates.has(state)) return;
		const resource = knownResource ?? this.resourceOf(state);
		if (resource) this.hub.trackInputState(resource, state);
	}

	/** 选项变化带有准确的会话 URI，同类型的其他草稿保留自己的选择。 */
	readonly handleOptionsChange: NonNullable<vscode.ChatSessionContentProvider["provideHandleOptionsChange"]> = (resource, updates) => {
		const states = [...this.liveStates].filter((state) => this.resourceOf(state)?.toString() === resource.toString());
		if (states.length === 0) throw new Error(`Pi 工作目录变更找不到对应的输入状态：${resource.toString()}`);
		const values = new Map(updates.map((update) => {
			if (update.value === undefined) throw new Error(`Pi 输入选项缺少值：${update.optionId}`);
			return [update.optionId, update.value];
		}));
		for (const state of states) {
			const groups = state.groups.map((group) => {
				const selectedId = values.get(group.id);
				if (selectedId === undefined || group.selected?.id === selectedId) return group;
				const selected = group.items.find((item) => item.id === selectedId);
				if (!selected) throw new Error(`Pi 输入选项不存在：${group.id}/${selectedId}`);
				return { ...group, selected };
			});
			if (groups.every((group, index) => group === state.groups[index])) continue;
			// 与 VS Code 1.144 的目录更新路径相同，静默设置当前状态后发送其变化事件。
			const native = nativeInputState(state);
			native._setGroups(groups);
			native._fireDidChange();
		}
	};

	/** 已有会话返回其工作目录；新建后尚未发送第一条消息的会话返回 undefined */
	private async cwdOf(sessionId: string): Promise<string | undefined> {
		if (this.hub.pendingSession(sessionId)) {
			return undefined;
		}
		return (await this.hub.locate(sessionId))?.cwd;
	}

	private groups(cwd: string | undefined, previousFolder: string | undefined): OptionGroup[] {
		const folders = this.hub.folders();
		if (folders.length <= 1) {
			return [];
		}
		const items = folders.map((folder) => folderItem(folder, false));
		const selected = cwd !== undefined ? folderItem(cwd, true) : (items.find((item) => item.id === previousFolder) ?? items[0]);
		return [{ id: FOLDER_GROUP, name: "工作目录", items, selected, icon: new vscode.ThemeIcon("folder") }];
	}

	private track(state: vscode.ChatSessionInputState, resource: vscode.Uri | undefined): void {
		this.liveStates.add(state);
		this.registerState(state, resource);
		setImmediate(() => this.registerState(state));
		this.stateSubscriptions.set(state, [
			state.onDidChange(() => this.registerState(state)),
			state.onDidDispose(() => {
				this.liveStates.delete(state);
				for (const subscription of this.stateSubscriptions.get(state) ?? []) subscription.dispose();
				this.stateSubscriptions.delete(state);
			}),
		]);
	}

	/** 工作区文件夹变化后，按各输入状态原来的选择重新设置选项组 */
	private async pushGroups(): Promise<void> {
		for (const state of this.liveStates) {
			const resource = this.resourceOf(state);
			const sessionId = resource !== undefined && !isUntitledResource(resource) ? parseSessionResource(resource) : undefined;
			const cwd = sessionId !== undefined ? await this.cwdOf(sessionId) : undefined;
			const previousFolder = state.groups.find((group) => group.id === FOLDER_GROUP)?.selected?.id;
			state.groups = this.groups(cwd, previousFolder);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const subscriptions of this.stateSubscriptions.values()) for (const subscription of subscriptions) subscription.dispose();
		this.stateSubscriptions.clear(); this.liveStates.clear();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
