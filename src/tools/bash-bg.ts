// src/tools/bash-bg.ts
//
// `bash_async` starts a Bash command asynchronously and returns its job ID.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import type { BackgroundRegistry } from "../state.ts";
import { isTerminalStatus, type UiContext } from "../types.ts";
import { killProcessTree, spawnWithFileOutput } from "../spawn.ts";
import { add, createRunningJob, newJobId, logPathFor } from "../registry.ts";
import {
    assertJobSlot,
    detectBlockedSleep,
    isAutoBackgroundAllowed,
    isBlankCommand,
    requireExistingCwd,
    SLEEP_WAIT_GUIDANCE,
    startBackgroundJob,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";
import { renderBashAsyncCall } from "../render.ts";

type BashAsyncContext = UiContext & { cwd: string };

/** Register immediate asynchronous Bash execution. */
export function registerBashBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "bash_async",
        label: "Async Bash",
        description: "Start a Bash command asynchronously. Output is saved to /tmp/pi-bg/<jobId>.log.",
        promptSnippet: "Start long-running Bash commands asynchronously",
        promptGuidelines: [
            "Use bash_async when a command should start asynchronously immediately.",
            "Use bash_async_watch for per-event streams; bash_async reports one terminal outcome.",
            "Do not start a fixed sleep asynchronously. Use bash_async_list action='attach', bash_async_watch, or an until loop that exits when ready.",
            "Give the job a name when it will be easier to track with bash_async_list.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "Bash command to run" }),
            name: Type.Optional(Type.String({ description: "Label shown by bash_async_list" })),
            timeout: Type.Optional(Type.Number({ description: "Decision timeout in seconds" })),
            notify: Type.Optional(Type.Boolean({ description: "Send terminal notification (default: true)" })),
        }),
        renderCall: renderBashAsyncCall,
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const input = params as { command: string; name?: string; timeout?: number; notify?: boolean };
            const asyncContext = ctx as BashAsyncContext;
            if (isBlankCommand(input.command)) throw new Error("Command is empty.");
            const sleepMatch = detectBlockedSleep(input.command);
            if (sleepMatch) throw new Error(`Blocked: ${sleepMatch}. ${SLEEP_WAIT_GUIDANCE}`);
            requireExistingCwd(asyncContext.cwd);
            assertJobSlot(reg);

            const id = newJobId("shell", reg);
            const logPath = logPathFor(id);
            const spawned = spawnWithFileOutput({ command: input.command, cwd: asyncContext.cwd, logPath });
            const job = createRunningJob({
                id,
                name: input.name,
                command: input.command,
                pid: spawned.pid,
                logPath,
                toolCallId,
            });
            add(reg, job);
            const jobAbort = startBackgroundJob({
                reg,
                pi,
                ctx: asyncContext,
                job,
                exit: spawned.exit,
                shouldNotify: input.notify !== false,
            });
            scheduleDecisionTimeout(reg, asyncContext, job, input.timeout, jobAbort, logPath);

            return {
                content: [textBlock(
                    `Command running asynchronously with ID: ${id}.` +
                    `${input.name ? ` Name: ${input.name}.` : ""} Output is being written to: ${logPath}`,
                )],
                details: undefined,
            };
        },
    });
}

function scheduleDecisionTimeout(
    reg: BackgroundRegistry,
    ctx: BashAsyncContext,
    job: ReturnType<typeof createRunningJob>,
    timeout: number | undefined,
    jobAbort: AbortController,
    logPath: string,
): void {
    if (!timeout) return;
    const timer = setTimeout(() => {
        if (isTerminalStatus(job.status) || reg.nonInteractive) return;
        if (!isAutoBackgroundAllowed(job.command)) {
            try {
                appendFileSync(logPath, `Command timed out after ${timeout}s\n`);
            } catch {
                // Process termination remains correct if diagnostics cannot be written.
            }
            killProcessTree(job.pid, "SIGTERM");
            return;
        }
        reg.pendingDecisionJobId = job.id;
        ctx.ui.notify(
            `Async Bash job ${job.id} exceeded ${timeout}s. Use bash_async_decide to keep, stop, or inspect it.`,
            "warning",
        );
    }, timeout * 1000);
    timer.unref();
    jobAbort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}
