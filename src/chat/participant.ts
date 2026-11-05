import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { PiHub } from "../session/hub";
import { CancelledByUser, type PiSession, type PromptInput, type SessionLocation } from "../session/piSession";
import { parseSessionResource } from "../sessions/sessionUri";
import { enabledCopilotTools } from "../tools/copilotTools";
import { readSessionRecords } from "./historyRenderer";
import { selectionFromRequest } from "./piModels";
import { buildRequestContext, composePrompt } from "./requestContext";
import { FOLDER_GROUP, valuesFromOptions } from "./sessionOptions";
import type { PiCustomizationProvider } from "./customizationProvider";

type ChatContext = vscode.ChatContext;

function errorResult(message: string, level = vscode.ChatErrorLevel.Error): vscode.ChatResult {
	return { errorDetails: { message, level } };
}

/** Pi 会话类型的默认 participant：第一条消息和后续消息都经过这里送往 Pi */
export class PiParticipant {
	constructor(private readonly hub: PiHub, private readonly customizations: PiCustomizationProvider) {}

	readonly handler: vscode.ChatExtendedRequestHandler = async (request, context, stream, token) => {
		const sessionContext = context.chatSessionContext;
		if (!sessionContext) {
			return errorResult("Pi 只能在 Pi 会话中使用：请在新建聊天中选择 Pi。");
		}
		if (!vscode.workspace.isTrusted) {
			return errorResult("工作区未受信任，Pi 不会启动。");
		}
		const sessionId = parseSessionResource(sessionContext.chatSessionItem.resource);
		// 工作目录取自 VS Code 为该会话保存的选项值；选项组的条目由所有 Pi 会话共用
		const values = valuesFromOptions(sessionContext.initialSessionOptions);
		const location = await this.locationFor(sessionId, values.get(FOLDER_GROUP));
		if (!existsSync(location.cwd)) {
			return errorResult(`会话的工作目录 ${location.cwd} 已不存在，只能查看历史。`);
		}
		if (!this.hub.isWorkspaceFolder(location.cwd)) {
			return errorResult(`会话属于 ${location.cwd}，与当前打开的工作区不符，只能查看历史。`);
		}
		const session = await this.hub.session(location);
		try {
			await session.ensureWritePermission();
		} catch (error) {
			if (error instanceof CancelledByUser) {
				return errorResult("已取消，会话保持只读。", vscode.ChatErrorLevel.Info);
			}
			throw error;
		}
		if (request.command === "reload") {
			stream.progress(session.isBusy ? "等待当前执行结束后重新加载 Pi 会话" : "正在重新加载 Pi 会话");
			await session.reload();
			stream.markdown("Pi 会话资源已重新加载。");
			this.customizations.refresh();
			this.hub.notifyChanged(sessionId);
			return {};
		}
		await session.ensureStarted();
		this.hub.notifyChanged(sessionId);
		if (request.command === "compact") {
			await session.compact(stream);
			return {};
		}
		const selection = selectionFromRequest(request);
		const skillRequest = await this.customizations.consumeSkillRequest(sessionContext.chatSessionItem.resource, request, token);
		const requestContext = await buildRequestContext(request, skillRequest.excludedReferenceIds);
		let promptText = composePrompt(skillRequest.prompt, requestContext.contextBlock);
		if (await session.isExtensionCommand(skillRequest.prompt)) {
			if (requestContext.references.length > 0) {
				return errorResult("Pi 扩展命令不接收附件，请去掉附件后重新发送。");
			}
			promptText = skillRequest.prompt;
		}
		const input: PromptInput = await session.applyRecoveryInput({
				requestId: request.id,
				promptText,
				userText: request.prompt,
				basePrompt: skillRequest.prompt,
				contextBlock: requestContext.contextBlock,
				references: requestContext.references,
				images: requestContext.images,
				enabledCopilotTools: enabledCopilotTools(request),
				selection,
		});
		await this.alignWithVsCodeHistory(session, location, context.history, input);
		const outcome = await session.runPrompt(
			input,
			context,
			stream,
			token,
			request.toolInvocationToken,
		);
		this.hub.notifyChanged(sessionId);
		if (outcome.error !== undefined) {
			return errorResult(outcome.error);
		}
		return {};
	};

	/**
	 * VS Code 中编辑一条请求并提交时，会撤销通过 externalEdit 记录的修改并移除该请求及之后的请求，
	 * 再把编辑后的文字作为新请求发来。本窗口显示过的 Pi 用户消息不在 VS Code 的历史中时，
	 * 把 Pi 的当前分支退回到第一条被移除的用户消息之前，使两边的对话保持一致。
	 */
	private async alignWithVsCodeHistory(session: PiSession, location: SessionLocation, history: ChatContext["history"], input: PromptInput): Promise<void> {
		if (location.sessionFile === undefined || !existsSync(location.sessionFile)) {
			return;
		}
		const { branch } = await (await this.hub.sessionCatalog()).readBranch(location.sessionFile);
		const inHistory = new Set<string>();
		for (const turn of history) {
			// 运行时 ChatRequestTurn 与 ChatRequestTurn2 是同一个类，id 在 chatParticipantPrivate 中声明
			if (turn instanceof vscode.ChatRequestTurn2 && turn.id !== undefined) {
				inHistory.add(turn.id);
			}
		}
		const requestIdsByEntry = new Map<string, string>();
		for (const [requestId, entryId] of session.requestEntries) {
			requestIdsByEntry.set(entryId, requestId);
		}
		for (const record of readSessionRecords(branch).requests.values()) {
			requestIdsByEntry.set(record.userEntryId, record.requestId);
		}
		const shown = new Set([...this.hub.shownEntryIds(location.sessionId), ...session.requestEntries.values()]);
		const users = branch.filter((entry) => entry.type === "message" && entry.message.role === "user" && shown.has(entry.id));
		const present = (entryId: string): boolean => inHistory.has(entryId) || inHistory.has(requestIdsByEntry.get(entryId) ?? "");
		const firstMissing = users.findIndex((entry) => !present(entry.id));
		if (firstMissing < 0) {
			return;
		}
		if (users.slice(firstMissing).some((entry) => present(entry.id))) {
			throw new Error("VS Code 中的请求与 Pi 会话的当前分支不一致，请重新打开该会话后再发送。");
		}
		const target = users[firstMissing];
		const rootRequestIds = users.slice(firstMissing).map((entry) => requestIdsByEntry.get(entry.id) ?? entry.id);
		await session.rewindBefore(target.id, target.parentId, input, rootRequestIds);
	}

	/** 已有会话直接返回位置；新会话在第一条消息时按“工作目录”选项或唯一的工作区文件夹确定工作目录 */
	private async locationFor(sessionId: string, selectedFolder: string | undefined): Promise<SessionLocation> {
		const pending = this.hub.pendingSession(sessionId);
		if (pending) {
			const folders = this.hub.folders();
			const cwd = pending.cwd ?? (folders.length > 1 ? selectedFolder : folders[0]);
			if (cwd === undefined) {
				throw new Error("没有打开的本地文件夹，Pi 需要一个工作目录");
			}
			return this.hub.allocate(cwd, sessionId);
		}
		const location = await this.hub.locate(sessionId);
		if (!location) {
			throw new Error(`没有找到 Pi 会话 ${sessionId}`);
		}
		return location;
	}
}
