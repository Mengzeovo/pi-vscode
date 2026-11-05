import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, RpcExtensionUIRequest, RpcExtensionUIResponse, Theme } from "@earendil-works/pi-coding-agent";

type UiRequest = RpcExtensionUIRequest extends infer T ? T extends RpcExtensionUIRequest ? Omit<T, "id" | "type"> : never : never;
export class BackendUiBridge {
	private readonly pending = new Map<string, { resolve(response: RpcExtensionUIResponse): void; cancel(): void }>();
	private editorText = "";
	readonly context: ExtensionUIContext;

	constructor(theme: Theme, private readonly send: (request: RpcExtensionUIRequest) => void, private readonly changed: () => void) {
		const notify = (request: UiRequest): void => send({ ...request, id: randomUUID(), type: "extension_ui_request" } as RpcExtensionUIRequest);
		this.context = {
			select: (title, options, opts) => this.dialog({ method: "select", title, options, timeout: opts?.timeout }, opts).then((r) => "value" in r ? r.value : undefined),
			confirm: (title, message, opts) => this.dialog({ method: "confirm", title, message, timeout: opts?.timeout }, opts).then((r) => "confirmed" in r && r.confirmed),
			input: (title, placeholder, opts) => this.dialog({ method: "input", title, placeholder, timeout: opts?.timeout }, opts).then((r) => "value" in r ? r.value : undefined),
			editor: (title, prefill) => this.dialog({ method: "editor", title, prefill }).then((r) => "value" in r ? r.value : undefined),
			notify: (message, type) => notify({ method: "notify", message, notifyType: type }),
			setStatus: (statusKey, statusText) => notify({ method: "setStatus", statusKey, statusText }),
			setWidget: (widgetKey, content, opts) => { if (content === undefined || Array.isArray(content)) notify({ method: "setWidget", widgetKey, widgetLines: content, widgetPlacement: opts?.placement }); },
			setTitle: (title) => notify({ method: "setTitle", title }),
			setEditorText: (text) => { this.editorText = text; notify({ method: "set_editor_text", text }); },
			pasteToEditor: (text) => { this.editorText += text; notify({ method: "set_editor_text", text: this.editorText }); },
			getEditorText: () => this.editorText,
			onTerminalInput: () => () => undefined,
			setWorkingMessage: () => undefined, setWorkingVisible: () => undefined, setWorkingIndicator: () => undefined, setHiddenThinkingLabel: () => undefined,
			setFooter: () => undefined, setHeader: () => undefined, custom: async () => { throw new Error("当前扩展的自定义终端界面无法在 Chat 中显示"); },
			addAutocompleteProvider: () => undefined, setEditorComponent: () => undefined, getEditorComponent: () => undefined,
			theme, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: "Chat 外观由 VS Code 设置管理" }),
			getToolsExpanded: () => false, setToolsExpanded: () => undefined,
		};
	}

	get count(): number { return this.pending.size; }
	respond(response: RpcExtensionUIResponse): void { this.pending.get(response.id)?.resolve(response); }
	cancelAll(): void { for (const item of [...this.pending.values()]) item.cancel(); }
	private dialog(request: UiRequest, options?: { signal?: AbortSignal; timeout?: number }): Promise<RpcExtensionUIResponse> {
		const id = randomUUID();
		const cancelled: RpcExtensionUIResponse = { type: "extension_ui_response", id, cancelled: true };
		if (options?.signal?.aborted) return Promise.resolve(cancelled);
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const finish = (response: RpcExtensionUIResponse): void => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer); options?.signal?.removeEventListener("abort", cancel); this.changed(); resolve(response);
			};
			const cancel = (): void => finish(cancelled);
			this.pending.set(id, { resolve: finish, cancel });
			options?.signal?.addEventListener("abort", cancel, { once: true });
			if (options?.timeout) timer = setTimeout(cancel, options.timeout);
			this.changed(); this.send({ ...request, type: "extension_ui_request", id } as RpcExtensionUIRequest);
		});
	}
}
