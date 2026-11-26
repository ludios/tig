/**
 * An empty line runs through the grammar, as in VS Code, so the lines
 * after it start from the state that it leaves.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { init_highlighter, ensure_lang } from "../src/highlight.ts";
import { highlight_prefix } from "./highlight_prefix.ts";

beforeAll(async () => {
	await init_highlighter();
	await ensure_lang("markdown");
}, 60000);

describe("empty lines", () => {
	it("end a Markdown paragraph, so an indented line after one is a code block", async () => {
		const indented = "    code();";
		const after_empty = await highlight_prefix("test|empty-line", "markdown",
							   `Paragraph.\n\n${indented}`, 3, null);
		const continuation = await highlight_prefix("test|no-empty-line", "markdown",
							    `Paragraph.\n${indented}`, 2, null);
		expect(after_empty![1]).toBe("\x1b[0m");
		// Directly after the paragraph's line, the indented line continues
		// the paragraph, in the paragraph's color.
		expect(continuation![1]).toContain(indented);
		expect(after_empty![2]).toContain(indented);
		expect(after_empty![2]).not.toBe(continuation![1]);
	});
});
