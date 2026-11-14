/**
 * Loading a language can make shiki rebuild a grammar that is already
 * loaded: markdown embeds python and rust lazily, so loading either one
 * rebuilds markdown.  Neither a cached prefix nor a tokenization in
 * progress may then resume from a grammar state of the old grammar.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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

/** A Markdown document over three chunks long, with a fenced block of
 * `fence_lang` code in its first and in its last chunk. */
async function markdown_doc(fence_lang: string): Promise<string> {
	const readme = await readFile(join(HERE, "..", "README.md"), "utf8");
	const fence = `\`\`\`${fence_lang}\nfn main() { let x = "a"; }\n\`\`\`\n`;
	let body = "";
	while (body.split("\n").length < 3 * CHUNK_LINES) {
		body += readme + "\n";
	}
	return `# Title\n\nSome *text*, and\n${fence}\n${body}\n${fence}`;
}

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("markdown"), "shiki has no markdown grammar");
}, 60000);

describe("a grammar rebuilt by a language load", () => {
	it("is not resumed from a cached prefix of the old grammar", async () => {
		const doc = await markdown_doc("python");
		const depth = doc.split("\n").length;
		// Cache a prefix, with its grammar state, under the old grammar.
		expect(await highlight_lines("test|rebuilt-cached", "markdown", doc, 4, null)).toHaveLength(4);
		expect(await ensure_lang("python")).toBe(true);
		const resumed = await highlight_lines("test|rebuilt-cached", "markdown", doc, depth, null);
		const fresh = await highlight_lines("test|rebuilt-fresh", "markdown", doc, depth, null);
		expect(fresh).not.toBeNull();
		expect(resumed).toEqual(fresh);
	}, 60000);

	it("restarts a tokenization in progress", async () => {
		const doc = await markdown_doc("rust");
		const depth = doc.split("\n").length;
		const restarts = stats.grammar_restarts;
		between_chunks.hook = () => ensure_lang("rust");
		const ours = await highlight_lines("test|rebuilt-inflight", "markdown", doc, depth, null);
		expect(between_chunks.hook).toBeNull();
		expect(stats.grammar_restarts).toBe(restarts + 1);
		const fresh = await highlight_lines("test|rebuilt-inflight-fresh", "markdown", doc, depth, null);
		expect(fresh).not.toBeNull();
		expect(ours).toEqual(fresh);
	}, 60000);
});
