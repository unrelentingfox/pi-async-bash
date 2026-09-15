import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { registerJobDecideTool } from "../tools/job-decide.ts";

function harness() {
    let tool: { execute: (id: string, input: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    registerJobDecideTool({ registerTool(value: typeof tool) { tool = value; } } as never, new BackgroundRegistry());
    return tool!;
}

void describe("bash_async_decide", () => {
    it("keeps a timed job running without marking its terminal outcome consumed", async () => {
        const registry = new BackgroundRegistry();
        const job = createRunningJob({
            id: `b${process.pid}-decision`,
            command: "sleep 60",
            pid: 0,
            logPath: "/tmp/decision.log",
            toolCallId: "tool-1",
        });
        add(registry, job);
        registry.pendingDecisionJobId = job.id;
        let tool: { execute: (id: string, input: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown> } | undefined;
        registerJobDecideTool({ registerTool(value: typeof tool) { tool = value; } } as never, registry);
        await tool!.execute("tool-2", { jobId: job.id, decision: "keep" }, undefined, undefined, {});
        assert.equal(registry.pendingDecisionJobId, undefined);
        assert.equal(job.notified, undefined);
        assert.equal(job.status, "running");
    });
});
