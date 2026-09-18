/** Async Bash task manager for `/bash-async-list`. */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, sliceByColumn, Text, truncateToWidth, visibleWidth, type Component, type KeybindingsManager, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import type { Job, UiContext } from "./types.ts";
import { MAX_LOG_BYTES, PREVIEW_CHARS } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration, jobLabel } from "./format.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { followAppendedLog, readFullLogSnapshot } from "./output.ts";

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
    const snapshot = readFullLogSnapshot(job.logPath);
    await (ctx.ui.custom?.<void>((tui, theme, _keybindings, done) =>
        new OutputViewerComponent(job, snapshot.content, tui, theme, done, snapshot.byteLength, job.logPath),
    {
        overlay: true,
        overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: "100%",
            margin: 0,
        },
    }) ?? Promise.resolve());
}

type OutputViewerLayout = {
    metadataRows: number;
    outputRows: number;
    showBottomBorder: boolean;
    showFooter: boolean;
    showTopBorder: boolean;
};

export class OutputViewerComponent extends Container {
    private readonly job: Job;
    private readonly outputLines: string[];
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly done: () => void;
    private readonly topBorder: DynamicBorder;
    private readonly bottomBorder: DynamicBorder;
    private verticalOffset = 0;
    private horizontalOffset = 0;
    private pendingGoToTop = false;
    private viewportWidth: number;
    private autoFollow = true;
    private replaceOnFirstAppend: boolean;
    private retainedBytes: number;
    private disposed = false;
    private readonly maxRetainedBytes: number;
    private readonly stopFollowing: () => void;

    constructor(
        job: Job,
        output: string,
        tui: TUI,
        theme: Theme,
        done: () => void,
        initialOffset?: number,
        logPath?: string,
        maxRetainedBytes = MAX_LOG_BYTES,
    ) {
        super();
        this.job = job;
        this.outputLines = output.split("\n");
        this.retainedBytes = Buffer.byteLength(output);
        this.maxRetainedBytes = maxRetainedBytes;
        this.trimRetainedOutput();
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.topBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
        this.bottomBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
        this.viewportWidth = Math.max(1, tui.terminal.columns);
        this.verticalOffset = this.maximumVerticalOffset();
        this.replaceOnFirstAppend = initialOffset === 0;
        const follower = initialOffset === undefined || logPath === undefined
            ? undefined
            : followAppendedLog(logPath, initialOffset, (appended, replaced) => {
                if (replaced || this.replaceOnFirstAppend) {
                    this.replaceOutput(appended);
                    this.replaceOnFirstAppend = false;
                } else {
                    this.appendOutput(appended);
                }
                if (this.autoFollow) this.scrollToBottom();
                else this.requestRender();
            });
        this.stopFollowing = () => follower?.stop();
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.dispose();
            this.done();
            return;
        }

        if (matchesKey(data, "g")) {
            if (this.pendingGoToTop) {
                this.verticalOffset = 0;
                this.autoFollow = false;
                this.pendingGoToTop = false;
                this.requestRender();
            } else {
                this.pendingGoToTop = true;
            }
            return;
        }

