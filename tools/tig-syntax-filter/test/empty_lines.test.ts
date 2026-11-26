/**
 * An empty line runs through the grammar, as in VS Code, so the next line
 * starts from the state that the empty line leaves.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { A } from "ayy";
import { init_highlighter, ensure_lang, highlight_lines } from "../src/highlight.ts";
import { highlight_prefix } from "./highlight_prefix.ts";

/** A line that Markdown takes for a code block, except where it continues
 * a paragraph. */
const INDENTED = "    code();";

/**
 * @param identity  A content identity for `content`, as for
 *                  highlight_lines().
 * @param lang      A loaded language.
 * @param content   A document.
 * @returns         The rendering of the document's last line, requested
 *                  alone, as a diff with no context requests it.
 */
async function last_line(identity: string, lang: string, content: string): Promise<string> {
	const lines = content.split("\n");
	const sgr = await highlight_lines(identity, lang, lines, [lines.length], null);
	A(sgr !== null, "highlight_lines() gave up without a deadline");
	return sgr.get(lines.length)!;
}

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("markdown"), "the markdown grammar failed to load");
	A(await ensure_lang("javascript"), "the javascript grammar failed to load");
}, 60000);

describe("empty lines", () => {
	it("render as a lone reset", async () => {
		const sgr = await highlight_prefix("test|empty|rendered", "markdown", `Paragraph.\n\n${INDENTED}`, 3, null);
		expect(sgr![1]).toBe("\x1b[0m");
	});

	it("end a Markdown paragraph: a four-space-indented line after one is a code block", async () => {
		const code_block = await last_line("test|empty|block", "markdown", INDENTED);
		const continuation = await last_line("test|empty|continuation", "markdown", `Paragraph.\n${INDENTED}`);
		// Directly after the paragraph's line, the indented line continues
		// the paragraph.
		expect(continuation).not.toBe(code_block);
		expect(await last_line("test|empty|after", "markdown", `Paragraph.\n\n${INDENTED}`)).toBe(code_block);
	});

	it("keep a state that an empty line does not end", async () => {
		const comment = await last_line("test|empty|comment", "markdown", "<!--\nhidden");
		expect(comment).not.toBe(await last_line("test|empty|prose", "markdown", "hidden"));
		expect(await last_line("test|empty|comment-after", "markdown", "<!--\n\nhidden")).toBe(comment);
	});

	it("make the second line not the first: a shebang there is not one", async () => {
		const shebang = "#!/usr/bin/env node";
		const first = await last_line("test|empty|shebang-first", "javascript", shebang);
		const second = await last_line("test|empty|shebang-second", "javascript", `\n${shebang}`);
		expect(second).not.toBe(first);
	});
});
