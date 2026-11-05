import { dirname, join, resolve } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CommitIdentity, CopilotToolDeclaration, EditEntryData } from "../../shared/protocol";
import type { MessageConnection } from "vscode-jsonrpc";
import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { Minimatch } from "minimatch";
import type { BackendInitializeParams, BackendOpenParams, BackendSkill } from "./protocol";

export type PiSdk = typeof Pi;
type Settings = ReturnType<SettingsManager["getSettings"]>;
export interface McpServerState {
	name: string; enabled: boolean; attempt: number; attemptComplete: boolean;
	state: "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
	toolsRegistered: boolean; error?: string;
}
export interface McpState {
	sessionId: string; runtimeGeneration: number; configurationLoaded: boolean;
	configurationErrors: string[]; closeComplete: boolean; servers: McpServerState[];
}
export interface HarnessScope {
	sessionId: string; cwd: string; blocked: boolean; state?: unknown;
	children: Set<{ abort(): Promise<void>; dispose(): Promise<void> }>;
	starting: Set<Promise<unknown>>;
	states: Set<unknown>;
	[key: string]: unknown;
}
export interface HarnessCompat {
	createHarnessScope(options: Record<string, unknown>): HarnessScope;
	currentHarnessScope(): HarnessScope | undefined;
	runHarnessScope<T>(scope: HarnessScope, action: () => T): T;
	removeHarnessScope(scope: HarnessScope): void;
	getHarnessTaskCount(scope: HarnessScope): number;
	stopHarnessTasks(scope: HarnessScope): Promise<void>;
}
interface McpCompat {
	configureMcpDependencies(packageDir: string): Promise<void>;
	createMcpExtension(options: { sessionId: string; runtimeGeneration: number; agentDir?: string; onState(state: McpState): void }): ExtensionFactory;
}
interface HarnessExtensionModule {
	createHarnessExtension(options: { cwd: string; role?: "root" | "child"; identity: () => CommitIdentity; connection: MessageConnection; copilotTools: readonly CopilotToolDeclaration[]; onEdit?: (data: EditEntryData, identity: CommitIdentity) => void }): ExtensionFactory;
}

export class OperationSequence {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.tail.then(action);
		this.tail = pending.then(() => undefined, () => undefined);
		return pending;
	}
}

