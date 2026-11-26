/**
 * Chunked tokenization equals one-shot tokenization, budget exhaustion
 * falls back (keeping the prefix for the next request to resume), and
 * oversized sections stream through the splitter raw, line-aligned, and
 * byte-losslessly.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { A } from "ayy";
import { readFile } from "node:fs/promises";
import { createHighlighter, type Highlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SectionSplitter, type diff_section } from "../src/diff_parser.ts";
import { init_highlighter, ensure_lang, emit_sgr_line, highlight_lines, stats, CHUNK_LINES, MAX_LINE_CHARS } from "../src/highlight.ts";
import { highlight_prefix } from "./highlight_prefix.ts";
import { process_section, raw_section_output } from "../src/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An independent one-shot highlighter as the chunking-correctness oracle.
 * Its codeToTokensBase() skips empty lines, which the daemon runs through
 * the grammar; the two agree on the TypeScript fixture, where the only
 * empty line that could change the state is a first line. */
let reference: Highlighter;

beforeAll(async () => {
	await init_highlighter();
	await ensure_lang("typescript");
	const theme = JSON.parse(await readFile(join(HERE, "..", "themes", "one-monokai.json"), "utf8"));
	theme.name = "one-monokai";
	// Match the daemon's terminal-readability override (TOKEN_COLOR_OVERRIDES
	// in highlight.ts) so reference emissions are byte-comparable.
	theme.tokenColors.find((rule: { name?: string }) => rule.name === "Comment")
		.settings.foreground = "#828c9c";
	reference = await createHighlighter({
		themes: [theme],
		langs: ["typescript"],
		engine: createOnigurumaEngine(import("shiki/wasm")),
	});
}, 60000);

describe("chunked tokenization", () => {
	it("emits exactly what one-shot tokenization emits", async () => {
		const content = await readFile(join(HERE, "..", "src", "git.ts"), "utf8");
		const lines = content.split("\n");
		// Continuation across chunks is what this test covers.
		expect(lines.length).toBeGreaterThan(2 * CHUNK_LINES);
		const ours = await highlight_prefix("test|chunk-eq", "typescript", content,
						    lines.length, null);
		expect(ours).not.toBeNull();
		const one_shot = reference.codeToTokensBase(content, {
			lang: "typescript",
			theme: "one-monokai" as never,
		});
		expect(ours).toEqual(one_shot.map(emit_sgr_line));
	}, 60000);

	it("resumes a deeper request from the cached prefix, token-identically", async () => {
		const content = await readFile(join(HERE, "..", "src", "git.ts"), "utf8");
		const lines = content.split("\n");
		// 100 is not a chunk multiple: the resume starts mid-chunk.
		const shallow = await highlight_prefix("test|resume", "typescript", content, 100, null);
		expect(shallow!.length).toBe(100);
		const before = stats.tokenized_lines;
		const deep = await highlight_prefix("test|resume", "typescript", content,
						    lines.length, null);
		expect(deep!.length).toBe(lines.length);
		expect(stats.tokenized_lines - before).toBe(lines.length - 100);
		const one_shot = reference.codeToTokensBase(content, {
			lang: "typescript",
			theme: "one-monokai" as never,
		});
		expect(deep).toEqual(one_shot.map(emit_sgr_line));
	}, 60000);
});

describe("cached line-start states", () => {
	// Line 300 sits inside a block comment opened on line 1: its rendering
	// depends on the state carried down from there.
	const doc = ["/*", ...Array.from({ length: 598 }, (_, i) => `const v_${i} = ${i};`), "*/ const x = 1;"].join("\n");
	const lines = doc.split("\n");

	it("render a line from its cached start state, and a revisit from the cached rendering", async () => {
		const deep = await highlight_lines("test|sparse", "typescript", lines, [600], null);
		expect([...deep!.keys()]).toEqual([600]);
		const tokenized = stats.tokenized_lines;
		const retokenized = stats.retokenized_lines;
		const both = await highlight_lines("test|sparse", "typescript", lines, [600, 300, 300], null);
		expect(stats.tokenized_lines).toBe(tokenized);
		expect(stats.retokenized_lines).toBe(retokenized + 1);
		const full = await highlight_prefix("test|sparse-full", "typescript", doc, 600, null);
		expect(both!.get(300)).toBe(full![299]);
		expect(both!.get(600)).toBe(full![599]);
		expect(await highlight_lines("test|sparse", "typescript", lines, [300], null)).toEqual(new Map([[300, full![299]]]));
		expect(stats.retokenized_lines).toBe(retokenized + 1);
	});

	it("ignore wanted lines past the end of the document", async () => {
		const out = await highlight_lines("test|past-end", "typescript", lines, [2, 601, 9999], null);
		expect([...out!.keys()]).toEqual([2]);
		expect(await highlight_lines("test|past-end", "typescript", lines, [601], null)).toEqual(new Map());
	});
});

/** A line comment of exactly `length` characters, which tokenizes fast
 * however long it is. */
