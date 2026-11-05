import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function normalizedFilePath(path: string): string {
	const absolute = resolve(path);
	let canonical: string;
	if (existsSync(absolute)) {
		canonical = realpathSync.native(absolute);
	} else {
		let parent = dirname(absolute);
		while (!existsSync(parent)) {
			const next = dirname(parent);
			if (next === parent) throw new Error(`无法确定文件的真实目录：${path}`);
			parent = next;
		}
		canonical = join(realpathSync.native(parent), absolute.slice(parent.length));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

const pending = new Map<string, Promise<void>>();

export async function serializeFile<T>(path: string, action: () => Promise<T>): Promise<T> {
	const key = normalizedFilePath(path);
	const previous = pending.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	pending.set(key, current);
	await previous;
	try { return await action(); } finally {
		release();
		if (pending.get(key) === current) pending.delete(key);
	}
}