export class ResourceFactory {
	readonly sequence = new OperationSequence();
	readonly imports = new OperationSequence();
	private constructor(readonly sdk: PiSdk, readonly options: BackendInitializeParams, readonly compat: HarnessCompat, readonly mcp: McpCompat, readonly bridge: HarnessExtensionModule,
		readonly thinkingLevels: (model: NonNullable<Pi.RpcSessionState["model"]>) => Pi.RpcSessionState["thinkingLevel"][], readonly paths: { isLocalPath(value: string): boolean; resolvePath(value: string, base?: string): string }) {}
	static async load(options: BackendInitializeParams): Promise<ResourceFactory> {
		const sdk = await import(pathToFileURL(join(options.packageDir, "dist", "index.js")).href) as PiSdk;
		const compat = await import(pathToFileURL(join(options.compatRoot, "pi-subagents", "harness-context.js")).href) as HarnessCompat;
		const mcp = await import(pathToFileURL(join(options.compatRoot, "pi-mcp", "index.js")).href) as McpCompat;
		const sdkRequire = createRequire(join(options.packageDir, "package.json"));
		const importer = createJiti(options.piExtensionPath, { fsCache: false, alias: {
			"@earendil-works/pi-coding-agent": join(options.packageDir, "dist", "index.js"),
			typebox: sdkRequire.resolve("typebox"),
		} });
		const bridge = await importer.import(options.piExtensionPath) as HarnessExtensionModule;
		const aiManifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(options.packageDir, "dist", "index.js")));
		if (!aiManifest) throw new Error("Pi SDK 的模型依赖不存在");
		const models = await import(pathToFileURL(join(dirname(aiManifest), "dist", "models.js")).href) as { getSupportedThinkingLevels: ResourceFactory["thinkingLevels"] };
		const paths = await import(pathToFileURL(join(options.packageDir, "dist", "utils", "paths.js")).href) as ResourceFactory["paths"];
		await mcp.configureMcpDependencies(options.packageDir);
		return new ResourceFactory(sdk, options, compat, mcp, bridge, models.getSupportedThinkingLevels, paths);
	}

	mapSource = (source: string): string => {
		const excluded = source.startsWith("!");
		const plain = excluded ? source.slice(1) : source;
		const normalized = plain.replaceAll("\\", "/");
		let target: string | undefined;
		for (const [name, directory] of [["pi-subagents", "pi-subagents"], ["@router-for-me/pi-cliproxyapi-provider", "pi-cliproxyapi-provider"], ["pi-lens", "pi-lens"], ["pi-token-usage", "pi-token-usage"]] as const) {
			if (plain === `npm:${name}` || plain.startsWith(`npm:${name}@`)) target = join(this.options.compatRoot, directory);
			const suffix = `/node_modules/${name}`;
			const index = normalized.indexOf(suffix);
			if (index >= 0 && (normalized.length === index + suffix.length || normalized[index + suffix.length] === "/")) {
				const relative = normalized.slice(index + suffix.length);
				target = join(this.options.compatRoot, directory, name === "pi-lens" && relative === "/dist/index.js" ? "index.js"
					: name === "pi-token-usage" && ["/src/index.ts", "/dist/index.js", "/index.ts"].includes(relative) ? "dist/index.js" : relative);
			}
		}
		return target ? `${excluded ? "!" : ""}${target}` : source;
	};

	resourceSettings(original: SettingsManager): SettingsManager {
		const mapSettings = (settings: Settings): Settings => ({ ...settings,
			packages: settings.packages?.map((entry) => typeof entry === "string" ? this.mapSource(entry) : { ...entry, source: this.mapSource(entry.source) }),
			extensions: settings.extensions?.map(this.mapSource),
		});
		return this.sdk.SettingsManager.fromStorage({ withLock: (scope, action) => {
			action(JSON.stringify(mapSettings(scope === "global" ? original.getGlobalSettings() : original.getProjectSettings())));
		} }, { projectTrusted: original.isProjectTrusted() });
	}

	create(options: BackendOpenParams, connection: MessageConnection | undefined, copilotTools: readonly CopilotToolDeclaration[], identity: () => CommitIdentity, onMcp: (state: McpState) => void, onEdit?: (data: EditEntryData, identity: CommitIdentity) => void): SessionResources {
		return new SessionResources(this, options, connection, copilotTools, identity, onMcp, onEdit);
	}
}

export class SessionResources {
	readonly original: SettingsManager;
	readonly view: SettingsManager;
	readonly scope: HarnessScope;
	private raw: Pi.DefaultResourceLoader | undefined;
	private readonly wrapper: ResourceLoader;
	private generation = 0;
	private services: Pi.AgentSessionServices | undefined;
	private resourceLoadStarted = false;
	private discovered: { kind: string; path: string }[] = [];
	initializationUnconfirmed = false;
	mcpState: McpState | undefined;

