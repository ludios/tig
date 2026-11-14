/**
 * Loading a language can make shiki rebuild a grammar that is already
 * loaded: markdown embeds python, rust and ruby lazily, so loading any of
 * them rebuilds markdown.  Lines and grammar states cached under the old
 * grammar must then go unused, and a tokenization in progress must start
 * over.  Each test loads a different language, as a load happens once.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type * as timers_promises from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { A } from "ayy";
import { init_highlighter, ensure_lang, highlight_lines, stats, CHUNK_LINES } from "../src/highlight.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run by the next yield between two chunks of a tokenization, if set. */
const between_chunks = vi.hoisted(() => ({ hook: null as (() => Promise<unknown>) | null }));

vi.mock("node:timers/promises", async (import_original) => {
	const original = await import_original<typeof timers_promises>();
	return {
		...original,
		setImmediate: async () => {
			const hook = between_chunks.hook;
			between_chunks.hook = null;
			if (hook !== null) {
				await hook();
			}
			return original.setImmediate();
		},
	};
});

/** Line 5 of markdown_doc(): the code inside its first fenced block. */
const FIRST_CODE_LINE = 5;

/** A Markdown document over three chunks long, with two fenced blocks of
 * `code` in `fence_lang`: one at FIRST_CODE_LINE and one at the end. */
async function markdown_doc(fence_lang: string, code: string): Promise<string> {
	const readme = await readFile(join(HERE, "..", "README.md"), "utf8");
	const fence = `\`\`\`${fence_lang}\n${code}\n\`\`\`\n`;
	let body = "";
	while (body.split("\n").length < 3 * CHUNK_LINES) {
		body += readme + "\n";
	}
	return `# Title\n\nSome *text*, and\n${fence}\n${body}\n${fence}`;
}

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("markdown"), "the markdown grammar failed to load");
}, 60000);

afterEach(() => {
	between_chunks.hook = null;
});

describe("a grammar rebuilt by a language load", () => {
	it("leaves the lines and states cached under the old grammar unused", async () => {
		const doc = await markdown_doc("python", "print(\"a\")");
		const depth = doc.split("\n").length;
		// Under the old grammar, cache a prefix that a deeper request
		// would resume from, and one that covers the first code block.
		expect(await highlight_lines("test|rebuilt-prefix", "markdown", doc, 4, null)).toHaveLength(4);
		const before = await highlight_lines("test|rebuilt-covered", "markdown", doc, FIRST_CODE_LINE, null);
		expect(await ensure_lang("python")).toBe(true);
		const fresh = await highlight_lines("test|rebuilt-fresh", "markdown", doc, depth, null);
		expect(fresh).not.toBeNull();
		// The python code got colors of its own.
		expect(fresh![FIRST_CODE_LINE - 1]).not.toBe(before![FIRST_CODE_LINE - 1]);
		expect(await highlight_lines("test|rebuilt-covered", "markdown", doc, FIRST_CODE_LINE, null))
			.toEqual(fresh!.slice(0, FIRST_CODE_LINE));
		expect(await highlight_lines("test|rebuilt-prefix", "markdown", doc, depth, null)).toEqual(fresh);
	}, 60000);

	it("restarts a tokenization in progress, even one resumed from a cached prefix", async () => {
		const doc = await markdown_doc("rust", "let x = \"a\";");
		const depth = doc.split("\n").length;
		expect(await highlight_lines("test|rebuilt-inflight", "markdown", doc, 4, null)).toHaveLength(4);
		const restarts = stats.grammar_restarts;
		between_chunks.hook = () => ensure_lang("rust");
		const ours = await highlight_lines("test|rebuilt-inflight", "markdown", doc, depth, null);
		expect(between_chunks.hook).toBeNull();
		expect(stats.grammar_restarts).toBe(restarts + 1);
		const fresh = await highlight_lines("test|rebuilt-inflight-fresh", "markdown", doc, depth, null);
		expect(fresh).not.toBeNull();
		expect(ours).toEqual(fresh);
	}, 60000);

	it("caches the lines that a restarted tokenization got through before a cancellation", async () => {
		const doc = await markdown_doc("ruby", "puts \"a\"");
		const depth = doc.split("\n").length;
		const restarts = stats.grammar_restarts;
		between_chunks.hook = () => ensure_lang("ruby");
		// Cancelled before its third chunk: the first went to the old
		// grammar, the second, after the restart, to the new one.
		let checks = 0;
		const cancelled = (): boolean => ++checks === 3;
		expect(await highlight_lines("test|rebuilt-cancelled", "markdown", doc, depth, null, cancelled)).toBeNull();
		expect(stats.grammar_restarts).toBe(restarts + 1);
		const tokenized = stats.tokenized_lines;
		const resumed = await highlight_lines("test|rebuilt-cancelled", "markdown", doc, depth, null);
		// The new grammar's first chunk was cached and not tokenized again.
		expect(stats.tokenized_lines - tokenized).toBe(depth - CHUNK_LINES);
		const fresh = await highlight_lines("test|rebuilt-cancelled-fresh", "markdown", doc, depth, null);
		expect(fresh).not.toBeNull();
		expect(resumed).toEqual(fresh);
	}, 60000);
});
