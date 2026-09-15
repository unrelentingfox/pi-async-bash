import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface AsyncBashSettings {
    "pi-async-bash"?: {
        defaultTimeoutSeconds?: unknown;
    };
}

export interface AsyncBashConfig {
    defaultTimeoutMs?: number;
}

export function loadConfig(
    cwd: string,
    projectTrusted: boolean,
    agentDir = getAgentDir(),
): AsyncBashConfig {
    const globalTimeout = readTimeout(join(agentDir, "settings.json"));
    const projectTimeout = projectTrusted
        ? readTimeout(join(cwd, CONFIG_DIR_NAME, "settings.json"))
        : undefined;

    return { defaultTimeoutMs: projectTimeout ?? globalTimeout };
}

function readTimeout(path: string): number | undefined {
    let settings: unknown;
    try {
        settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    if (typeof settings !== "object" || settings === null) return undefined;

    const asyncBashSettings = (settings as AsyncBashSettings)["pi-async-bash"];
    const seconds = asyncBashSettings?.defaultTimeoutSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
        return undefined;
    }
    return seconds * 1_000;
}
