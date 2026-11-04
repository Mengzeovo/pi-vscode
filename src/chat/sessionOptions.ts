import { basename } from "node:path";
import * as vscode from "vscode";
import type { PiHub } from "../session/hub";
import { isUntitledResource, parseSessionResource } from "../sessions/sessionUri";

export const FOLDER_GROUP = "folder";

type OptionItem = vscode.ChatSessionProviderOptionItem;
type OptionGroup = vscode.ChatSessionProviderOptionGroup;

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
	private readonly statesBySession = new Map<string, Set<vscode.ChatSessionInputState>>();
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly hub: PiHub,
		private readonly controller: vscode.ChatSessionItemController,
	) {
		this.subscriptions = [vscode.workspace.onDidChangeWorkspaceFolders(() => void this.pushGroups())];
	}

	/** 没有输入状态时，VS Code 已经释放了该会话的内容 */
	isReleased(sessionId: string): boolean {
		return !this.statesBySession.has(sessionId);
	}

	async provide(resource: vscode.Uri | undefined, previous: vscode.ChatSessionInputState | undefined): Promise<vscode.ChatSessionInputState> {
		const sessionId = resource !== undefined && !isUntitledResource(resource) ? parseSessionResource(resource) : undefined;
		const cwd = sessionId !== undefined ? await this.cwdOf(sessionId) : undefined;
		const previousFolder = previous?.groups.find((group) => group.id === FOLDER_GROUP)?.selected?.id;
		const state = this.controller.createChatSessionInputState(this.groups(cwd, previousFolder));
		this.track(state, sessionId);
		return state;
	}

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

	private track(state: vscode.ChatSessionInputState, sessionId: string | undefined): void {
		this.liveStates.add(state);
		if (sessionId !== undefined) {
			const states = this.statesBySession.get(sessionId) ?? new Set();
			states.add(state);
			this.statesBySession.set(sessionId, states);
			this.hub.existingSession(sessionId)?.markContentReleased(false);
		}
		state.onDidDispose(() => {
			this.liveStates.delete(state);
			if (sessionId === undefined) {
				return;
			}
			const states = this.statesBySession.get(sessionId);
			states?.delete(state);
			if (states?.size === 0) {
				// 新的输入状态在旧状态释放之前创建，集合为空说明 VS Code 释放了该会话的内容
				this.statesBySession.delete(sessionId);
				this.hub.existingSession(sessionId)?.markContentReleased(true);
			}
		});
	}

	/** 工作区文件夹变化后，按各输入状态原来的选择重新设置选项组 */
	private async pushGroups(): Promise<void> {
		for (const state of this.liveStates) {
			const sessionId = state.sessionResource !== undefined && !isUntitledResource(state.sessionResource) ? parseSessionResource(state.sessionResource) : undefined;
			const cwd = sessionId !== undefined ? await this.cwdOf(sessionId) : undefined;
			const previousFolder = state.groups.find((group) => group.id === FOLDER_GROUP)?.selected?.id;
			state.groups = this.groups(cwd, previousFolder);
		}
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
