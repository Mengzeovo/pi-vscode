import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	const marker = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "crash-once.marker");
	if (existsSync(marker)) {
		unlinkSync(marker);
		process.exit(9);
	}
}
