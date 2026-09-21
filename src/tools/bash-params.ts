/**
 * Shared bash parameter schema (TypeBox) used by the overridden `bash` tool.
 */

import { Type } from "@earendil-works/pi-ai";

export const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({
            description:
                "Seconds. With run_async=true this is a DECISION timeout and has no default: " +
                "when it expires you are notified and resolve the job with bash_async_decide, " +
                "unless the command is not eligible for auto-backgrounding (for example a short " +
                "fixed sleep), which is killed. Without run_async it auto-backgrounds a " +
                "still-running command when it expires, unless the command is not eligible for " +
                "auto-backgrounding, in which case it is killed (default: " +
                "pi-async-bash.defaultTimeoutSeconds from settings.json, or 120).",
        })
    ),
    run_async: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately and return its " +
                "job ID. Output is saved to /tmp/pi-bg/<jobId>.log. description becomes the " +
                "bash_async_list label.",
        })
    ),
    description: Type.Optional(
        Type.String({ description: "Short description of what this command does" })
    ),
    notify: Type.Optional(
        Type.Boolean({
            description:
                "Send a terminal notification when a run_async job finishes (default: true). " +
                "A command that starts in the foreground and is later backgrounded always notifies. " +
                "Set false to suppress the run_async notification; the finished job is then removed " +
                "from the live bash_async_list set.",
        })
    ),
});