	constructor(readonly factory: ResourceFactory, readonly options: BackendOpenParams, connection: MessageConnection | undefined, copilotTools: readonly CopilotToolDeclaration[], identity: () => CommitIdentity, onMcp: (state: McpState) => void, onEdit?: (data: EditEntryData, identity: CommitIdentity) => void) {
		this.original = factory.sdk.SettingsManager.create(options.cwd, factory.options.agentDir, { projectTrusted: options.projectTrusted });
		this.view = factory.resourceSettings(this.original);
		const childIdentity = (): CommitIdentity => ({ ...(factory.compat.currentHarnessScope()?.commitIdentity as CommitIdentity | undefined) ?? identity() });
		this.scope = factory.compat.createHarnessScope({ sessionId: options.sessionId, cwd: options.cwd, agentDir: factory.options.agentDir,
			identity,
			loadPiCodingAgent: async () => factory.sdk,
			runResourceLoad: <T>(action: () => Promise<T>) => factory.imports.run(action),
			runnerConfig: () => ({ identity: childIdentity(), bridge: options.bridge, cwd: options.cwd, agentDir: factory.options.agentDir, packageDir: factory.options.packageDir, compatRoot: factory.options.compatRoot, piExtensionPath: factory.options.piExtensionPath }),
			mapSource: factory.mapSource, resourceSettings: (original: SettingsManager) => factory.resourceSettings(original),
			prepareChild: async (launch: { requiredExtensions?: { path: string }[]; harnessExtensionFactories?: ExtensionFactory[]; [key: string]: unknown }) => {
				if (!connection) throw new Error("目录查询会话不能创建子任务");
				const captured = childIdentity();
				return { ...launch, harnessIdentity: captured, requiredExtensions: launch.requiredExtensions?.map((entry) => ({ ...entry, path: factory.mapSource(entry.path) })),
					harnessExtensionFactories: [factory.bridge.createHarnessExtension({ cwd: String(launch.cwd), role: "child", identity: () => captured, connection, copilotTools, onEdit })] };
			},
		});
		const raw = (): Pi.DefaultResourceLoader => { if (!this.raw) throw new Error("资源尚未完成初始化"); return this.raw; };
		this.wrapper = {
			getExtensions: () => raw().getExtensions(), getSkills: () => raw().getSkills(), getPrompts: () => raw().getPrompts(), getThemes: () => raw().getThemes(),
			getAgentsFiles: () => raw().getAgentsFiles(), getSystemPrompt: () => raw().getSystemPrompt(), getSystemPromptSource: () => raw().getSystemPromptSource(),
			getAppendSystemPrompt: () => raw().getAppendSystemPrompt(), getAppendSystemPromptSources: () => raw().getAppendSystemPromptSources(),
			extendResources: (paths) => {
				for (const kind of ["skillPaths", "promptPaths", "themePaths"] as const) {
					for (const entry of paths[kind] ?? []) this.discovered.push({ kind, path: factory.paths.resolvePath(entry.path, options.cwd) });
				}
				raw().extendResources(paths);
			}, reload: (reloadOptions) => factory.imports.run(async () => {
				await this.original.reload();
				const errors = this.original.drainErrors();
				if (errors.length) throw new Error(errors.map((item) => `${item.path ?? item.scope}: ${item.error.message}`).join("\n"));
				await this.view.reload(); this.view.setProjectTrusted(this.original.isProjectTrusted());
				this.resourceLoadStarted = true; this.initializationUnconfirmed = true;
				await raw().reload(reloadOptions);
			}),
		};
		this.factories = [
			{ name: "codemode", replaceable: true, factory: factory.sdk.createCodemodeExtension() },
			{ name: "tool-search", replaceable: true, factory: factory.sdk.createToolSearchExtension() },
			{ name: "mcp", factory: (api) => factory.mcp.createMcpExtension({ sessionId: options.sessionId, runtimeGeneration: this.generation, agentDir: factory.options.agentDir, onState: (state) => { if (state.runtimeGeneration !== this.generation) return; this.mcpState = state; onMcp(state); } })(api) },
			...(connection ? [{ name: "pi-harness", factory: factory.bridge.createHarnessExtension({ cwd: options.cwd, identity, connection, copilotTools, onEdit }) }] : []),
		];
	}
	private readonly factories: Pi.InlineExtension[];

