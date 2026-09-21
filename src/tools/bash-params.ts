/**
 * Shared bash parameter schema (TypeBox) used by the overridden `bash` tool.
 */

import { Type } from "@earendil-works/pi-ai";

export const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({
            description:
                "Seconds. Without run_async, auto-backgrounds a still-running foreground command " +
                "when it expires, or kills it if it is not eligible for auto-backgrounding " +
                "(default: pi-async-bash.defaultTimeoutSeconds from settings.json, or 120). " +
                "Ignored with run_async=true.",
        })
    ),
    run_async: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately and return its " +
                "job ID. Output is saved to /tmp/pi-bg/<jobId>.log. description becomes the " +
                "bash_async label.",
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
                "from the live bash_async set.",
        })
    ),
});