function comment_line(length: number): string {
	return `// ${"a".repeat(length - 3)}`;
}

describe("lines of MAX_LINE_CHARS or more", () => {
	it("show in the theme's foreground and leave the grammar state as it was", async () => {
		// Tokenized, this would end the comment that line 1 opens.
		const long = `*/ ${comment_line(MAX_LINE_CHARS - 3)}`;
		const out = await highlight_lines("test|long", "typescript", ["/* open", long, "close */ x = 1;"], [2, 3], null);
		expect(out!.get(2)).toBe(emit_sgr_line([{ content: long }]));
		// Still in the comment that line 1 opened.
		const without = await highlight_lines("test|long-absent", "typescript", ["/* open", "close */ x = 1;"], [2], null);
		expect(out!.get(3)).toBe(without!.get(2));
	});

	it("start at MAX_LINE_CHARS, not before", async () => {
		const out = await highlight_lines("test|long-edge", "typescript", [comment_line(MAX_LINE_CHARS - 1)], [1], null);
		// The comment got a color of its own.
		expect(out!.get(1)).not.toBe(emit_sgr_line([{ content: comment_line(MAX_LINE_CHARS - 1) }]));
	});
});

describe("tokenization budget", () => {
	const doc = Array.from({ length: 600 }, (_, i) => `const v_${i} = ${i};`).join("\n");

	/** Lines that miss_deadline() tokenizes before the deadline passes:
	 * fewer than a chunk, since the deadline is checked before each line. */
	const LINES_BEFORE_MISS = 100;

	/** Tokenize `doc` as `key` to `depth` under a stopped clock that jumps
	 * `spent_ms` ahead, past the deadline, once LINES_BEFORE_MISS lines
	 * are done: a deterministic mid-work miss after `spent_ms` of
	 * tokenizing.  The jump rides on cancelled(), which is consulted
	 * before each line, just before the deadline. */
	async function miss_deadline(key: string, depth: number, spent_ms: number): Promise<string[] | null> {
		A.lt(LINES_BEFORE_MISS, CHUNK_LINES);
		const start = performance.now();
		let now = start;
		let lines = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			return await highlight_prefix(key, "typescript", doc, depth, start + spent_ms, () => {
				if (++lines === LINES_BEFORE_MISS + 1) {
					now = start + spent_ms + 1;
				}
				return false;
			});
		} finally {
			clock.mockRestore();
		}
	}

	it("returns null when the deadline passed before any work; a retry still runs", async () => {
		const out = await highlight_prefix("test|budget-a", "typescript", doc, 600,
						   performance.now() - 1);
		expect(out).toBeNull();
		const retry = await highlight_prefix("test|budget-a", "typescript", doc, 600,
						     performance.now() + 60000);
		expect(retry).not.toBeNull();
		expect(retry!.length).toBe(600);
	});

	it("resumes a retry after a missed deadline from the lines tokenized before it", async () => {
		expect(await miss_deadline("test|budget-d", 600, 1000)).toBeNull();
		const before = stats.tokenized_lines;
		const retry = await highlight_prefix("test|budget-d", "typescript", doc, 600,
						     performance.now() + 60000);
		expect(retry).not.toBeNull();
		expect(retry!.length).toBe(600);
		// The lines tokenized before the miss stayed cached.
		expect(stats.tokenized_lines - before).toBe(600 - LINES_BEFORE_MISS);
	});

	it("stops on cancellation; a retry still runs", async () => {
		const out = await highlight_prefix("test|budget-c", "typescript", doc, 600,
						   null, () => true);
		expect(out).toBeNull();
		const retry = await highlight_prefix("test|budget-c", "typescript", doc, 600,
						     performance.now() + 60000);
		expect(retry).not.toBeNull();
		expect(retry!.length).toBe(600);
	});

	it("never shrinks longer cached states on a timed-out deeper retry", async () => {
		const ok = await highlight_prefix("test|budget-b", "typescript", doc, 300, null);
		expect(ok).not.toBeNull();
		// Deep retry with (nearly) no budget: may tokenize 0 or a few
		// chunks before dying — either way the 300-line entry survives.
		const dead = await highlight_prefix("test|budget-b", "typescript", doc, 600,
						    performance.now() + 0.01);
		expect(dead).toBeNull();
		const before = stats.tokenized_lines;
		const shallow = await highlight_prefix("test|budget-b", "typescript", doc, 250, null);
		expect(shallow).toEqual(ok!.slice(0, 250));
		expect(stats.tokenized_lines).toBe(before);
	});
});

