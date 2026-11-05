import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { createHarnessScope, runHarnessScope, removeHarnessScope, stopHarnessTasks } from "./harness-context.js";
import { createPlacementChildSessionFactory } from "./src/runs/shared/child-session.js";

export async function createHarnessRunnerFactory(config, options) {
    if (!config.identity?.rootRequestId || !config.bridge?.token) throw new Error("后台子任务缺少编辑器授权身份");
    const requireSdk = createRequire(join(config.packageDir, "package.json"));
    const sdk = await import(pathToFileURL(join(config.packageDir, "dist", "index.js")).href);
    const importer = createJiti(config.piExtensionPath, { fsCache: false, alias: {
        "@earendil-works/pi-coding-agent": join(config.packageDir, "dist", "index.js"), typebox: requireSdk.resolve("typebox"),
    } });
    const { createHarnessExtension } = await importer.import(config.piExtensionPath);
    const mapSource = (source) => {
        for (const [name, directory] of [["pi-subagents", "pi-subagents"], ["@router-for-me/pi-cliproxyapi-provider", "pi-cliproxyapi-provider"]]) {
            if (source === `npm:${name}` || source.startsWith(`npm:${name}@`)) return join(config.compatRoot, directory);
            const normalized = source.replaceAll("\\", "/");
            const marker = `/node_modules/${name}`;
            const index = normalized.indexOf(marker);
			if (index >= 0 && (normalized.length === index + marker.length || normalized[index + marker.length] === "/")) return join(config.compatRoot, directory, normalized.slice(index + marker.length));
        }
        return source;
    };
    const scope = createHarnessScope({ sessionId: config.identity.sessionId, cwd: config.cwd, agentDir: config.agentDir, child: true, mapSource, commitIdentity: config.identity, identity: () => config.identity,
        loadPiCodingAgent: async () => sdk,
        resourceSettings: (original) => sdk.SettingsManager.fromStorage({ withLock(area, action) {
            const settings = area === "global" ? original.getGlobalSettings() : original.getProjectSettings();
            action(JSON.stringify({ ...settings, packages: settings.packages?.map((entry) => typeof entry === "string" ? mapSource(entry) : { ...entry, source: mapSource(entry.source) }), extensions: settings.extensions?.map(mapSource) }));
        } }, { projectTrusted: original.isProjectTrusted() }),
        prepareChild: async (launch) => ({ ...launch, harnessIdentity: config.identity, requiredExtensions: launch.requiredExtensions?.map((entry) => ({ ...entry, path: mapSource(entry.path) })),
            harnessExtensionFactories: [createHarnessExtension({ cwd: launch.cwd, role: "child", identity: () => config.identity, ipcPath: config.bridge.path, ipcToken: config.bridge.token })] }),
        runnerConfig: () => config,
    });
    const factory = createPlacementChildSessionFactory({ ...options, loadPiCodingAgent: async () => sdk });
    return {
        create: (launch) => runHarnessScope(scope, () => factory.create(launch)),
        dispose: async () => { await stopHarnessTasks(scope); await runHarnessScope(scope, () => factory.dispose()); removeHarnessScope(scope); },
    };
}
