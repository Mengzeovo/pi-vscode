import { closeSync, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

const roots = new Map();
let cached;

export function refreshCachedRecords() {
    cached = undefined;
}

function absent(error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function signature(stat) {
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size].join(":");
}

function sessionRecords(content, projectDirectory, filename) {
    const result = [];
    const base = basename(filename, ".jsonl"), separator = base.indexOf("_");
    const sessionId = separator < 0 ? base : base.slice(separator + 1);
    let project = projectDirectory;
    for (const entry of parseSessionEntries(content)) {
        if (entry?.type === "session") {
            if (typeof entry.cwd === "string" && entry.cwd.length > 0) project = entry.cwd;
            continue;
        }
        const message = entry?.type === "message" ? entry.message : undefined;
        const usage = message?.role === "assistant" ? message.usage : undefined;
        if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") continue;
        const totalTokens = usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        result.push({
            timestamp: message.timestamp ?? new Date(entry.timestamp).getTime(),
            isoTimestamp: entry.timestamp, provider: message.provider ?? "unknown", model: message.model ?? "unknown", project, sessionId,
            input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
            totalTokens, costTotal: usage.cost?.total ?? 0,
        });
    }
    return result;
}

function readStableFile(file, projectDirectory, filename) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const descriptor = openSync(file, "r");
        try {
            const before = signature(fstatSync(descriptor, { bigint: true }));
            const content = readFileSync(descriptor, "utf8");
            const after = signature(fstatSync(descriptor, { bigint: true }));
            if (before === after) return { signature: after, records: sessionRecords(content, projectDirectory, filename) };
        } finally { closeSync(descriptor); }
    }
    throw new Error(`用量统计读取期间文件持续变化：${file}`);
}

export function scanAllSessions() {
    const agent = (process.env.PI_CODING_AGENT_DIR ?? "").trim() || join(homedir(), ".pi", "agent");
    const root = resolve(agent, "sessions");
    if (cached?.root === root) return cached.records;
    let files = roots.get(root);
    if (!files) { files = new Map(); roots.set(root, files); }
    let projects;
    try { projects = readdirSync(root); }
    catch (error) {
        if (!absent(error)) throw error;
        files.clear(); cached = { root, records: [] }; return cached.records;
    }
    const visited = new Set(), seen = new Set(), records = [];
    for (const project of projects) {
        const projectPath = join(root, project);
        let names;
        try {
            if (!statSync(projectPath).isDirectory()) continue;
            names = readdirSync(projectPath).filter(name => name.endsWith(".jsonl"));
        } catch (error) { if (absent(error)) continue; throw error; }
        for (const name of names) {
            const file = join(projectPath, name);
            try {
                const stat = statSync(file, { bigint: true });
                if (!stat.isFile()) continue;
                let value = files.get(file);
                if (!value || value.signature !== signature(stat)) {
                    value = readStableFile(file, project, name);
                    files.set(file, value);
                }
                visited.add(file);
                for (const record of value.records) {
                    const key = `${record.isoTimestamp}:${record.totalTokens}`;
                    if (seen.has(key)) continue;
                    seen.add(key); records.push(record);
                }
            } catch (error) { if (!absent(error)) throw error; }
        }
    }
    for (const file of files.keys()) if (!visited.has(file)) files.delete(file);
    records.sort((left, right) => left.timestamp - right.timestamp);
    cached = { root, records };
    return records;
}
