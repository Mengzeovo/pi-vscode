import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";

function key(path: string): string { const absolute = resolve(path); return process.platform === "win32" ? absolute.toLowerCase() : absolute; }

/** 从已有父目录监视目标，接收尚未创建的技能目录中的文件事件。 */
export function watchResource(path: string): FSWatcher {
	let root = resolve(path);
	while (!existsSync(root)) {
		const parent = dirname(root);
		if (parent === root) throw new Error(`Pi 资源目录没有可监视的父目录：${path}`);
		root = parent;
	}
	if (statSync(root).isFile()) root = dirname(root);
	const target = key(path);
	return watch(root, {
		persistent: false,
		ignoreInitial: true,
		ignored: (file, stats) => {
			const current = key(file);
			if (current !== target && !current.startsWith(`${target}${sep}`) && !target.startsWith(`${current}${sep}`)) return true;
			return stats?.isFile() === true && !current.endsWith(".md") && basename(current) !== "settings.json";
		},
	});
}
