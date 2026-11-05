import { readFileSync } from "node:fs";

export default function (pi) {
    const settings = JSON.parse(readFileSync(new URL("runtime-provider.json", import.meta.url), "utf8"));
    if (settings.enabled) pi.registerProvider("runtime-resources", settings.configuration);
}
