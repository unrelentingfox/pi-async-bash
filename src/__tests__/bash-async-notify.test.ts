/**
 * `bash run_async` — notify plumbing:
 *   - notify=false suppresses the terminal <task-notification> while still
 *     evicting the job from the live registry,
 *   - default notify sends exactly one terminal <task-notification>.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { EVENT, isTerminalStatus } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolDef {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

interface CapturedMessage {
    customType: string;
    content: string;
}

function harness() {
    let tool: ToolDef | undefined;
    const messages: CapturedMessage[] = [];
    const pi = {
        registerTool: (def: ToolDef) => { tool = def; },
        sendMessage: (m: CapturedMessage) => { messages.push(m); },
    };
    const reg = new BackgroundRegistry();
    registerBashTool(pi as never, reg, {} as never);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify: () => {},
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx, messages };
}

void describe("bash run_async — notify plumbing", () => {
    void it("notify: false sends no task-notification and evicts the job", async () => {
        const { tool, reg, ctx, messages } = harness();
        await tool.execute(
            "t-notify-off",
            { command: "echo hi", run_async: true, notify: false },
            undefined,
            undefined,
            ctx
        );
        // Wait for the job to reach a terminal status.
        for (let i = 0; i < 50 && [...reg.jobs.values()].some((j) => !isTerminalStatus(j.status)); i++) {
            await sleep(50);
        }
        const terminals = messages.filter((m) => m.customType === EVENT.taskNotification);
        assert.equal(terminals.length, 0, "notification suppressed");
        assert.equal(reg.jobs.size, 0, "job evicted from the live registry");
    });

    void it("default notify sends exactly one task-notification", async () => {
        const { tool, reg, ctx, messages } = harness();
        await tool.execute(
            "t-notify-on",
            { command: "echo hi", run_async: true },
            undefined,
            undefined,
            ctx
        );
        for (let i = 0; i < 50 && messages.length === 0; i++) {
            await sleep(50);
        }
        const terminals = messages.filter((m) => m.customType === EVENT.taskNotification);
        assert.equal(terminals.length, 1, "positive control: one notification");
    });
});