describe("concurrent requests for one document", () => {
	const lines = Array.from({ length: 6000 }, (_, i) => `const w_${i} = ${i};`);

	/** Start a pass rendering the last of `lines` as `key`, without
	 * waiting for it; `done` turns true once it finishes. */
	function start_deep_pass(key: string): { done: boolean, promise: Promise<unknown> } {
		const deep = { done: false, promise: Promise.resolve() as Promise<unknown> };
		deep.promise = highlight_lines(key, "typescript", lines, [lines.length], null).then(() => {
			deep.done = true;
		});
		return deep;
	}

	it("returns cached renderings without waiting for a deeper pass", async () => {
		const first = await highlight_lines("test|concurrent-cached", "typescript", lines, [1], null);
		const deep = start_deep_pass("test|concurrent-cached");
		const again = await highlight_lines("test|concurrent-cached", "typescript", lines, [1], null);
		expect(deep.done).toBe(false);
		expect(again).toEqual(first);
		await deep.promise;
	});

	it("stops waiting for a deeper pass at its own deadline", async () => {
		const deep = start_deep_pass("test|concurrent-late");
		const late = await highlight_lines("test|concurrent-late", "typescript", lines, [lines.length],
						   performance.now() + 5);
		expect(late).toBeNull();
		expect(deep.done).toBe(false);
		await deep.promise;
	});
});

/** Reassemble a section's exact input bytes. */
function section_bytes(section: diff_section): Buffer {
	return Buffer.concat(section.lines.flatMap((line) =>
		line.had_newline ? [line.bytes, Buffer.from("\n")] : [line.bytes]));
}

function build_diff(): { input: Buffer, big_bytes: number } {
	const parts: string[] = [];
	parts.push("commit 123\n\n    message\n");
	parts.push("diff --git a/small.c b/small.c\n--- a/small.c\n+++ b/small.c\n@@ -1 +1 @@\n-a\n+b\n");
	const big_lines: string[] = [];
	big_lines.push("diff --git a/big.c b/big.c\n--- a/big.c\n+++ b/big.c\n@@ -1,2000 +1,2000 @@\n");
	for (let i = 0; i < 2000; i++) {
		big_lines.push(`+line number ${i} with some padding text\n`);
	}
	const big = big_lines.join("");
	parts.push(big);
	parts.push("diff --git a/tail.c b/tail.c\n--- a/tail.c\n+++ b/tail.c\n@@ -1 +1 @@\n-x\n+y\n");
	return { input: Buffer.from(parts.join("")), big_bytes: Buffer.byteLength(big) };
}

describe("oversized section passthrough", () => {
	it("streams oversized sections without buffering, byte-losslessly", () => {
		const { input, big_bytes } = build_diff();
		const splitter = new SectionSplitter(4096);
		const sections: diff_section[] = [];
		// Feed in awkward chunk sizes to stress carry handling.
		for (let off = 0; off < input.length; off += 1237) {
			sections.push(...splitter.feed(input.subarray(off, off + 1237)));
		}
		sections.push(...splitter.finish());

		const kinds = sections.map((s) => s.kind);
		expect(kinds[0]).toBe("preamble");
		expect(kinds[1]).toBe("file");           // small.c
		expect(kinds).toContain("oversized");    // big.c streams
		expect(kinds[kinds.length - 1]).toBe("file"); // tail.c intact
		// big.c became multiple oversized sections (streaming, not one buffer)
		const oversized = sections.filter((s) => s.kind === "oversized");
		expect(oversized.length).toBeGreaterThan(1);
		expect(oversized.reduce((n, s) => n + s.byte_length, 0)).toBe(big_bytes);
		// every oversized line is complete (line-aligned frames)
		for (const s of oversized) {
			for (const line of s.lines) {
				expect(line.had_newline).toBe(true);
			}
		}
		// lossless reassembly
		const rebuilt = Buffer.concat(sections.map(section_bytes));
		expect(rebuilt.equals(input)).toBe(true);
		// byte_length totals cover the whole input
		expect(sections.reduce((n, s) => n + s.byte_length, 0)).toBe(input.length);
	});

	it("streams sections of too many lines the same way", () => {
		const { input, big_bytes } = build_diff();
		const splitter = new SectionSplitter(Infinity, 100);
		const sections = [...splitter.feed(input), ...splitter.finish()];
		expect(sections.map((s) => s.kind)).toEqual(["preamble", "file", "oversized", "oversized", "file"]);
		// big.c was buffered until its 101st line.
		expect(sections[2]!.lines.length).toBe(101);
		expect(sections[2]!.byte_length + sections[3]!.byte_length).toBe(big_bytes);
	});

	it("passes oversized sections through process_section raw", async () => {
		const { input } = build_diff();
		const splitter = new SectionSplitter(4096);
		const sections = [...splitter.feed(input), ...splitter.finish()];
		for (const section of sections.filter((s) => s.kind === "oversized")) {
			const out = await process_section("/nonexistent", section);
			expect(out.equals(raw_section_output(section))).toBe(true);
		}
	});

	it("emits everything as one file section when under the threshold", () => {
		const { input } = build_diff();
		const splitter = new SectionSplitter();
		const sections = [...splitter.feed(input), ...splitter.finish()];
		expect(sections.map((s) => s.kind)).toEqual(["preamble", "file", "file", "file"]);
	});
});
