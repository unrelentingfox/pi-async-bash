/** Async Bash task manager for `/bash-async-list`. */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, type Component, type KeybindingsManager, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import type { Job, UiContext } from "./types.ts";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration, jobLabel } from "./format.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { readLogTail, renderSidebar } from "./registry.ts";

type TaskSelection =
    | { action: "output"; job: Job; selectedJobId: string }
    | { action: "reload"; selectedJobId?: string }
    | { action: "close" };

export async function openBgListPanel(
    reg: BackgroundRegistry,
    ctx: UiContext,
): Promise<void> {
    let selectedJobId: string | undefined;

    while (true) {
        const selection = await selectJob(reg, ctx, selectedJobId);
        if (selection.action === "close") return;
        selectedJobId = selection.selectedJobId;
        if (selection.action === "reload") continue;
        await showOutput(selection.job, ctx);
    }
}

async function selectJob(
    reg: BackgroundRegistry,
    ctx: UiContext,
    selectedJobId: string | undefined,
): Promise<TaskSelection> {
    const jobs = getJobList(reg);
    if (jobs.length === 0) {
        return ctx.ui.custom?.<TaskSelection>((tui, theme, keybindings, done) =>
            new EmptyTaskListComponent(tui, theme, keybindings, done),
        ) ?? Promise.resolve({ action: "close" });
    }

    return ctx.ui.custom?.<TaskSelection>((tui, theme, keybindings, done) =>
        new TaskListComponent(reg, ctx, jobs, selectedJobId, tui, theme, keybindings, done),
    ) ?? Promise.resolve({ action: "close" });
}

export class TaskListComponent extends Container {
    private readonly jobs: Job[];
    private readonly jobsById: Map<string, Job>;
    private readonly header: Text;
    private readonly footer: Text;
    private readonly list: SelectList;
    private confirmingJob: Job | undefined;
    private completed = false;
    private readonly reg: BackgroundRegistry;
    private readonly ctx: UiContext;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly done: (selection: TaskSelection) => void;

    constructor(
        reg: BackgroundRegistry,
        ctx: UiContext,
        jobs: Job[],
        selectedJobId: string | undefined,
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (selection: TaskSelection) => void,
    ) {
        super();
        this.reg = reg;
        this.ctx = ctx;
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.done = done;
        this.jobs = jobs;
        this.jobsById = new Map(jobs.map((job) => [job.id, job]));
        this.header = new Text(this.renderHeader(jobs), 1, 0);
        this.footer = new Text("", 1, 0);
        this.list = new SelectList(jobs.map(jobToSelectItem), Math.min(jobs.length, 10), {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("muted", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("warning", text),
        });
        this.list.setSelectedIndex(Math.max(0, jobs.findIndex((job) => job.id === selectedJobId)));
        this.list.onSelect = (item) => {
            const job = this.jobsById.get(item.value);
            if (job) this.done({ action: "output", job, selectedJobId: job.id });
        };
        this.list.onCancel = () => this.done({ action: "close" });

        this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
        this.addChild(this.header);
        this.addChild(this.list);
        this.addChild(this.footer);
        this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
        this.updateFooter();
    }

    handleInput(data: string): void {
        if (this.completed) return;
        if (this.confirmingJob) {
            this.handleConfirmation(data);
            return;
        }

        if (matchesKey(data, Key.ctrl("x"))) {
            this.requestKill();
            return;
        }

        if (matchesKey(data, "j")) {
            this.moveSelection(1);
            return;
        }

        if (matchesKey(data, "k")) {
            this.moveSelection(-1);
            return;
        }

        if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.done({ action: "close" });
            return;
        }

        if (this.keybindings.matches(data, "tui.select.confirm")) {
            const item = this.list.getSelectedItem();
            const job = item ? this.jobsById.get(item.value) : undefined;
            if (job) this.done({ action: "output", job, selectedJobId: job.id });
            return;
        }

        this.list.handleInput(data);
        this.tui.requestRender();
    }

    private moveSelection(delta: number): void {
        const selected = this.list.getSelectedItem();
        const currentIndex = selected ? this.jobs.findIndex((job) => job.id === selected.value) : 0;
        const nextIndex = (currentIndex + delta + this.jobs.length) % this.jobs.length;
        this.list.setSelectedIndex(nextIndex);
        this.tui.requestRender();
    }

