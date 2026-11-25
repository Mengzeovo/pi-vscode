import activateUpstream from "pi-token-usage-upstream/index.ts";
import { todayStart } from "pi-token-usage-upstream/dates.ts";
import { runWithScanWindow } from "./scan.js";

const harnessContextKey = Symbol.for("pi-harness.subagents.context");

function isCatalogOnly() {
    return Boolean(globalThis[harnessContextKey]?.storage?.getStore()?.catalogOnly);
}

export default function activateTokenUsage(pi) {
    if (isCatalogOnly()) return;
    const wrappedPi = new Proxy(pi, {
        get(target, property) {
            if (property === "on") {
                return (event, handler) => {
                    if ((event === "session_start" || event === "turn_end") && typeof handler === "function") {
                        return target.on(event, (payload, ctx) => runWithScanWindow(todayStart(), () => handler(payload, ctx)));
                    }
                    return target.on(event, handler);
                };
            }
            if (property === "registerCommand") {
                return (name, command) => {
                    if (name === "usage" && command && typeof command.handler === "function") {
                        const original = command.handler;
                        return target.registerCommand(name, {
                            ...command,
                            handler: (args, ctx) => {
                                const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
                                if (sub === "footer") return runWithScanWindow(todayStart(), () => original(args, ctx));
                                return runWithScanWindow(undefined, () => original(args, ctx));
                            },
                        });
                    }
                    return target.registerCommand(name, command);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return activateUpstream(wrappedPi);
}