        this.pendingGoToTop = false;
        if (matchesKey(data, Key.home)) return this.scrollToTop();
        if (matchesKey(data, Key.end) || matchesKey(data, Key.shift("g"))) return this.scrollToBottom();
        if (matchesKey(data, Key.up) || matchesKey(data, "k")) return this.moveVertically(-1);
        if (matchesKey(data, Key.down) || matchesKey(data, "j")) return this.moveVertically(1);
        if (matchesKey(data, Key.left) || matchesKey(data, "h")) return this.moveHorizontally(-1);
        if (matchesKey(data, Key.right) || matchesKey(data, "l")) return this.moveHorizontally(1);
        if (matchesKey(data, Key.pageUp) || matchesKey(data, "u")) return this.moveVertically(-this.outputViewportRows());
        if (matchesKey(data, Key.pageDown) || matchesKey(data, "d")) return this.moveVertically(this.outputViewportRows());
    }

    render(width: number): string[] {
        this.viewportWidth = Math.max(1, width);
        const layout = this.layout();
        this.clampOffsets();
        const metadata = this.metadataLines()
            .slice(0, layout.metadataRows)
            .map((line) => truncateToWidth(line, this.viewportWidth));
        const output = this.padOutputRows(
            this.outputLines
                .slice(this.verticalOffset, this.verticalOffset + layout.outputRows)
                .map((line) => sliceByColumn(line, this.horizontalOffset, this.viewportWidth, true)),
            layout,
        );
        const footer = this.theme.fg(
            "dim",
            "↑↓/jk scroll · ←→/hl horizontal · Home/End or gg/G · PgUp/PgDn or u/d · Esc back",
        );
        return [
            ...(layout.showTopBorder ? this.topBorder.render(this.viewportWidth) : []),
            ...metadata,
            ...output,
            ...(layout.showFooter ? [truncateToWidth(footer, this.viewportWidth)] : []),
            ...(layout.showBottomBorder ? this.bottomBorder.render(this.viewportWidth) : []),
        ];
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopFollowing();
    }

    private appendOutput(appended: string): void {
        const lines = appended.split("\n");
        this.outputLines[this.outputLines.length - 1] += lines.shift() ?? "";
        this.outputLines.push(...lines);
        this.retainedBytes += Buffer.byteLength(appended);
        this.preserveViewportAfterTrim(this.trimRetainedOutput());
    }

    private replaceOutput(output: string): void {
        this.outputLines.splice(0, this.outputLines.length, ...output.split("\n"));
        this.retainedBytes = Buffer.byteLength(output);
        this.preserveViewportAfterTrim(this.trimRetainedOutput());
    }

    private trimRetainedOutput(): number {
        let removedLines = 0;
        while (this.retainedBytes > this.maxRetainedBytes && this.outputLines.length > 1) {
            this.retainedBytes -= Buffer.byteLength(this.outputLines.shift()!) + 1;
            removedLines++;
        }
        if (this.retainedBytes > this.maxRetainedBytes) {
            const onlyLine = Buffer.from(this.outputLines[0]);
            this.outputLines[0] = onlyLine.subarray(-this.maxRetainedBytes).toString("utf8");
            this.retainedBytes = Buffer.byteLength(this.outputLines[0]);
        }
        return removedLines;
    }

    private preserveViewportAfterTrim(removedLines: number): void {
        if (!this.autoFollow) this.verticalOffset = Math.max(0, this.verticalOffset - removedLines);
    }

    private padOutputRows(output: string[], layout: OutputViewerLayout): string[] {
        if (!layout.showTopBorder || !layout.showFooter || !layout.showBottomBorder) return output;
        return [...output, ...Array<string>(layout.outputRows - output.length).fill("")];
    }

    private metadataLines(): string[] {
        const duration = formatDuration(Date.now() - this.job.startTime);
        const exitCode = this.job.exitCode === undefined ? "" : ` · Exit code: ${this.job.exitCode}`;
        return [
            this.theme.fg("accent", this.theme.bold(`${statusIcon(this.job)} ${jobLabel(this.job)}`)),
            `Command: ${this.job.command}`,
            `PID: ${this.job.pid} · Started: ${new Date(this.job.startTime).toLocaleString()}`,
            `Duration: ${duration} · Status: ${this.job.status}${exitCode}`,
            `Log: ${this.job.logPath}`,
            "--- OUTPUT ---",
        ];
    }

    private outputViewportRows(): number {
        return this.layout().outputRows;
    }

    private layout(): OutputViewerLayout {
        const budget = Math.max(1, this.tui.terminal.rows);
        if (budget < 3) {
            return { metadataRows: 0, outputRows: 1, showBottomBorder: false, showFooter: false, showTopBorder: false };
        }
        if (budget === 3) {
            return { metadataRows: 0, outputRows: 1, showBottomBorder: true, showFooter: false, showTopBorder: true };
        }
        if (budget === 4) {
            return { metadataRows: 0, outputRows: 1, showBottomBorder: true, showFooter: true, showTopBorder: true };
        }

        const contentRows = budget - 3;
        const metadataRows = Math.min(this.metadataLines().length, contentRows - 1);
        return {
            metadataRows,
            outputRows: contentRows - metadataRows,
            showBottomBorder: true,
            showFooter: true,
            showTopBorder: true,
        };
    }

    private moveVertically(delta: number): void {
        this.verticalOffset += delta;
        this.clampOffsets();
        this.autoFollow = this.verticalOffset === this.maximumVerticalOffset();
        this.requestRender();
    }

    private moveHorizontally(delta: number): void {
        this.horizontalOffset += delta;
        this.clampOffsets();
        this.requestRender();
    }

    private scrollToTop(): void {
        this.verticalOffset = 0;
        this.autoFollow = false;
        this.requestRender();
    }

    private scrollToBottom(): void {
        this.verticalOffset = this.maximumVerticalOffset();
        this.autoFollow = true;
        this.requestRender();
    }

    private clampOffsets(): void {
        this.verticalOffset = Math.max(0, Math.min(this.verticalOffset, this.maximumVerticalOffset()));
        this.horizontalOffset = Math.max(0, Math.min(this.horizontalOffset, this.maximumHorizontalOffset()));
    }

    private maximumVerticalOffset(): number {
        return Math.max(0, this.outputLines.length - this.outputViewportRows());
    }

    private maximumHorizontalOffset(): number {
        const widestLine = Math.max(0, ...this.outputLines.map((line) => visibleWidth(line)));
        return Math.max(0, widestLine - this.viewportWidth);
    }

    private requestRender(): void {
        this.tui.requestRender();
    }
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
