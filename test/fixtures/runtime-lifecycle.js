import { appendFileSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export default async function (pi) {
    const directory = dirname(fileURLToPath(import.meta.url));
    const configuration = JSON.parse(readFileSync(join(directory, "runtime-fixture.json"), "utf8"));
    const watcher = watch(directory, () => {});
    watcher.unref();
    appendFileSync(configuration.log, "factory-created\n");
    pi.on("session_shutdown", async () => {
        if (configuration.shutdownDelayMs) await delay(configuration.shutdownDelayMs);
        if (configuration.shutdownRequiredFile) readFileSync(configuration.shutdownRequiredFile, "utf8");
        watcher.close();
        appendFileSync(configuration.log, "factory-closed\n");
    });
    if (configuration.delayMs) await delay(configuration.delayMs);
    if (configuration.requiredFile) readFileSync(configuration.requiredFile, "utf8");
    if (configuration.discoveredSkill) pi.on("resources_discover", () => ({ skillPaths: [configuration.discoveredSkill] }));
    if (configuration.inputDelayMs) pi.on("input", async () => {
        appendFileSync(configuration.log, "input-started\n");
        await delay(configuration.inputDelayMs);
        appendFileSync(configuration.log, "input-finished\n");
        return { action: "continue" };
    });
    pi.registerCommand("runtime-confirm", { description: "资源验证交互", handler: async (_args, ctx) => { await ctx.ui.confirm("资源验证", "确认继续", { timeout: configuration.confirmTimeoutMs }); } });
    pi.registerCommand("runtime-reload", { description: "资源验证重新加载", handler: async (_args, ctx) => { await ctx.reload(); } });
}
