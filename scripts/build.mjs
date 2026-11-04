import { build } from "esbuild";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

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
	external: ["vscode"],
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
	target: "node22",
	sourcemap: true,
	external: piProvided,
	logLevel: "warning",
});

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
	external: ["vscode", "mocha", "@vscode/test-electron", "playwright-core"],
	logLevel: "warning",
});
