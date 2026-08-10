// Model-output: Claude Fable 5

/**
 * A1/A6/A8 behavior: chunked tokenization equals one-shot tokenization,
 * budget exhaustion falls back (with prefix caching and depth-scoped
 * fail-fast), and oversized sections stream through the splitter raw,
 * line-aligned, and byte-losslessly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "@logtape/logtape";
import { SectionSplitter, type diff_section } from "../src/diff_parser.ts";
import { init_highlighter, ensure_lang, highlight_lines, emit_sgr_lines } from "../src/highlight.ts";
import { process_section, raw_section_output } from "../src/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An independent one-shot highlighter as the chunking-correctness oracle. */
let reference: Highlighter;

beforeAll(async () => {
	await configure({
		sinks: {},
		loggers: [
			{ category: ["tig-syntax"], lowestLevel: "fatal", sinks: [] },
			{ category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
		],
	});
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
		// git.ts is ~270 lines: spans several 128-line chunks.
		const content = await readFile(join(HERE, "..", "src", "git.ts"), "utf8");
		const lines = content.split("\n");
		const ours = await highlight_lines("test|chunk-eq", "typescript", content,
						   lines.length, null);
		expect(ours).not.toBeNull();
		const one_shot = reference.codeToTokensBase(content, {
			lang: "typescript",
			theme: "one-monokai" as never,
		}) as ThemedToken[][];
		expect(ours).toEqual(emit_sgr_lines(one_shot));
	}, 60000);
});

describe("tokenization budget", () => {
	const doc = Array.from({ length: 600 }, (_, i) => `const v_${i} = ${i};`).join("\n");

	it("returns null when the deadline is already exhausted", async () => {
		const out = await highlight_lines("test|budget-a", "typescript", doc, 600,
						  performance.now() - 1);
		expect(out).toBeNull();
	});

	it("fails fast on an equally deep revisit even with budget to spare", async () => {
		const before = performance.now();
		const out = await highlight_lines("test|budget-a", "typescript", doc, 600,
						  performance.now() + 60000);
		expect(out).toBeNull();
		expect(performance.now() - before).toBeLessThan(50);
	});

	it("still attempts (and succeeds at) a shallower depth", async () => {
		const out = await highlight_lines("test|budget-a", "typescript", doc, 100,
						  performance.now() + 60000);
		expect(out).not.toBeNull();
		expect(out!.length).toBeGreaterThanOrEqual(100);
	});

	it("stops on cancellation without recording a failure depth", async () => {
		const out = await highlight_lines("test|budget-c", "typescript", doc, 600,
						  null, () => true);
		expect(out).toBeNull();
		// Cancellation is not a cost verdict: the same request must still
		// run (and succeed) when tried again uncancelled.
		const retry = await highlight_lines("test|budget-c", "typescript", doc, 600,
						    performance.now() + 60000);
		expect(retry).not.toBeNull();
		expect(retry!.length).toBe(600);
	});

	it("never shrinks a longer cached prefix on a timed-out deeper retry", async () => {
		const ok = await highlight_lines("test|budget-b", "typescript", doc, 300, null);
		expect(ok).not.toBeNull();
		// Deep retry with (nearly) no budget: may tokenize 0 or a few
		// chunks before dying — either way the 300-line entry survives.
		const dead = await highlight_lines("test|budget-b", "typescript", doc, 600,
						   performance.now() + 0.01);
		expect(dead).toBeNull();
		const shallow = await highlight_lines("test|budget-b", "typescript", doc, 250,
						      performance.now() - 1);
		expect(shallow).not.toBeNull();
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
