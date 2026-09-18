// src/output.ts
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { FOREGROUND_TAIL_BYTES, MAX_LOG_BYTES } from "./types.ts";

export const NO_OUTPUT_YET = "(no output yet)";

export interface LogSnapshot {
    content: string;
    byteLength: number;
}

/**
 * Read the tail of a log file, bounded by maxChars. Only the last maxChars
 * bytes are read (O(maxChars), not O(fileSize)). Opens once and fstats the
 * descriptor — no separate path-stat, so no stat-then-read race.
 */
export function readBoundedTail(logPath: string, maxChars: number): string {
    let fd: number;
    try {
        fd = openSync(logPath, "r");
    } catch {
        return NO_OUTPUT_YET;
    }
    try {
        const { size } = fstatSync(fd);
        if (size === 0) return NO_OUTPUT_YET;
        const toRead = Math.min(size, maxChars);
        const buf = Buffer.alloc(toRead);
        readSync(fd, buf, 0, toRead, Math.max(0, size - toRead));
        const body = buf.toString("utf-8");
        return size > maxChars
            ? `...[truncated, showing last ${maxChars} chars]\n${body}`
            : body;
    } catch {
        return NO_OUTPUT_YET;
    } finally {
        try { closeSync(fd); } catch { /* best effort */ }
    }
}

/**
 * Read the current log snapshot from one open descriptor. fstat runs after
 * opening, so the size and bytes come from the same file and avoid a
 * path-stat race.
 */
export function readFullLogSnapshot(logPath: string): LogSnapshot {
    let fd: number;
    try {
        fd = openSync(logPath, "r");
    } catch {
        return { content: NO_OUTPUT_YET, byteLength: 0 };
    }

    try {
        const { size } = fstatSync(fd);
        if (size === 0) return { content: NO_OUTPUT_YET, byteLength: 0 };
        const buffer = Buffer.allocUnsafe(Math.min(size, MAX_LOG_BYTES));
        const start = Math.max(0, size - buffer.length);
        let offset = 0;
        while (offset < buffer.length) {
            const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset === 0) return { content: NO_OUTPUT_YET, byteLength: 0 };
        const content = buffer.toString("utf8", 0, offset);
        return {
            content: size > MAX_LOG_BYTES
                ? `(log exceeds the ${MAX_LOG_BYTES / (1024 * 1024)} MiB viewer limit; showing its newest content)\n${content}`
                : content,
            byteLength: size,
        };
    } catch {
        return { content: NO_OUTPUT_YET, byteLength: 0 };
    } finally {
        try { closeSync(fd); } catch { /* best effort */ }
    }
}

/** Follow bytes appended after a snapshot. The descriptor remains open so no
 * path-stat operation can race with the read. */
export function followAppendedLog(
    logPath: string,
    initialOffset: number,
    onAppend: (text: string, replaced: boolean) => void,
    intervalMs = 250,
): { stop: () => void } {
    let fd: number | undefined;
    let offset = initialOffset;
    let stopped = false;
    let decoder = new StringDecoder("utf8");

    const tick = () => {
        if (stopped) return;
        try {
            fd ??= openSync(logPath, "r");
            const { size } = fstatSync(fd);
            const replaced = size < offset;
            if (replaced) {
                offset = 0;
                decoder = new StringDecoder("utf8");
            }

            let appended = "";
            while (offset < size) {
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
                const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
                if (bytesRead === 0) break;
                offset += bytesRead;
                appended += decoder.write(buffer.subarray(0, bytesRead));
            }
            if (appended) onAppend(appended, replaced);
        } catch {
            if (fd !== undefined) {
                try { closeSync(fd); } catch { /* retry on the next tick */ }
                fd = undefined;
            }
        }
    };

    const timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
            if (fd !== undefined) {
                try { closeSync(fd); } catch { /* best effort */ }
            }
        },
    };
}

// Terminal escape/control sequences stripped from a progress line so the
// sidebar shows clean text and crafted job output cannot inject escapes. The
// leading \u001b (ESC) is essential — without it these would eat literal
// `[...]`/`]...` like JSON.
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// Remaining C0/C1 control chars and DEL (newlines handled by the split).
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The last non-empty line of a log's tail, ANSI-stripped — used to show live
 * progress in the sidebar. Reads only the trailing bytes (cheap per tick), and
 * collapses `\r` progress-bar redraws to their final segment. Returns "" when
 * there's no output yet.
 */
export function readLastLine(logPath: string, scanBytes = 2_048): string {
    const tail = readBoundedTail(logPath, scanBytes);
    if (tail === "(no output yet)") return "";
    const lines = tail.replace(ANSI_CSI, "").replace(ANSI_OSC, "").split(/[\r\n]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].replace(CONTROL_CHARS, "").replace(/\t/g, " ").trim();
        if (line.length > 0) return line;
    }
    return "";
}

/**
 * Poll a log file tail at `intervalMs` (default 1000ms). Calls `onUpdate`
 * only when content changes. Returns a handle with `stop()`.
 *
 * This is the Claude Code pattern: the file is written to by the child
 * process via file descriptor. We poll the tail for progress display.
 */
export function pollFileTail(
    logPath: string,
    onUpdate: (text: string) => void,
    intervalMs = 1_000
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    let stopped = false;

    const timer = setTimeout(function tick() {
        if (stopped) return;
        try {
            const { size } = statSync(logPath);
            if (size === lastSize) {
                timer.refresh();
                return;
            }
            lastSize = size;
            const fd = openSync(logPath, "r");
            try {
                const readStart = Math.max(0, size - FOREGROUND_TAIL_BYTES);
                const toRead = Math.min(size, FOREGROUND_TAIL_BYTES);
                const buf = Buffer.alloc(toRead);
                readSync(fd, buf, 0, toRead, readStart);
                const content = buf.toString("utf-8", 0, toRead);
                if (content && content !== lastContent) {
                    lastContent = content;
                    onUpdate(content);
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            // File not yet created or locked — retry next tick.
        }
        if (!stopped) timer.refresh();
    }, intervalMs);
    (timer as NodeJS.Timeout).unref();

    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
        },
    };
}

/** A tool's streaming-update callback (text-only partial results). */
export type ToolTextUpdate = (update: {
    content: { type: "text"; text: string }[];
    details: undefined;
}) => void;

/**
 * Stream a log file's live tail into a tool's onUpdate callback — the shared
 * "show live output while a job runs" mechanic shared by `bash` and
 * `bash_async_list attach`. Returns the poller's stop handle.
 */
export function streamLog(
    logPath: string,
    onUpdate: ToolTextUpdate | undefined
): { stop: () => void } {
    return pollFileTail(logPath, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: undefined });
    });
}
