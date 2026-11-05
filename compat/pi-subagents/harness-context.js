import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

const key = Symbol.for("pi-harness.subagents.context");
const context = globalThis[key] ??= { storage: new AsyncLocalStorage(), sessions: new Map() };

export function createHarnessScope(options) {
    const scope = { ...options, activeFactory: undefined, activeFactoryModule: undefined,
        mainThinkingLevelSource: () => undefined, liveSnapshots: new Map(), finalSnapshots: new Map(),
        starting: new Set(), children: new Set(), states: new Set(), blocked: false, state: undefined };
    scope.failCleanup = (error) => { scope.cleanupUnconfirmed = error; };
    context.sessions.set(options.sessionId, scope);
    return scope;
}

export function currentHarnessScope() { return context.storage.getStore(); }
export function runHarnessScope(scope, action) { return context.storage.run(scope, action); }
function captureScope(scope) {
    const identity = scope.commitIdentity ?? scope.identity?.();
    if (!identity) return scope;
    const captured = { ...identity };
    return new Proxy(scope, { get(target, property, receiver) { return property === "commitIdentity" ? captured : Reflect.get(target, property, receiver); } });
}
export function trackHarnessStart(action) {
    const scope = currentHarnessScope();
    if (!scope) return action();
    if (scope.blocked) throw new Error("所属会话已暂停创建子任务");
    const captured = captureScope(scope);
    const pending = Promise.resolve().then(() => {
        if (scope.blocked) throw new Error("所属会话已暂停创建子任务");
        return runHarnessScope(captured, action);
    });
    scope.starting.add(pending);
    void pending.then(() => scope.starting.delete(pending), () => scope.starting.delete(pending));
    return pending;
}
export function getHarnessScope(sessionId) { return context.sessions.get(sessionId); }
export function removeHarnessScope(scope) {
    if (context.sessions.get(scope.sessionId) === scope) context.sessions.delete(scope.sessionId);
}

export function getHarnessTaskCount(scope) {
    const states = new Set([...scope.states, ...scope.state ? [scope.state] : []]);
    let count = scope.children.size + scope.starting.size + (scope.cleanupUnconfirmed ? 1 : 0);
    for (const state of states) count += [...state.asyncJobs.values()].filter((job) => ["running", "queued"].includes(job.status)).length + (state.foregroundControls?.size ?? 0);
    return count;
}

export async function stopHarnessTasks(scope) {
    scope.blocked = true;
    if (scope.cleanupUnconfirmed) throw new Error(scope.cleanupUnconfirmed);
    const [{ stopAsyncRun }, { readStatus }, { readProcessTerminal }] = await Promise.all([
        import("./src/runs/foreground/async-stop-action.js"), import("./src/shared/utils.js"),
        import("./src/runs/background/process-terminal.js"),
    ]);
    const states = () => new Set([...scope.states, ...scope.state ? [scope.state] : []]);
    for (const state of states()) {
        for (const control of state.foregroundControls.values()) control.stopForRuntimeReplacement?.();
        for (const controller of state.workflowControllers?.values() ?? []) controller.abort(new Error("所属会话已请求停止"));
    }
    while (scope.starting.size) await Promise.allSettled([...scope.starting]);
    if (scope.cleanupUnconfirmed) throw new Error(scope.cleanupUnconfirmed);
    const jobs = [...states()].flatMap((state) => [...state.asyncJobs.values()].filter((job) => ["running", "queued", "paused"].includes(job.status)).map((job) => ({ state, job })));
    for (const { state, job } of jobs) {
        const result = stopAsyncRun(state, job.asyncId, process.kill.bind(process));
        if (result?.isError) throw new Error(result.content.map((item) => item.text ?? "").join("\n"));
    }
    await Promise.all([...scope.children].map(async (child) => { await child.abort(); await child.dispose(); }));
    for (const { state, job } of jobs) {
        for (;;) {
            const status = readStatus(job.asyncDir);
            if (!status) throw new Error(`子任务 ${job.asyncId} 的状态文件不可读取`);
            const instance = status.processTerminal?.runnerProcessInstanceId;
            if (instance) {
                const proof = readProcessTerminal(job.asyncDir, { runId: status.runId, runnerProcessInstanceId: instance });
                if (proof?.state === "observed" || proof?.state === "not-started") break;
                if (proof?.state === "unknown") throw new Error(`子任务 ${job.asyncId} 的退出状态无法确认：${proof.reason}`);
            } else if (state.workflowControllers?.has(job.asyncId) !== true && ["completed", "complete", "stopped", "failed"].includes(status.state)) {
                break;
            }
            await delay(50);
        }
    }
}

export function scopedExtensionApi(api, scope) {
    if (!scope) return api;
    const wrap = (fn) => (...args) => runHarnessScope(scope, () => fn(...args));
    return new Proxy(api, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === "on") return (event, handler) => target.on(event, wrap(handler));
            if (property === "registerTool") return (tool) => target.registerTool({ ...tool,
                execute: (...args) => runHarnessScope(captureScope(scope), () => tool.execute(...args)),
                ...(tool.renderCall ? { renderCall: wrap(tool.renderCall) } : {}),
                ...(tool.renderResult ? { renderResult: wrap(tool.renderResult) } : {}),
            });
            if (property === "registerCommand") return (name, command) => target.registerCommand(name, { ...command, handler: wrap(command.handler) });
            if (property === "registerMessageRenderer") return (name, renderer) => target.registerMessageRenderer(name, wrap(renderer));
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