	async load(generation: number, flags?: ReadonlyMap<string, boolean | string>): Promise<Pi.AgentSessionServices> {
		this.generation = generation;
		this.scope.blocked = false;
		this.scope.states.clear();
		this.discovered = [];
		this.mcpState = undefined;
		return this.factory.compat.runHarnessScope(this.scope, async () => {
			this.initializationUnconfirmed = false; this.resourceLoadStarted = false;
			if (!this.raw) {
				this.raw = new this.factory.sdk.DefaultResourceLoader({ cwd: this.options.cwd, agentDir: this.factory.options.agentDir ?? this.factory.sdk.getAgentDir(), settingsManager: this.view, extensionFactories: this.factories });
			}
			const agentDir = this.factory.options.agentDir ?? this.factory.sdk.getAgentDir();
			const modelRuntime = await this.factory.sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
			this.services = { cwd: this.options.cwd, agentDir, settingsManager: this.original, resourceLoader: this.wrapper, modelRuntime, diagnostics: [] };
			await this.wrapper.reload();
			this.initializationUnconfirmed = this.raw.getExtensions().errors.length > 0;
			const runtime = this.raw.getExtensions().runtime;
			const declarations = new Map(this.raw.getExtensions().extensions.flatMap((extension) => [...extension.flags]));
			for (const [name, value] of flags ?? []) {
				const declaration = declarations.get(name);
				if (!declaration || typeof value !== declaration.type) throw new Error(`扩展参数已经不可用或类型不匹配：${name}`);
				runtime.flagValues.set(name, value);
			}
			for (const item of runtime.pendingProviderRegistrations) modelRuntime.registerProvider(item.name, item.config);
			for (const item of runtime.pendingNativeProviderRegistrations) modelRuntime.registerNativeProvider(item.provider);
			for (const item of runtime.pendingVirtualModelRegistrations) modelRuntime.registerVirtualModel(item.definition);
			runtime.pendingProviderRegistrations = []; runtime.pendingNativeProviderRegistrations = []; runtime.pendingVirtualModelRegistrations = [];
			await modelRuntime.refresh({ allowNetwork: false });
			return this.services;
		});
	}

	getServicesForCleanup(): Pi.AgentSessionServices | undefined { return this.resourceLoadStarted ? this.services : undefined; }

	checkDiagnostics(): void {
		const loader = this.raw;
		if (!loader) throw new Error("资源尚未完成加载");
		const errors = [
			...this.discovered.filter((item) => !existsSync(item.path)).map((item) => `${item.kind}: 扩展要求的资源路径不存在：${item.path}`),
			...loader.getExtensions().errors.map((item) => `${item.path}: ${item.error}`),
			...(this.services?.diagnostics ?? []).filter((item) => item.type === "error").map((item) => item.message),
			...[
				{ diagnostics: loader.getSkills().diagnostics, paths: loader.getSkills().skills.map((item) => item.filePath) },
				{ diagnostics: loader.getPrompts().diagnostics, paths: loader.getPrompts().prompts.map((item) => item.filePath) },
				{ diagnostics: loader.getThemes().diagnostics, paths: loader.getThemes().themes.map((item) => item.sourcePath).filter((item): item is string => item !== undefined) },
			].flatMap(({ diagnostics, paths }) => {
				const loaded = new Set(paths.map((path) => resolve(path)));
				return diagnostics.filter((item) => item.type === "error" || (item.type === "warning" && (!item.path || !loaded.has(resolve(item.path))))).map((item) => `${item.path ?? "资源"}: ${item.message}`);
			}),
		];
		for (const [settings, base] of [[this.view.getGlobalSettings(), this.factory.options.agentDir ?? this.factory.sdk.getAgentDir()], [this.view.getProjectSettings(), join(this.options.cwd, ".pi")]] as const) {
			for (const type of ["extensions", "skills", "prompts", "themes"] as const) {
				for (const value of settings[type] ?? []) {
					if (/^[!+\-]/.test(value) || new Minimatch(value, { windowsPathsNoEscape: true }).hasMagic() || !this.factory.paths.isLocalPath(value)) continue;
					const path = this.factory.paths.resolvePath(value, base);
					if (!existsSync(path)) errors.push(`${type}: 配置要求的资源路径不存在：${path}`);
				}
			}
		}
		if (errors.length) throw new Error(errors.join("\n"));
	}

	checkMcp(): boolean {
		const state = this.mcpState;
		if (!state?.configurationLoaded) return false;
		if (state.configurationErrors.length) throw new Error(`MCP 配置错误：${state.configurationErrors.join("；")}`);
		for (const server of state.servers.filter((item) => item.enabled)) {
			if (server.error || ["failed", "disconnected", "needs-auth", "closed"].includes(server.state)) throw new Error(`MCP ${server.name}：${server.state === "needs-auth" ? "需要登录" : server.error ?? server.state}`);
			if (!server.attemptComplete || server.state !== "connected" || !server.toolsRegistered) return false;
		}
		return true;
	}

	skills(): BackendSkill[] {
		return this.raw?.getSkills().skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: resolve(skill.filePath), source: skill.sourceInfo.scope, disableModelInvocation: skill.disableModelInvocation })) ?? [];
	}
}
