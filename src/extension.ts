import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { PiContentProvider } from "./chat/contentProvider";
import { PiParticipant } from "./chat/participant";
import { PI_MODEL_VENDOR, PiModelProvider } from "./chat/piModels";
import { FOLDER_GROUP, SessionOptions } from "./chat/sessionOptions";
import { PiCustomizationProvider } from "./chat/customizationProvider";
import { StatusController } from "./chat/statusController";
import { ForkService } from "./fork/forkService";
import { PiHub } from "./session/hub";
import { SessionList } from "./sessions/sessionList";
import { parseSessionResource, SESSION_TYPE, sessionResource } from "./sessions/sessionUri";

/** 测试通过 `vscode.extensions.getExtension("local.pi-harness").exports` 取得 */
export interface PiHarnessApi {
	readonly hub: PiHub;
	readonly options: SessionOptions;
	readonly list: SessionList;
	readonly controller: vscode.ChatSessionItemController;
	readonly content: PiContentProvider;
	readonly fork: ForkService;
	readonly customizations: PiCustomizationProvider;
	readonly status: StatusController;
}

let activeHub: PiHub | undefined;

function newSessionLabel(request: { readonly prompt: string; readonly command?: string }): string {
	const text = request.prompt.trim().split(/\r?\n/, 1)[0] ?? "";
	if (text.length > 0) {
		return text.length > 80 ? `${text.slice(0, 80)}…` : text;
	}
	return request.command !== undefined ? `/${request.command}` : "新的 Pi 会话";
}

export function activate(context: vscode.ExtensionContext): PiHarnessApi {
	const output = vscode.window.createOutputChannel("Pi Harness");
	const hub = new PiHub(context, output);
	activeHub = hub;

	let list: SessionList | undefined;
	const controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => {
		await list?.refresh();
	});
	list = new SessionList(hub, controller);
	const options = new SessionOptions(hub, controller);
	const fork = new ForkService(hub, controller);
	const status = new StatusController();
	const customizations = new PiCustomizationProvider({
		onDidChange: hub.onDidChangeInputs,
		onDidDisposeResource: hub.onDidDisposeInputResource,
		isResourceActive: (resource) => hub.isInputResourceActive(resource),
		agentDir: async () => (await hub.runtime()).modules.getAgentDir(),
		skillsForResource: (resource) => hub.skillsForResource(resource),
		cwdForResource: (resource) => hub.cwdForResource(resource),
		onResourceFilesChanged: (resource) => hub.resourceFilesChanged(resource),
		logDiagnostic: (message) => hub.log(message),
	});
	const statusSubscription = hub.onDidChangeBackend(() => {
		status.updateBackend(hub.backendStatus?.snapshot);
		status.updateGuardian(hub.backendStatus?.guardianStatus);
	});

	controller.getChatSessionInputState = (resource, inputContext) => options.provide(resource, inputContext.previousInputState);
	controller.newChatSessionItemHandler = async (newContext) => {
		const sessionId = randomUUID();
		const label = newSessionLabel(newContext.request);
		const folders = hub.folders();
		const cwd = newContext.inputState.groups.find((group) => group.id === FOLDER_GROUP)?.selected?.id ?? (folders.length === 1 ? folders[0] : undefined);
		if (cwd === undefined || !hub.isWorkspaceFolder(cwd)) {
			throw new Error("请选择当前工作区中的一个文件夹作为 Pi 会话的工作目录");
		}
		const created = Date.now();
		hub.addPending({ sessionId, label, created, cwd });
		const item = controller.createChatSessionItem(sessionResource(sessionId), label);
		item.timing = { created };
		item.status = vscode.ChatSessionStatus.InProgress;
		return item;
	};
	controller.forkHandler = (resource, request) => fork.fork(resource, request);
	const archiveSubscription = controller.onDidChangeChatSessionItemState((item) => {
		const sessionId = parseSessionResource(item.resource);
		void hub.setArchived(sessionId, item.archived === true).catch((error: unknown) => {
			const message = `更新 Pi 会话归档状态失败：${error instanceof Error ? error.message : String(error)}`;
			hub.log(message);
			void vscode.window.showErrorMessage(message);
			hub.notifyChanged(sessionId);
		});
	});

	const participant = vscode.chat.createChatParticipant(SESSION_TYPE, new PiParticipant(hub, customizations).handler);
	participant.iconPath = new vscode.ThemeIcon("hubot");
	const contentProvider = new PiContentProvider(hub, options.handleOptionsChange);

	context.subscriptions.push(
		output,
		hub,
		controller,
		list,
		options,
		status,
		statusSubscription,
		customizations,
		vscode.chat.registerChatSessionCustomizationProvider(SESSION_TYPE, { label: "Pi", iconId: "hubot", supportedTypes: [vscode.ChatSessionCustomizationType.Skill] }, customizations),
		archiveSubscription,
		participant,
		vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, contentProvider, participant, { supportsInterruptions: true }),
		vscode.lm.registerLanguageModelChatProvider(PI_MODEL_VENDOR, new PiModelProvider(hub)),
		...registerCommands(hub, list),
		vscode.workspace.onDidGrantWorkspaceTrust(() => void hub.refreshChoices()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void hub.refreshChoices()),
	);
	list.scheduleRefresh();
	return { hub, options, list, controller, content: contentProvider, fork, customizations, status };
}

export async function deactivate(): Promise<void> {
	const hub = activeHub;
	activeHub = undefined;
	await hub?.deactivate();
}
