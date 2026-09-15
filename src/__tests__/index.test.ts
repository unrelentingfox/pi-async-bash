import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import extension from "../index.ts";

const marker = `pi-async-reload-${process.pid}`;
const command = `while true; do sleep 1; done # ${marker}`;

interface Tool {
    name: string;
    execute: (id: string, input: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>;
}

type Handler = (event: { reason?: string }, ctx: unknown) => Promise<void>;

function harness() {
    const tools = new Map<string, Tool>();
    const handlers = new Map<string, Handler>();
    const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
    extension({
        registerTool(tool: Tool) { tools.set(tool.name, tool); },
        registerCommand() {},
        registerMessageRenderer() {},
        on(event: string, handler: Handler) { handlers.set(event, handler); },
        sendMessage() {},
        appendEntry(customType: string, data: unknown) {
            entries.push({ type: "custom", customType, data });
        },
    } as never);
    return { tools, handlers, entries };
}

const context = {
    cwd: process.cwd(),
    ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_: string, text: string) => text } },
};

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

void describe("session reload continuity", () => {
    void it("stores compatible jobs on reload and restores only current-process jobs", async () => {
        const first = harness();
        await first.handlers.get("session_start")!({}, { sessionManager: { getEntries: () => [] } });
        const bash = first.tools.get("bash")!;
        const result = await bash.execute("tool-1", { command, run_async: true }, undefined, undefined, context) as {
            content: Array<{ text: string }>;
        };
        const id = /ID: (b\d+-[0-9a-z]{8})/.exec(result.content[0]!.text)?.[1];
        assert.ok(id);
        const pid = Number.parseInt(id!.slice(1, id!.indexOf("-")), 10);
        assert.equal(pid, process.pid);

        await first.handlers.get("session_shutdown")!({ reason: "reload" }, {});
        const snapshot = first.entries.at(-1)!;
        assert.equal(snapshot.customType, "pi-async-bash-state");
        const storedJob = (snapshot.data as { jobs: Array<{ pid: number }> }).jobs[0]!;
        const childPid = storedJob.pid;
        assert.equal(isAlive(childPid), true, "reload must not terminate the child process");

        const second = harness();
        await second.handlers.get("session_start")!({}, { sessionManager: { getEntries: () => [snapshot] } });
        const list = await second.tools.get("bash_async_list")!.execute(
            "tool-2", { action: "list" }, undefined, undefined, context,
        ) as { content: Array<{ text: string }> };
        assert.match(list.content[0]!.text, new RegExp(id!));

        const restored = second.tools.get("bash_async_list")!;
        const stopped = await restored.execute(
            "tool-4", { action: "kill", jobId: id }, undefined, undefined, context,
        ) as { content: Array<{ text: string }> };
        assert.match(stopped.content[0]!.text, new RegExp(id!));
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(isAlive(childPid), false, "a restored job can still be terminated safely");
    });

    void it("rejects snapshots from another spawning process without signalling their PID", async () => {
        const h = harness();
        const foreignPid = process.pid + 1;
        const snapshot = {
            type: "custom" as const,
            customType: "pi-async-bash-state",
            data: {
                jobs: [{
                    id: `b${foreignPid}-abcdefgh`,
                    command: "sleep 60",
                    pid: process.pid,
                    startTime: Date.now(),
                    status: "running",
                    logPath: "/tmp/not-a-real-job.log",
                    toolCallId: "old-tool",
                    isBackgrounded: true,
                }],
            },
        };
        await h.handlers.get("session_start")!({}, { sessionManager: { getEntries: () => [snapshot] } });
        const list = await h.tools.get("bash_async_list")!.execute(
            "tool-3", { action: "list" }, undefined, undefined, context,
        ) as { content: Array<{ text: string }> };
        assert.equal(list.content[0]!.text, "No background jobs");
    });
});

void describe("test cleanup", () => {
    it("clears a leaked marked process", () => {
        execSync(`pkill -f "[p]i-async-reload-${process.pid}" || true`);
    });
});