    private handleConfirmation(data: string): void {
        if (this.keybindings.matches(data, "tui.select.confirm")) {
            const job = this.confirmingJob;
            if (job) this.kill(job);
            return;
        }
        if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.confirmingJob = undefined;
            this.updateFooter();
            this.tui.requestRender();
        }
    }

    private requestKill(): void {
        const item = this.list.getSelectedItem();
        const job = item ? this.jobsById.get(item.value) : undefined;
        if (!job || job.status !== "running") {
            this.ctx.ui.notify("Task is not running", "warning");
            return;
        }

        this.confirmingJob = job;
        this.updateFooter();
        this.tui.requestRender();
    }

    private kill(job: Job): void {
        terminateJobSilently(this.reg, job);
        renderSidebar(this.reg, this.ctx);
        this.ctx.ui.notify(`Killed ${jobLabel(job)}`, "info");
        this.completed = true;
        this.done({ action: "reload", selectedJobId: job.id });
    }

    private renderHeader(jobs: Job[]): string {
        const running = jobs.filter((job) => job.status === "running").length;
        return this.theme.fg(
            "accent",
            this.theme.bold(`Async Bash Tasks · ${jobs.length} total · ${running} running`),
        );
    }

    private updateFooter(): void {
        if (this.confirmingJob) {
            this.footer.setText(this.theme.fg(
                "warning",
                `Kill ${jobLabel(this.confirmingJob)}? ${formatKeyHint(this.keybindings, "tui.select.confirm", "confirm")} · ${formatKeyHint(this.keybindings, "tui.select.cancel", "cancel")}`,
            ));
            return;
        }

        this.footer.setText(this.theme.fg(
            "dim",
            `${formatKeyHint(this.keybindings, "tui.select.confirm", "output")} · Ctrl+x kill · ${formatKeyHint(this.keybindings, "tui.select.cancel", "close")}`,
        ));
    }
}

class EmptyTaskListComponent extends Container {
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly done: (selection: TaskSelection) => void;

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (selection: TaskSelection) => void,
    ) {
        super();
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.done = done;
        this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
        this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Async Bash Tasks")), 1, 0));
        this.addChild(new Text(this.theme.fg("muted", "No asynchronous Bash tasks"), 1, 0));
        this.addChild(new Text(
            this.theme.fg("dim", formatKeyHint(this.keybindings, "tui.select.cancel", "close")),
            1,
            0,
        ));
        this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.done({ action: "close" });
            return;
        }
        this.tui.requestRender();
    }
}

function formatKeyHint(
    keybindings: KeybindingsManager,
    binding: "tui.select.confirm" | "tui.select.cancel",
    action: string,
): string {
    return `${keybindings.getKeys(binding).map(formatKey).join("/")} ${action}`;
}

function formatKey(key: string): string {
    if (key === "escape") return "Esc";
    if (key === "enter") return "Enter";
    const hasModifier = key.includes("+");
    return key.split("+").map((part) => {
        if (part === "ctrl") return "Ctrl";
        if (part === "alt") return "Alt";
        if (part === "shift") return "Shift";
        if (part === "super") return "Super";
        if (part.length === 1) return hasModifier ? part.toLowerCase() : part.toUpperCase();
        return part;
    }).join("+");
}

function jobToSelectItem(job: Job): SelectItem {
    const icon = statusIcon(job);
    const duration = formatDuration(Date.now() - job.startTime);
    const label = job.name ? `${job.name} (${job.id})` : job.id;
    const status = job.status === "running" ? `running (${duration})` : job.status;
    const exitCode = job.exitCode === undefined ? "" : ` · exit ${job.exitCode}`;
    return {
        value: job.id,
        label: `${icon} ${label}`,
        description: `${job.command.slice(0, PREVIEW_CHARS.taskList)} · ${status}${exitCode}`,
    };
}

async function showOutput(job: Job, ctx: UiContext): Promise<void> {
    const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    const duration = formatDuration(Date.now() - job.startTime);
    const exitLine = job.exitCode === undefined ? "" : `\nExit code: ${job.exitCode}`;
    await ctx.ui.editor(
        `${statusIcon(job)} ${jobLabel(job)}`,
        `Command: ${job.command}\n` +
        `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
        `Duration: ${duration} · Status: ${job.status}${exitLine}\n` +
        `Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}\n\nEsc returns to the task list`,
    );
}

function getJobList(reg: BackgroundRegistry): Job[] {
    const jobs = Array.from(reg.jobs.values());
    const running = jobs.filter((job) => job.status === "running").sort((left, right) => right.startTime - left.startTime);
    const terminal = jobs.filter((job) => job.status !== "running").sort((left, right) => right.startTime - left.startTime);
    return [...running, ...terminal];
}

function statusIcon(job: Job): string {
    switch (job.status) {
        case "pending": return "◌";
        case "running": return "▶";
        case "completed": return "✓";
        case "failed": return "✗";
        case "killed": return "✗";
    }
}
