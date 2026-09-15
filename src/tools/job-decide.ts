import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { OUTPUT_PREVIEW_CHARS, type UiContext } from "../types.ts";
import { findJob, readLogTail, renderSidebar } from "../registry.ts";
import { terminateJobSilently } from "../lifecycle.ts";
import { jobLabel, textBlock } from "../format.ts";

/** Register decisions for timed asynchronous Bash commands. */
export function registerJobDecideTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "bash_async_decide",
        label: "Async Bash Decision",
        description: "Keep, stop, or inspect an asynchronous Bash command that exceeded its timeout.",
        promptSnippet: "Resolve a timed asynchronous Bash command",
        promptGuidelines: [
            "Use bash_async_decide after a bash_async timeout notification.",
            "keep leaves the command running, kill stops it, and check shows its current output.",
        ],
        parameters: Type.Object({
            jobId: Type.String({ description: "Timed asynchronous Bash job ID" }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description: "Action to take for the timed job",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const { jobId, decision } = params as {
                jobId: string;
                decision: "keep" | "kill" | "check";
            };
            const job = findJob(reg, jobId);
            if (!job) {
                if (reg.pendingDecisionJobId === jobId) {
                    reg.pendingDecisionJobId = undefined;
                }
                return { content: [textBlock(`No async Bash job found with ID: ${jobId}.`)], details: undefined };
            }

            if (decision === "check") {
                const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
                return {
                    content: [textBlock(`Output for ${jobLabel(job)}:\n${output || "(no output yet)"}`)],
                    details: undefined,
                };
            }

            reg.pendingDecisionJobId = undefined;
            if (decision === "kill") {
                terminateJobSilently(reg, job);
                renderSidebar(reg, ctx as UiContext);
                return { content: [textBlock(`Stopped ${jobLabel(job)}.`)], details: undefined };
            }

            return {
                content: [textBlock(`Keeping ${jobLabel(job)} running. Use bash_async_list to inspect it later.`)],
                details: undefined,
            };
        },
    });
}
