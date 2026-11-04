import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { PiContentProvider } from "./chat/contentProvider";
import { PiParticipant } from "./chat/participant";
import { PI_MODEL_VENDOR, PiModelProvider } from "./chat/piModels";
import { SessionOptions } from "./chat/sessionOptions";
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

	controller.getChatSessionInputState = (resource, inputContext) => options.provide(resource, inputContext.previousInputState);
	controller.newChatSessionItemHandler = async (newContext) => {
		const sessionId = randomUUID();
		const label = newSessionLabel(newContext.request);
		hub.addPending({ sessionId, label, created: Date.now() });
		const item = controller.createChatSessionItem(sessionResource(sessionId), label);
		item.timing = { created: Date.now() };
		item.status = vscode.ChatSessionStatus.InProgress;
		return item;
	};
	controller.forkHandler = (resource, request) => fork.fork(resource, request);
	const archiveSubscription = controller.onDidChangeChatSessionItemState((item) => {
		void hub.setArchived(parseSessionResource(item.resource), item.archived === true);
	});

	const participant = vscode.chat.createChatParticipant(SESSION_TYPE, new PiParticipant(hub).handler);
	participant.iconPath = new vscode.ThemeIcon("hubot");
	const contentProvider = new PiContentProvider(hub);

	context.subscriptions.push(
		output,
		hub,
		controller,
		list,
		options,
		archiveSubscription,
		participant,
		vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, contentProvider, participant, { supportsInterruptions: true }),
		vscode.lm.registerLanguageModelChatProvider(PI_MODEL_VENDOR, new PiModelProvider(hub)),
		...registerCommands(hub, list),
		vscode.workspace.onDidGrantWorkspaceTrust(() => void hub.refreshChoices()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void hub.refreshChoices()),
	);
	list.scheduleRefresh();
	return { hub, options, list, controller, content: contentProvider, fork };
}

export async function deactivate(): Promise<void> {
	const hub = activeHub;
	activeHub = undefined;
	await hub?.deactivate();
}
