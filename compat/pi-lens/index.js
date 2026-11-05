import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { currentHarnessScope, runHarnessScope, scopedExtensionApi } from "../pi-subagents/harness-context.js";

const instances = new Set();
const lifetimeKey = Symbol.for("pi-lens.safe-spawn.lifetime-state");
let compiled;
const normalized = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);

export default async function activate(pi) {
    const scope = currentHarnessScope();
    if (!scope) throw new Error("pi-lens 需要所属 Harness 会话上下文");
    const localRequire = createRequire(import.meta.url);
    const originalEntry = localRequire.resolve("pi-lens");
    const source = fileURLToPath(new URL("./dist/runtime.cjs", import.meta.url));
    compiled ??= readFile(source, "utf8").then((code) => compileFunction(code,
        ["exports", "require", "module", "__filename", "__dirname", "globalThis", "global", "process", "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "clearImmediate", "__harnessModuleUrl", "__harness"],
        { filename: originalEntry, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }));
    const execute = await compiled;
    const state = { cwd: scope.cwd, closing: false, closed: false, processValues: new Map(), listeners: new Set(), timers: new Set(), children: new Set(), workers: new Set(), tasks: new Set(), failures: [] };
    const cleanup = new AsyncLocalStorage();
    instances.add(state);
    const ownedPids = () => state.processValues.get(lifetimeKey)?.pids ?? new Set();
    const processProxy = new Proxy({}, {
        get(_target, property) {
            const target = process;
            if (property === "cwd") return () => state.cwd;
            if (property === "chdir") return () => { throw new Error("pi-lens 不允许更改共享后台目录"); };
            if (state.processValues.has(property)) return state.processValues.get(property);
            if (["on", "addListener", "prependListener", "once", "prependOnceListener"].includes(property)) return (event, listener) => {
                assertStarting();
                const item = { event, listener, wrapper: undefined };
                item.wrapper = (...args) => {
                    if (property === "once" || property === "prependOnceListener") state.listeners.delete(item);
                    return runHarnessScope(scope, () => listener.apply(processProxy, args));
                };
                state.listeners.add(item); target[property](event, item.wrapper); return processProxy;
            };
            if (property === "off" || property === "removeListener") return (event, listener) => {
                for (const item of state.listeners) if (item.event === event && (item.listener === listener || item.wrapper === listener)) { target.removeListener(event, item.wrapper); state.listeners.delete(item); }
                return processProxy;
            };
            if (property === "removeAllListeners") return (event) => {
                for (const item of state.listeners) if (event === undefined || item.event === event) { target.removeListener(item.event, item.wrapper); state.listeners.delete(item); }
                return processProxy;
            };
            if (property === "listeners" || property === "rawListeners") return (event) => [...state.listeners].filter((item) => item.event === event).map((item) => item.listener);
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
        set(_target, property, value) { state.processValues.set(property, value); return true; },
        defineProperty(target, property, descriptor) { if (!("value" in descriptor)) throw new Error("pi-lens process 属性必须提供具体值"); Object.defineProperty(target, property, descriptor); state.processValues.set(property, descriptor.value); return true; },
    });
    state.processValues.set("env", { ...process.env, ...scope.processEnv });
    const scopedConsole = Object.create(console);
    const globals = new Map([["process", processProxy], ["console", scopedConsole]]);
    const globalProxy = new Proxy({}, {
        get(_target, property) { return property === "globalThis" || property === "global" ? globalProxy : globals.has(property) ? globals.get(property) : Reflect.get(globalThis, property, globalThis); },
        set(_target, property, value) { globals.set(property, value); return true; },
        defineProperty(target, property, descriptor) { if (!("value" in descriptor)) throw new Error("pi-lens 全局属性必须提供具体值"); Object.defineProperty(target, property, descriptor); globals.set(property, descriptor.value); return true; },
        has(_target, property) { return globals.has(property) || Reflect.has(globalThis, property); },
        deleteProperty(target, property) { if (!Reflect.deleteProperty(target, property)) return false; return globals.delete(property); },
    });
    const schedule = (repeat) => (callback, milliseconds, ...args) => {
        assertStarting();
        const timer = (repeat ? setInterval : setTimeout)(() => { if (!repeat) state.timers.delete(timer); runHarnessScope(scope, () => callback(...args)); }, milliseconds);
        state.timers.add(timer); return timer;
    };
    const clear = (timer) => { clearTimeout(timer); clearInterval(timer); clearImmediate(timer); state.timers.delete(timer); };
    const immediate = (callback, ...args) => {
        assertStarting();
        const timer = setImmediate(() => { state.timers.delete(timer); runHarnessScope(scope, () => callback(...args)); });
        state.timers.add(timer); return timer;
    };
    const timers = { setTimeout: schedule(false), setInterval: schedule(true), clearTimeout: clear, clearInterval: clear, setImmediate: immediate, clearImmediate: clear };
    const assertStarting = () => { if (state.closed || state.closing && !cleanup.getStore()) throw new Error("pi-lens 所属会话正在关闭，不能创建新的后台工作"); };
    const runOwned = (action) => {
        assertStarting();
        const pending = Promise.resolve().then(action);
        state.tasks.add(pending);
        void pending.then(() => state.tasks.delete(pending), () => state.tasks.delete(pending));
        return pending;
    };
    const drainTasks = async () => { while (state.tasks.size) await Promise.all([...state.tasks]); };
    const childModule = localRequire("node:child_process");
    const childProcesses = { ...childModule };
    for (const method of ["spawn", "exec", "execFile", "fork"]) childProcesses[method] = (...args) => {
        assertStarting();
        const child = childModule[method](...args);
        const item = { child, closed: undefined };
        item.closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
        state.children.add(item);
        void item.closed.then(() => state.children.delete(item));
        return child;
    };
    for (const method of ["spawnSync", "execSync", "execFileSync"]) childProcesses[method] = (...args) => { assertStarting(); return childModule[method](...args); };
    const workerModule = localRequire("node:worker_threads");
    class OwnedWorker extends workerModule.Worker {
        constructor(...args) { assertStarting(); super(...args); state.workers.add(this); this.once("exit", () => state.workers.delete(this)); }
    }
    const sdk = await scope.loadPiCodingAgent();
    const makeRequire = (base) => {
        const realRequire = createRequire(base);
        const requireModule = (specifier) => {
            if (specifier === "@earendil-works/pi-coding-agent") return sdk;
            if (specifier === "node:process" || specifier === "process") return processProxy;
            if (specifier === "node:console" || specifier === "console") return scopedConsole;
            if (specifier === "node:child_process" || specifier === "child_process") return childProcesses;
            if (specifier === "node:worker_threads" || specifier === "worker_threads") return { ...workerModule, Worker: OwnedWorker };
            if (specifier === "node:timers" || specifier === "timers") return { ...realRequire(specifier), ...timers };
            if (specifier === "node:module" || specifier === "module") return { ...realRequire(specifier), createRequire: makeRequire };
            return realRequire(specifier);
        };
        Object.assign(requireModule, realRequire);
        return requireModule;
    };
    const requireModule = makeRequire(originalEntry);
    const module = { exports: {} };
    const releaseRegistration = (file, matches) => {
        const retainedRoots = new Set([...instances].filter((item) => item !== state && !item.closing).map((item) => normalized(item.cwd)));
        const entries = [];
        for (const entry of file.instances) {
            if (!matches(entry)) { entries.push(entry); continue; }
            const roots = (entry.projectRoots ?? [entry.projectRoot]).filter((root) => retainedRoots.has(normalized(root)));
            if (!roots.length) continue;
            const holders = Object.fromEntries(Object.entries(entry.projectRootHolders ?? {}).map(([holder, paths]) => [holder, paths.filter((path) => retainedRoots.has(normalized(path)))]).filter(([, paths]) => paths.length));
            const children = (entry.lspChildren ?? []).filter((child) => !ownedPids().has(child.pid));
            entries.push({ ...entry, projectRoot: roots[0], projectRoots: roots, projectRootHolders: holders, lspChildren: children, lspChildCount: children.length });
        }
        return { ...file, instances: entries };
    };
    let beforeClose, finalize;
    execute(module.exports, requireModule, module, originalEntry, dirname(originalEntry), globalProxy, globalProxy, processProxy, scopedConsole,
        timers.setTimeout, timers.setInterval, timers.clearTimeout, timers.clearInterval, timers.setImmediate, timers.clearImmediate, pathToFileURL(originalEntry).href,
        { releaseRegistration, runOwned, runCleanup: (action) => cleanup.run(true, action), loadSdk: () => scope.loadPiCodingAgent(), recordFailure: (error) => state.failures.push(error), setBeforeClose: (action) => { beforeClose = action; }, setFinalizer: (action) => { finalize = action; } });
    const shutdown = [];
    const scopedApi = scopedExtensionApi(pi, scope);
    const api = new Proxy(scopedApi, { get(target, property) {
        if (property === "on") return (event, handler) => {
            if (event === "session_shutdown") shutdown.push(handler);
            else target.on(event, event === "session_start" ? (input, ctx) => { state.cwd = ctx.cwd; return handler(input, ctx); } : handler);
        };
        return Reflect.get(target, property);
    } });
    pi.on("session_shutdown", async (event, ctx) => {
        await runHarnessScope(scope, () => beforeClose?.());
        await drainTasks();
        state.closing = true;
        await cleanup.run(true, () => runHarnessScope(scope, async () => {
            for (const handler of shutdown) await handler(event, ctx);
            await drainTasks();
            await Promise.all([...state.workers].map((worker) => worker.terminate()));
            while (state.children.size) await Promise.all([...state.children].map((item) => item.closed));
            await drainTasks();
            await finalize?.();
            if (state.failures.length) throw new AggregateError(state.failures, `pi-lens 所属资源保存失败：${state.failures.map((error) => error instanceof Error ? error.message : String(error)).join("；")}`);
        }));
        state.closed = true;
        for (const timer of state.timers) clear(timer);
        for (const item of state.listeners) process.removeListener(item.event, item.wrapper);
        state.listeners.clear(); instances.delete(state);
    });
    await runHarnessScope(scope, () => module.exports.default(api));
}
