/**
 * pi-async-bash — asynchronous Bash execution for the Pi agent.
 *
 * Registers `bash`, `bash_async`, `bash_async_list`, `bash_async_watch`, and
 * `bash_async_decide`, plus `/bash-async` and `/bash-async-list`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import { cleanupStaleRuntimeArtifacts, detectNonInteractive, reviveAndValidate, serializeJobs, terminateJobSilently } from "./lifecycle.ts";
import { stopSidebarTicker } from "./registry.ts";
import { EVENT } from "./types.ts";
import { registerBashTool } from "./tools/bash.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerMonitorTool } from "./tools/monitor.ts";
import { registerCommands } from "./commands.ts";
import { registerJobDecideTool } from "./tools/job-decide.ts";
import { registerInputHandlers } from "./input.ts";

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // ── Tool registration ─────────────────────────────────────────
    // Use the unwrapped tool *definition* so the override inherits Pi's native
    // bash renderCall/renderResult (createBashTool returns a wrapped AgentTool
    // that drops them).
    const originalBash = createBashToolDefinition(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerMonitorTool(pi, reg);
    registerJobDecideTool(pi, reg);

    // ── Commands and cooperative steering ─────────────────────────
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);

    // ── Message rendering ─────────────────────────────────────────
    // <task-notification> messages render as one colored line: green for
    // completed, red for failed, yellow for killed and for the statusless
    // stall warning (CC's unread/attention color).
    const renderTaskNotification = (
        message: { content: unknown; details?: unknown },
        theme: { fg(colour: string, text: string): string }
    ) => {
        const details = message.details as
            | { status?: string; summary?: string }
            | undefined;
        const colour =
            details?.status === "completed"
                ? "success"
                : details?.status === "failed"
                  ? "error"
                  : "warning";
        const line = theme.fg(colour, `● ${details?.summary ?? String(message.content)}`);
        return { render: () => [line], invalidate: () => {} };
    };
    pi.registerMessageRenderer(EVENT.taskNotification, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );
    pi.registerMessageRenderer(EVENT.stall, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );

    // Restore only jobs that belong to this Pi process. This preserves async
    // work through `/reload` but refuses to signal reused PIDs after restart.
    pi.on("session_start", async (_event, ctx) => {
        reg.nonInteractive = detectNonInteractive(process.argv, Boolean(process.stdin.isTTY));
        const entries = ctx.sessionManager.getEntries();
        const state = [...entries].reverse().find((entry) =>
            entry.type === "custom" && entry.customType === "pi-async-bash-state"
        ) as { type: "custom"; data?: { jobs?: Array<import("./types.ts").Job> } } | undefined;
        for (const job of state?.data?.jobs ?? []) {
            if (reviveAndValidate(job) === "alive") reg.jobs.set(job.id, job);
        }
        void cleanupStaleRuntimeArtifacts();
    });

    pi.on("session_shutdown", async (event, _ctx) => {
        stopSidebarTicker(reg);
        if (event.reason === "quit") {
            for (const job of reg.jobs.values()) {
                if (job.status === "running") terminateJobSilently(reg, job);
            }
        }
        pi.appendEntry("pi-async-bash-state", { jobs: serializeJobs(reg.jobs.values()) });
    });
}
