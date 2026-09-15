import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { renderBashAsyncCall } from "../render.ts";

const theme = {
    fg: (color: "muted" | "toolTitle", text: string) => `[${color}:${text}]`,
    bold: (text: string) => `*${text}*`,
};

test("renders an async command without its name", () => {
    const component = renderBashAsyncCall(
        { command: "echo hello", name: "greeting" },
        theme,
        {},
    );
    const output = renderedText(component);

    assert.equal(output, "[toolTitle:*$ echo hello*]");
    assert.doesNotMatch(output, /greeting/);
});

test("renders an async command with a timeout", () => {
    const component = renderBashAsyncCall(
        { command: "pnpm test", timeout: 30 },
        theme,
        {},
    );

    assert.equal(
        renderedText(component),
        "[toolTitle:*$ pnpm test*][muted: (timeout 30s)]",
    );
});

test("omits the timeout suffix when timeout is absent", () => {
    const component = renderBashAsyncCall({ command: "pnpm check" }, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ pnpm check*]");
});

test("omits the timeout suffix when timeout is not positive", () => {
    for (const timeout of [0, -5]) {
        const component = renderBashAsyncCall(
            { command: "pnpm check", timeout },
            theme,
            {},
        );

        assert.equal(renderedText(component), "[toolTitle:*$ pnpm check*]");
    }
});

test("renders missing arguments with an ellipsis", () => {
    const component = renderBashAsyncCall(undefined, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ *][muted:...]");
});

test("renders a whitespace-only command with an ellipsis", () => {
    const component = renderBashAsyncCall({ command: "  " }, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ *][muted:...]");
});

test("reuses and updates the last component", () => {
    const firstComponent = renderBashAsyncCall(
        { command: "echo first" },
        theme,
        {},
    );
    const secondComponent = renderBashAsyncCall(
        { command: "echo second" },
        theme,
        { lastComponent: firstComponent },
    );

    assert.strictEqual(secondComponent, firstComponent);
    assert.equal(renderedText(secondComponent), "[toolTitle:*$ echo second*]");
});

test("replaces a foreign cached component", () => {
    const foreignComponent = {};
    const component = renderBashAsyncCall(
        { command: "echo fresh" },
        theme,
        { lastComponent: foreignComponent as unknown as Text },
    );

    assert.ok(component instanceof Text);
    assert.notStrictEqual(component, foreignComponent);
    assert.equal(renderedText(component), "[toolTitle:*$ echo fresh*]");
});

test("renders wide glyphs", () => {
    const component = renderBashAsyncCall(
        { command: "echo 你好 🎉" },
        theme,
        {},
    );

    assert.equal(renderedText(component), "[toolTitle:*$ echo 你好 🎉*]");
});

function renderedText(component: Text): string {
    return component.render(200).map((line) => line.trimEnd()).join("\n");
}
