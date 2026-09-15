import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { openBgListPanel, TaskListComponent } from "../ui.ts";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob, logPathFor } from "../registry.ts";
import { processExists, spawnWithFileOutput } from "../spawn.ts";
import type { Job, UiContext } from "../types.ts";

type Selection =
    | { action: "output"; job: Job; selectedJobId: string }
    | { action: "reload"; selectedJobId?: string }
    | { action: "close" };

function addJob(
    registry: BackgroundRegistry,
    status: "running" | "completed",
    suffix: string = status,
): Job {
    const job = createRunningJob({
        id: `job-${process.pid}-ui-${suffix}`,
        command: "echo task",
        pid: 0,
        logPath: "/tmp/pi-async-bash-ui.log",
        toolCallId: "tool-ui",
    });
    job.status = status;
    add(registry, job);
    return job;
}

function createContext(options: {
    editor?: string | undefined;
    custom?: Array<Selection>;
} = {}): {
    context: UiContext;
    notifications: Array<{ message: string; level?: string }>;
    editorCalls: string[];
} {
    const notifications: Array<{ message: string; level?: string }> = [];
    const editorCalls: string[] = [];
    const custom = [...(options.custom ?? [])];

    return {
        context: {
            ui: {
                notify(message, level) {
                    notifications.push({ message, level });
                },
                setWidget() {},
                setStatus() {},
                theme: { fg(_colour, text) { return text; } },
                async select() { return undefined; },
                async editor(title) {
                    editorCalls.push(title);
                    return options.editor;
                },
                async custom<T>() {
                    return (custom.shift() ?? { action: "close" }) as T;
                },
            },
        },
        notifications,
        editorCalls,
    };
}

function createTaskList(
    registry: BackgroundRegistry,
    context: UiContext,
    job: Job,
): { component: TaskListComponent; completed: Selection[] } {
    return createTaskListForJobs(registry, context, [job]);
}

function createTaskListForJobs(
    registry: BackgroundRegistry,
    context: UiContext,
    jobs: Job[],
    keyOverrides: Partial<Record<string, string[]>> = {},
): { component: TaskListComponent; completed: Selection[] } {
    const completed: Selection[] = [];
    const component = new TaskListComponent(
        registry,
        context,
        jobs,
        undefined,
        { requestRender() {} } as TUI,
        { fg(_colour: string, text: string) { return text; }, bold(text: string) { return text; } } as Theme,
        {
            matches(data: string, id: string) {
                const keys: Record<string, string> = {
                    "tui.select.confirm": "enter",
                    "tui.select.cancel": "escape",
                    "tui.select.up": "up",
                    "tui.select.down": "down",
                };
                return keys[id] === data;
            },
            getKeys(id: string) {
                const keys: Record<string, string[]> = {
                    "tui.select.confirm": ["enter"],
                    "tui.select.cancel": ["escape"],
                };
                return keyOverrides[id] ?? keys[id] ?? [];
            },
        } as KeybindingsManager,
        (selection) => completed.push(selection),
    );
    return { component, completed };
}

void describe("async task list keyboard behavior", () => {
    void it("confirms then kills the highlighted running task once", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context, notifications } = createContext();
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("\x18");
        assert.equal(job.status, "running");
        component.handleInput("enter");
        component.handleInput("enter");

        assert.equal(job.status, "killed");
        assert.deepEqual(completed, [{ action: "reload", selectedJobId: job.id }]);
        assert.deepEqual(notifications, [{ message: `Killed ${job.id}`, level: "info" }]);
    });

    void it("terminates a real process once with raw Ctrl+x", async () => {
        const registry = new BackgroundRegistry();
        const { context } = createContext();
        const spawned = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath: logPathFor(`ui-kill-${process.pid}`),
        });
        const job = createRunningJob({
            id: `job-${process.pid}-ui-real-kill`,
            command: "sleep 60",
            pid: spawned.pid,
            logPath: spawned.logPath,
            toolCallId: "tool-ui-real-kill",
        });
        add(registry, job);
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("\x18");
        component.handleInput("enter");
        component.handleInput("enter");
        const keepAlive = setTimeout(() => {}, 5_000);
        try {
            await spawned.exit;
        } finally {
            clearTimeout(keepAlive);
        }

        assert.equal(processExists(spawned.pid), false);
        assert.deepEqual(completed, [{ action: "reload", selectedJobId: job.id }]);
    });

    void it("does not treat Ctrl+k as kill", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context } = createContext();
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("\x0b");
        component.handleInput("enter");

        assert.equal(job.status, "running");
        assert.deepEqual(completed, [{ action: "output", job, selectedJobId: job.id }]);
    });

    void it("warns instead of removing a terminal task with Ctrl+x", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "completed");
        const { context, notifications } = createContext();
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("\x18");

        assert.equal(job.status, "completed");
        assert.deepEqual(completed, []);
        assert.deepEqual(notifications, [{ message: "Task is not running", level: "warning" }]);
    });

    void it("uses j and k with SelectList wrap semantics", () => {
        const registry = new BackgroundRegistry();
        const first = addJob(registry, "running", "first");
        const second = addJob(registry, "running", "second");
        const { context } = createContext();
        const { component, completed } = createTaskListForJobs(registry, context, [first, second]);

        component.handleInput("j");
        component.handleInput("enter");
        component.handleInput("k");
        component.handleInput("enter");

        assert.deepEqual(completed, [
            { action: "output", job: second, selectedJobId: second.id },
            { action: "output", job: first, selectedJobId: first.id },
        ]);
    });

    void it("renders control-key hints with lowercase letters", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context } = createContext();
        const { component } = createTaskListForJobs(registry, context, [job], {
            "tui.select.cancel": ["ctrl+c"],
        });

        const rendered = component.render(200).join("\n");
        assert.match(rendered, /Ctrl\+x kill/);
        assert.match(rendered, /Ctrl\+c close/);
    });

    void it("opens output directly when Enter selects a task", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context } = createContext();
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("enter");

        assert.deepEqual(completed, [{ action: "output", job, selectedJobId: job.id }]);
    });

    void it("closes the first list on Escape", () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context } = createContext();
        const { component, completed } = createTaskList(registry, context, job);

        component.handleInput("escape");

        assert.deepEqual(completed, [{ action: "close" }]);
    });

    void it("closes the bordered empty state on Escape", async () => {
        const registry = new BackgroundRegistry();
        const { context } = createContext({ custom: [{ action: "close" }] });

        await openBgListPanel(registry, context);
    });

    void it("returns to the first list when Escape closes output", async () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context, editorCalls } = createContext({
            custom: [{ action: "output", job, selectedJobId: job.id }, { action: "close" }],
            editor: undefined,
        });

        await openBgListPanel(registry, context);

        assert.equal(editorCalls.length, 1);
    });
});
