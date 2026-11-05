import { transform } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildLensRuntime(output) {
    const source = fileURLToPath(new URL("./runtime-source.js", import.meta.url));
    const result = await transform(await readFile(source, "utf8"), { format: "cjs", target: "node24", sourcefile: source,
        define: { "import.meta.url": "__harnessModuleUrl" }, sourcemap: "inline" });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, result.code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildLensRuntime(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "dist", "runtime.cjs"));
