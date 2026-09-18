// src/__tests__/output.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `pi-bg-output-test-${process.pid}`);

describe("readBoundedTail", () => {
    test("reads small file entirely", async () => {
        const { readBoundedTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "small.log");
        writeFileSync(p, "hello\nworld\n");
        const result = readBoundedTail(p, 1000);
        assert.equal(result, "hello\nworld\n");
        unlinkSync(p);
    });

    test("truncates large file to tail", async () => {
        const { readBoundedTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "large.log");
        const content = "x".repeat(10_000);
        writeFileSync(p, content);
        const result = readBoundedTail(p, 100);
        assert.ok(result.length <= 200); // truncation marker + 100 chars
        assert.ok(result.includes("truncated"));
        unlinkSync(p);
    });

    test("returns fallback for missing file", async () => {
        const { readBoundedTail } = await import("../output.ts");
        const result = readBoundedTail("/nonexistent/file.log", 1000);
        assert.equal(result, "(no output yet)");
    });
});

describe("readFullLogSnapshot", () => {
    test("returns a complete log larger than the preview limit", async () => {
        const { readFullLogSnapshot } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "full.log");
        const content = `BEGIN\n${"x".repeat(12_001)}\nEND\n`;
        writeFileSync(p, content);

        const snapshot = readFullLogSnapshot(p);

        assert.equal(snapshot.content, content);
        assert.equal(snapshot.byteLength, Buffer.byteLength(content));
        assert.doesNotMatch(snapshot.content, /\[truncated/);
        unlinkSync(p);
    });

    test("uses the same fallback for missing and empty logs", async () => {
        const { NO_OUTPUT_YET, readFullLogSnapshot } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "empty.log");
        writeFileSync(p, "");

        assert.equal(readFullLogSnapshot("/nonexistent/file.log").content, NO_OUTPUT_YET);
        assert.equal(readFullLogSnapshot(p).content, NO_OUTPUT_YET);
        unlinkSync(p);
    });

    test("uses the same fallback when reading the log fails", async () => {
        const { NO_OUTPUT_YET, readFullLogSnapshot } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "log-directory");
        mkdirSync(p, { recursive: true });

        assert.equal(readFullLogSnapshot(p).content, NO_OUTPUT_YET);
    });
});

describe("pollFileTail", () => {
    test("calls onUpdate when file grows", async () => {
        const { pollFileTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "poll.log");
        writeFileSync(p, "");

        const updates: string[] = [];
        const poller = pollFileTail(p, (text) => updates.push(text), 50);

        appendFileSync(p, "line 1\n");
        await new Promise((r) => setTimeout(r, 200));
        appendFileSync(p, "line 2\n");
        await new Promise((r) => setTimeout(r, 200));

        poller.stop();
        assert.ok(updates.length >= 1, `expected updates, got ${updates.length}`);
        unlinkSync(p);
    });
});
