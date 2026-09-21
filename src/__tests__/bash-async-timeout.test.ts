/**
 * `bash run_async` — decision timeout behavior:
 *   - kill branch: a log marker plus a killed <task-notification> (the agent
 *     must learn its command was timeout-killed),
 *   - decision branch: a pending decision plus a warning for the model to
 *     resolve via bash_async_decide, with the process left alive.
 *
 * Also covers the `notify` plumbing: notify=false suppresses the terminal
 * <task-notification> while still evicting the job from the live registry.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { EVENT, isTerminalStatus } from "../types.ts";
import { killProcessTree, processExists } from "../spawn.ts";

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
    const notifications: Array<{ message: string; level: string }> = [];
    const pi = {
        registerTool: (def: ToolDef) => { tool = def; },
        sendMessage: (m: CapturedMessage) => { messages.push(m); },
    };
    const reg = new BackgroundRegistry();
    registerBashTool(pi as never, reg, {} as never);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify: (message: string, level: string) => {
                notifications.push({ message, level });
            },
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx, messages, notifications };
}

const spawnedPids: number[] = [];

void describe("bash run_async — decision timeout", () => {
    void it("kill branch: marks the log AND sends a killed <task-notification>", async () => {
        const { tool, ctx, messages } = harness();
        // `sleep` is excluded from auto-backgrounding, and a float duration
        // slips past the blocked-sleep guard — so the decision timeout hits
        // the kill path (same trick as the foreground timeout test).
        const res = await tool.execute(
            "t1",
            { command: "sleep 1.5", run_async: true, timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        const logPath = /Output is being written to: (\S+)/.exec(res.content[0].text)?.[1];
        assert.ok(logPath, "tool result carries the log path");

        // Bounded poll: the 1s timeout fires, SIGTERM, exit handler notifies.
        const terminals = () => messages.filter((m) => m.customType === EVENT.taskNotification);
        for (let i = 0; i < 60 && terminals().length === 0; i++) {
            await sleep(50);
        }

        assert.equal(terminals().length, 1, "the agent learns its command was timeout-killed");
        assert.ok(terminals()[0].content.includes("<status>killed</status>"));
        assert.ok(terminals()[0].content.includes("was stopped"));
        assert.match(
            readFileSync(logPath, "utf-8"),
            /Command timed out after 1s/,
            "log marker tells a timeout kill apart from a normal failure"
        );
    });

    void it("decision branch: marks the decision pending, warns, and leaves the process alive", async () => {
        const { tool, reg, ctx, notifications } = harness();
        // `tail -f` is auto-background-eligible, so the decision timeout hits
        // the decision path instead of the kill path.
        const res = await tool.execute(
            "t1-decide",
            { command: "tail -f /dev/null", run_async: true, timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        const jobId = /Command running asynchronously with ID: (\S+)\./.exec(res.content[0].text)?.[1];
        assert.ok(jobId, "tool result carries the job id");
        const job = reg.jobs.get(jobId);
        if (job) spawnedPids.push(job.pid);
        assert.ok(job, "job is registered");

        // Bounded poll: don't assert synchronously on a ~200ms margin after a
        // 1000ms timer (timing flake under load).
        for (let i = 0; i < 60 && reg.pendingDecisionJobId !== jobId; i++) {
            await sleep(50);
        }

        assert.equal(reg.pendingDecisionJobId, jobId, "the job awaits bash_async_decide");
        assert.equal(job!.status, "running", "the job was not killed");
        assert.ok(processExists(job!.pid), "the process is STILL alive");
        const warnings = notifications.filter((n) => n.level === "warning");
        assert.equal(warnings.length, 1, "the model is notified to decide");
        assert.ok(warnings[0].message.includes(`exceeded 1s`));
        assert.ok(warnings[0].message.includes(jobId));
    });
});

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

after(() => {
    for (const pid of spawnedPids) {
        try { killProcessTree(pid, "SIGKILL"); } catch { /* already gone */ }
    }
});
