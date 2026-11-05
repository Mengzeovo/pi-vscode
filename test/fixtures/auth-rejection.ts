import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "auth-rejection.json"), "utf8")) as {
		baseUrl: string; api: ProviderConfig["api"]; model: NonNullable<ProviderConfig["models"]>[number];
	};
	pi.registerProvider("auth-rejection", {
		name: "真实服务认证检查", baseUrl: config.baseUrl, api: config.api,
		apiKey: "pi-harness-intentionally-invalid-credential", models: [config.model],
	});
}
