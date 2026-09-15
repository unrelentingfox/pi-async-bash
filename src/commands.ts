/** Async Bash slash commands. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { takeControl, type ControlContext } from "./lifecycle.ts";
import { openBgListPanel } from "./ui.ts";

/** Register async handoff and task-list commands. */
export function registerCommands(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerCommand("bash-async", {
        description: "Send the currently running bash command to the background. Return control to the agent",
        handler: async (_args, ctx) => {
            takeControl(reg, ctx as unknown as ControlContext);
        },
    });

    pi.registerCommand("bash-async-list", {
        description: "Open the interactive asynchronous Bash task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });
}
