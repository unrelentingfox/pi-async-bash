import { describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "../index.ts";

interface Tool {
    name: string;
}

interface Command {
    description: string;
}

function loadExtension() {
    const tools = new Map<string, Tool>();
    const commands = new Map<string, Command>();
    const handlers = new Map<string, unknown>();
    extension({
        registerTool(tool: Tool) { tools.set(tool.name, tool); },
        registerCommand(name: string, command: Command) { commands.set(name, command); },
        registerMessageRenderer() {},
        on(event: string, handler: unknown) { handlers.set(event, handler); },
    } as never);
    return { tools, commands, handlers };
}

void describe("pi-async-bash public interface", () => {
    void it("registers only the approved async tools", () => {
        const { tools } = loadExtension();
        assert.deepEqual([...tools.keys()].sort(), [
            "bash",
            "bash_async",
            "bash_async_decide",
            "bash_async_list",
            "bash_async_watch",
        ]);
        for (const legacy of ["bash_bg", "jobs", "monitor", "job_decide", "agent_bg"]) {
            assert.equal(tools.has(legacy), false, `${legacy} must not be registered`);
        }
    });

    void it("registers only the approved async commands", () => {
        const { commands } = loadExtension();
        assert.deepEqual([...commands.keys()].sort(), ["bash-async", "bash-async-list"]);
        for (const legacy of ["bg", "bg-list", "bg-version"]) {
            assert.equal(commands.has(legacy), false, `${legacy} must not be registered`);
        }
    });

    void it("uses run_async without accepting the legacy Bash parameter", () => {
        const { tools } = loadExtension();
        const bash = tools.get("bash") as Tool & { parameters: { properties: Record<string, unknown> } };
        assert.equal("run_async" in bash.parameters.properties, true);
        assert.equal("run_in_background" in bash.parameters.properties, false);
    });
});
