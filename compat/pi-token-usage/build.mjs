import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildTokenUsage(output, packageDirectory) {
    const directory = packageDirectory ?? dirname(createRequire(import.meta.url).resolve("pi-token-usage/package.json"));
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (metadata.name !== "pi-token-usage" || metadata.version !== "0.2.1") throw new Error("用量统计兼容包要求 pi-token-usage 0.2.1");
    const sourceDirectory = resolve(directory, "src");
    await build({ entryPoints: [join(sourceDirectory, "index.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node24",
        external: ["@earendil-works/pi-coding-agent"], sourcemap: true,
        plugins: [{ name: "harness-usage-scan", setup(builder) {
            builder.onResolve({ filter: /^\.\/scan$/ }, args => {
                if (resolve(args.resolveDir) !== sourceDirectory) throw new Error(`未知用量统计来源：${args.importer}`);
                return { path: fileURLToPath(new URL("./scan.js", import.meta.url)) };
            });
        } }],
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildTokenUsage(process.argv[2] ?? fileURLToPath(new URL("./dist/index.js", import.meta.url)), process.argv[3]);
