import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Component, type KeybindingsManager, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { openBgListPanel, OutputViewerComponent, TaskListComponent } from "../ui.ts";
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
    customOptions: Array<{ overlay?: boolean; overlayOptions?: unknown } | undefined>;
    notifications: Array<{ message: string; level?: string }>;
    editorCalls: string[];
} {
    const notifications: Array<{ message: string; level?: string }> = [];
    const editorCalls: string[] = [];
    const custom = [...(options.custom ?? [])];
    const customOptions: Array<{ overlay?: boolean; overlayOptions?: unknown } | undefined> = [];

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
                async custom<T>(
                    _factory: (
                        tui: TUI,
                        theme: Theme,
                        keybindings: KeybindingsManager,
                        done: (result: T) => void,
                    ) => Component,
                    customOptionsArgument?: { overlay?: boolean; overlayOptions?: OverlayOptions },
                ) {
                    customOptions.push(customOptionsArgument);
                    return (custom.shift() ?? { action: "close" }) as T;
                },
            },
        },
        customOptions,
        notifications,
        editorCalls,
    };
}

function createOutputViewer(
    output: string,
    options: { columns?: number; rows?: number; logPath?: string; initialOffset?: number; maxRetainedBytes?: number } = {},
): {
    component: OutputViewerComponent;
    completed: number[];
    renders: number[];
} {
    const completed: number[] = [];
    const renders: number[] = [];
    const job = addJob(new BackgroundRegistry(), "completed", "output");
    const component = new OutputViewerComponent(
        job,
        output,
        {
            terminal: { columns: options.columns ?? 20, rows: options.rows ?? 16 },
            requestRender() { renders.push(1); },
        } as TUI,
        { fg(_colour: string, text: string) { return text; }, bold(text: string) { return text; } } as Theme,
        () => completed.push(1),
        options.initialOffset,
        options.logPath,
        options.maxRetainedBytes,
    );
    return { component, completed, renders };
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

    void it("scrolls output one line with arrows and vim keys", () => {
        const { component, renders } = createOutputViewer("zero\none\ntwo\nthree\nfour");

        component.handleInput("\x1b[B");
        assert.match(component.render(20).join("\n"), /one/);
        component.handleInput("k");

        assert.match(component.render(20).join("\n"), /zero/);
        assert.equal(renders.length, 2);
    });

    void it("uses Home, End, gg, and G to scroll output to the limits", () => {
        const { component } = createOutputViewer("zero\none\ntwo\nthree\nfour", { rows: 10 });

        component.handleInput("\x1b[F");
        assert.match(component.render(20).join("\n"), /four/);
        component.handleInput("\x1b[H");
        assert.match(component.render(20).join("\n"), /zero/);
        component.handleInput("G");
        assert.match(component.render(20).join("\n"), /four/);
        component.handleInput("g");
        component.handleInput("g");

        assert.match(component.render(20).join("\n"), /zero/);
    });

    void it("scrolls output by a viewport with PageUp/PageDown and u/d", () => {
        const { component } = createOutputViewer(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

        component.handleInput("\x1b[5~");
        component.handleInput("\x1b[5~");
        assert.match(component.render(20).join("\n"), /line 0/);
        component.handleInput("d");
        assert.match(component.render(20).join("\n"), /line 7/);
        component.handleInput("u");
        assert.match(component.render(20).join("\n"), /line 0/);
        component.handleInput("\x1b[6~");

        assert.match(component.render(20).join("\n"), /line 7/);
    });

    void it("ignores Ctrl+u and Ctrl+d in the output viewer", () => {
        const { component, renders } = createOutputViewer(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
        const before = component.render(20);

        component.handleInput("\x15");
        component.handleInput("\x04");

        assert.deepEqual(component.render(20), before);
        assert.equal(renders.length, 0);
    });

    void it("scrolls output horizontally without widening rendered lines", () => {
        const { component } = createOutputViewer("0123456789", { columns: 5 });

        component.handleInput("l");
        const output = component.render(5);

        assert.ok(output.every((line) => visibleWidth(line) <= 5));
        assert.match(output.join("\n"), /12345/);
    });

    void it("ignores editing keys and Enter in the read-only output viewer", () => {
        const { component, renders } = createOutputViewer("zero\none\ntwo\nthree");
        const before = component.render(20);

        component.handleInput("x");
        component.handleInput("\x7f");
        component.handleInput("\r");

        assert.deepEqual(component.render(20), before);
        assert.equal(renders.length, 0);
    });

    void it("uses the full terminal height and pins the hint and borders", () => {
        const output = Array.from({ length: 100 }, (_, index) => `output row ${index}`).join("\n");

        for (const rows of [1, 2, 3, 4, 5, 8, 12, 24]) {
            const { component } = createOutputViewer(output, { columns: 120, rows });
            const rendered = component.render(120);

            assert.ok(rendered.length <= rows, `rows ${rows} rendered ${rendered.length} lines`);
            assert.match(rendered.join("\n"), /output row 99/, `rows ${rows} retains the newest output row`);
            if (rows >= 4) {
                assert.match(rendered[0] ?? "", /^─+$/);
                assert.match(rendered.at(-2) ?? "", /↑↓\/jk scroll/);
                assert.match(rendered.at(-1) ?? "", /^─+$/);
            }
        }
    });

    void it("renders the normal overlay in border, metadata, output, hint order", () => {
        const { component } = createOutputViewer("output row 0", { columns: 120, rows: 16 });
        const rendered = component.render(120);

        assert.match(rendered[0] ?? "", /^─+$/);
        assert.match(rendered[1] ?? "", /job-/);
        assert.match(rendered[2] ?? "", /^Command:/);
        assert.match(rendered[6] ?? "", /^--- OUTPUT ---$/);
        assert.equal(rendered[7], "output row 0");
        assert.match(rendered.at(-2) ?? "", /↑↓\/jk scroll/);
        assert.match(rendered.at(-1) ?? "", /^─+$/);
    });

    void it("pads short output so the hint and border stay at the terminal bottom", () => {
        const { component } = createOutputViewer("output row 0", { columns: 120, rows: 16 });
        const rendered = component.render(120);

        assert.equal(rendered.length, 16);
        assert.equal(rendered[7], "output row 0");
        assert.match(rendered.at(-2) ?? "", /↑↓\/jk scroll/);
        assert.match(rendered.at(-1) ?? "", /^─+$/);
    });

    void it("uses simple output-first priorities in tiny viewports", () => {
        const output = "output row 0\noutput row 1";
        const oneRow = createOutputViewer(output, { columns: 120, rows: 1 }).component.render(120);
        const twoRows = createOutputViewer(output, { columns: 120, rows: 2 }).component.render(120);
        const threeRows = createOutputViewer(output, { columns: 120, rows: 3 }).component.render(120);
        const fourRows = createOutputViewer(output, { columns: 120, rows: 4 }).component.render(120);

        assert.deepEqual(oneRow, ["output row 1"]);
        assert.deepEqual(twoRows, ["output row 1"]);
        assert.match(threeRows[0] ?? "", /^─+$/);
        assert.match(threeRows[1] ?? "", /output row 1/);
        assert.match(threeRows[2] ?? "", /^─+$/);
        assert.match(fourRows[0] ?? "", /^─+$/);
        assert.match(fourRows[1] ?? "", /output row 1/);
        assert.match(fourRows[2] ?? "", /↑↓\/jk scroll/);
        assert.match(fourRows[3] ?? "", /^─+$/);
    });

    void it("clamps output scrolling at every boundary", () => {
        const { component } = createOutputViewer("0123456789\n0123456789\n0123456789\n0123456789", { columns: 5, rows: 10 });

        component.handleInput("\x1b[A");
        component.handleInput("h");
        assert.match(component.render(5).join("\n"), /01234/);

        component.handleInput("\x1b[6~");
        component.handleInput("\x1b[6~");
        component.handleInput("\x1b[C");
        component.handleInput("\x1b[C");
        component.handleInput("\x1b[C");
        component.handleInput("\x1b[C");
        component.handleInput("\x1b[C");
        component.handleInput("\x1b[C");

        const rendered = component.render(5).join("\n");
        assert.match(rendered, /56789/);
    });

    void it("pauses live follow above the bottom and resumes it at the bottom", async () => {
        const logPath = join(tmpdir(), `pi-async-bash-ui-follow-${process.pid}.log`);
        writeFileSync(logPath, "first\nsecond");
        const { component } = createOutputViewer("first\nsecond", {
            logPath,
            initialOffset: Buffer.byteLength("first\nsecond"),
            rows: 10,
        });

        component.handleInput("\x1b[H");
        appendFileSync(logPath, "\nthird");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.match(component.render(80).join("\n"), /first/);
        assert.doesNotMatch(component.render(80).join("\n"), /third/);

        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        assert.match(component.render(80).join("\n"), /third/);
        appendFileSync(logPath, "\nfourth");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.match(component.render(80).join("\n"), /fourth/);
        component.handleInput("\x1b");
        appendFileSync(logPath, "\nfifth");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.doesNotMatch(component.render(80).join("\n"), /fifth/);
        unlinkSync(logPath);
    });

    void it("stops live following when disposed", async () => {
        const logPath = join(tmpdir(), `pi-async-bash-ui-dispose-${process.pid}.log`);
        writeFileSync(logPath, "first");
        const { component, renders } = createOutputViewer("first", {
            logPath,
            initialOffset: Buffer.byteLength("first"),
        });

        component.dispose();
        const rendersBeforeAppend = renders.length;
        appendFileSync(logPath, "\nsecond");
        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.equal(renders.length, rendersBeforeAppend);
        assert.doesNotMatch(component.render(80).join("\n"), /second/);
        component.dispose();
        unlinkSync(logPath);
    });

    void it("retains only the newest complete lines from live output within its byte limit", async () => {
        const logPath = join(tmpdir(), `pi-async-bash-ui-retain-${process.pid}.log`);
        writeFileSync(logPath, "one");
        const { component } = createOutputViewer("one", {
            logPath,
            initialOffset: Buffer.byteLength("one"),
            maxRetainedBytes: 10,
        });

        appendFileSync(logPath, "\ntwo\nthree");
        await new Promise((resolve) => setTimeout(resolve, 300));
        component.handleInput("\x1b[H");
        assert.match(component.render(80).join("\n"), /two/);
        assert.doesNotMatch(component.render(80).join("\n"), /one/);
        component.handleInput("G");
        assert.match(component.render(80).join("\n"), /three/);
        component.dispose();
        unlinkSync(logPath);
    });

    void it("returns from output to the task list on Escape", () => {
        const { component, completed } = createOutputViewer("output");

        component.handleInput("\x1b");

        assert.deepEqual(completed, [1]);
    });

    void it("opens a >12000-character log from its beginning without truncation and retains its end", () => {
        const output = `BEGIN\n${"x".repeat(12_001)}\nEND`;
        const { component } = createOutputViewer(output, { columns: 20, rows: 10 });

        component.handleInput("\x1b[H");
        assert.match(component.render(20).join("\n"), /BEGIN/);
        assert.doesNotMatch(component.render(20).join("\n"), /\[truncated/);
        component.handleInput("G");
        assert.match(component.render(20).join("\n"), /END/);
    });

    void it("opens output in a full-terminal overlay and returns to the list", async () => {
        const registry = new BackgroundRegistry();
        const job = addJob(registry, "running");
        const { context, customOptions, editorCalls } = createContext({
            custom: [{ action: "output", job, selectedJobId: job.id }, { action: "close" }],
            editor: undefined,
        });

        await openBgListPanel(registry, context);

        assert.equal(editorCalls.length, 0);
        assert.deepEqual(customOptions[1], {
            overlay: true,
            overlayOptions: {
                anchor: "top-left",
                width: "100%",
                maxHeight: "100%",
                margin: 0,
            },
        });
    });
});
