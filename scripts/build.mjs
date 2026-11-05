import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLensRuntime } from "../compat/pi-lens/build.mjs";
import { buildTokenUsage } from "../compat/pi-token-usage/build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");

if (relative(root, dist) !== "dist") throw new Error("构建目录必须位于项目目录内");
rmSync(dist, { recursive: true, force: true });

// Pi 加载扩展时把这些包映射到自身的副本，随包扩展不能打包它们
const piProvided = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
];

function listTestEntries(dir) {
	const entries = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			// fixtures 中的文件由测试原样复制到测试工作区（例如 Pi 项目扩展），不参与构建
			if (name !== "fixtures") {
				entries.push(...listTestEntries(full));
			}
		} else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
			entries.push(full);
		}
	}
	return entries;
}

await build({
	entryPoints: [join(root, "src", "extension.ts")],
	outfile: join(dist, "extension.js"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node24",
	sourcemap: true,
	external: ["vscode", "koffi", "jiti"],
	jsxFactory: "vscpp",
	jsxFragment: "vscppf",
	logLevel: "warning",
});

await build({
	entryPoints: [join(root, "pi-extension", "index.ts")],
	outfile: join(dist, "pi-extension", "index.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: true,
	external: piProvided,
	logLevel: "warning",
});

for (const entry of ["backend", "guardian"]) {
	await build({
		entryPoints: [join(root, "src", entry, "index.ts")],
		outfile: join(dist, entry, "index.cjs"),
		bundle: true, platform: "node", format: "cjs", target: "node24", sourcemap: true,
		external: [...piProvided, "koffi", "jiti"], logLevel: "warning",
	});
}

cpSync(join(root, "compat"), join(dist, "compat"), { recursive: true });
await buildLensRuntime(join(dist, "compat", "pi-lens", "dist", "runtime.cjs"));
await buildTokenUsage(join(dist, "compat", "pi-token-usage", "dist", "index.js"));
if (!process.env.npm_execpath) throw new Error("请通过 npm run build 执行构建");
const dependencies = execFileSync(process.execPath, [process.env.npm_execpath, "ls", "--omit=dev", "--all", "--parseable"], {
	cwd: root, encoding: "utf8", windowsHide: true,
}).trim().split(/\r?\n/).slice(1);
for (const dependency of dependencies) {
	const packagePath = relative(root, dependency);
	if (!packagePath.startsWith(`node_modules${sep}`) || packagePath.split(sep).includes("..")) throw new Error(`依赖目录超出项目：${dependency}`);
	const destination = join(dist, packagePath);
	mkdirSync(resolve(destination, ".."), { recursive: true });
	cpSync(dependency, destination, { recursive: true });
}

const testRoot = join(root, "test");
const testEntries = listTestEntries(testRoot).filter((file) => relative(testRoot, file) !== "tsconfig.json");
await build({
	entryPoints: testEntries,
	outdir: join(dist, "test"),
	outbase: testRoot,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node24",
	sourcemap: true,
	external: ["vscode", "mocha", "@vscode/test-electron", "playwright-core", "koffi", "jiti", ...piProvided],
	logLevel: "warning",
});
