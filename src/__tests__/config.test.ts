import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-async-bash-config-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const configDir = ".pi";

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}

void describe("default timeout settings", () => {
    after(() => rmSync(root, { recursive: true, force: true }));

    it("uses the global setting", () => {
        writeJson(join(agentDir, "settings.json"), {
            "pi-async-bash": { defaultTimeoutSeconds: 5 },
        });

        assert.equal(loadConfig(projectDir, false, agentDir).defaultTimeoutMs, 5_000);
    });

    it("uses a trusted project override", () => {
        writeJson(join(projectDir, configDir, "settings.json"), {
            "pi-async-bash": { defaultTimeoutSeconds: 3 },
        });

        assert.equal(loadConfig(projectDir, true, agentDir).defaultTimeoutMs, 3_000);
    });

    it("ignores a project override when the project is untrusted", () => {
        assert.equal(loadConfig(projectDir, false, agentDir).defaultTimeoutMs, 5_000);
    });

    it("ignores missing, malformed, and invalid settings", () => {
        const invalidAgentDir = join(root, "invalid-agent");
        writeJson(join(invalidAgentDir, "settings.json"), {
            "pi-async-bash": { defaultTimeoutSeconds: 0 },
        });
        assert.equal(loadConfig(projectDir, false, invalidAgentDir).defaultTimeoutMs, undefined);

        writeJson(join(invalidAgentDir, "settings.json"), null);
        assert.equal(loadConfig(projectDir, false, invalidAgentDir).defaultTimeoutMs, undefined);

        writeFileSync(join(invalidAgentDir, "settings.json"), "not json");
        assert.equal(loadConfig(projectDir, false, invalidAgentDir).defaultTimeoutMs, undefined);
        assert.equal(
            loadConfig(join(root, "missing"), false, invalidAgentDir).defaultTimeoutMs,
            undefined,
        );
    });
});
