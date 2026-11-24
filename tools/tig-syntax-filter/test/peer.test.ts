/**
 * highlight_sides() renders both sides of a diff exactly as independent
 * passes over each side would, while copying one side's line-start
 * states into the other wherever the two documents are equal, whichever
 * side goes first, and even when the claimed alignment is wrong.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fc from "fast-check";
import { A } from "ayy";
import { init_highlighter, ensure_lang, highlight_lines, highlight_sides, stats } from "../src/highlight.ts";
import type { aligned_run } from "../src/diff_parser.ts";

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("typescript"), "the typescript grammar failed to load");
}, 60000);

/** Lines whose grammar states reach across lines: comments, template
 * strings and blocks that open on one line and close on another. */
const LINE_POOL = [
	"const a = 1;",
	"/* a comment starts",
	"still in it",
	"it ends */ let b = 2;",
	"const t = `a template ${x}",
	"goes on`;",
	"function f() {",
	"}",
	"",
	"// a line comment",
	"let s = 'string';",
	"if (x) {",
	"} else {",
	"x = y / 2; // division",
	"re = /ab+c/g;",
];

/** One edit to a document: at old line index `at` (0-based), delete
 * `deleted` lines and insert `inserted` ones. */
interface edit {
	at: number,
	deleted: number,
	inserted: string[],
}

/**
 * Apply `edits` (sorted, non-overlapping) to `old_lines`.
 *
 * @returns The new lines, and the runs of lines the edits left unchanged,
 *          the last one running to the end (count Infinity) as a diff
 *          parser's would.
 */
function apply_edits(old_lines: string[], edits: edit[]): { new_lines: string[], aligned: aligned_run[] } {
	const new_lines: string[] = [];
	const aligned: aligned_run[] = [];
	let old_i = 0;
	for (const { at, deleted, inserted } of edits) {
		if (at > old_i) {
			aligned.push({ old_start: old_i + 1, new_start: new_lines.length + 1, count: at - old_i });
			new_lines.push(...old_lines.slice(old_i, at));
		}
		new_lines.push(...inserted);
		old_i = at + deleted;
	}
	aligned.push({ old_start: old_i + 1, new_start: new_lines.length + 1, count: Infinity });
	new_lines.push(...old_lines.slice(old_i));
	return { new_lines, aligned };
}

const line_arb = fc.constantFrom(...LINE_POOL);

const case_arb = fc.record({
	old_lines: fc.array(line_arb, { minLength: 1, maxLength: 60 }),
	raw_edits: fc.array(fc.record({
		at: fc.nat(),
		deleted: fc.nat({ max: 4 }),
		inserted: fc.array(line_arb, { maxLength: 4 }),
	}), { maxLength: 4 }),
	old_first: fc.boolean(),
	wrong_alignment: fc.boolean(),
});

/** Sort and clip raw edits into non-overlapping ones within `length` lines. */
function normalize_edits(raw: edit[], length: number): edit[] {
	const edits: edit[] = [];
	let next_free = 0;
	for (const e of raw.toSorted((a, b) => a.at - b.at)) {
		const at = Math.max(e.at % (length + 1), next_free);
		if (at > length) {
			break;
		}
		const deleted = Math.min(e.deleted, length - at);
		edits.push({ at, deleted, inserted: e.inserted });
		next_free = at + deleted + 1;
	}
	return edits;
}

let case_number = 0;

/** All line numbers of `lines`, 1-based. */
function all_rows(lines: readonly string[]): number[] {
	return lines.map((_, i) => i + 1);
}

describe("highlight_sides", () => {
	it("renders both sides as independent passes would", async () => {
		await fc.assert(fc.asyncProperty(case_arb, async ({ old_lines, raw_edits, old_first, wrong_alignment }) => {
			const n = ++case_number;
			const { new_lines, aligned } = apply_edits(old_lines, normalize_edits(raw_edits, old_lines.length));
			const old_side = { identity: `peer|old|${n}`, lang: "typescript", lines: old_lines, wanted: all_rows(old_lines) };
			const new_side = { identity: `peer|new|${n}`, lang: "typescript", lines: new_lines, wanted: all_rows(new_lines) };
			if (old_first) {
				// Cached states make the old side go first.
				await highlight_lines(old_side.identity, "typescript", old_lines, [old_lines.length], null);
			}
			const claimed = wrong_alignment ? [{ old_start: 1, new_start: 1, count: Infinity }] : aligned;
			const [old_sgr, new_sgr] = await highlight_sides(old_side, new_side, claimed, null);
			const old_ref = await highlight_lines(`peer|old-ref|${n}`, "typescript", old_lines, old_side.wanted, null);
			const new_ref = await highlight_lines(`peer|new-ref|${n}`, "typescript", new_lines, new_side.wanted, null);
			expect(old_sgr).toEqual(old_ref);
			expect(new_sgr).toEqual(new_ref);
		}), { numRuns: 200 });
	}, 120000);

	it("copies the unchanged lines' states once they converge after a hunk", async () => {
		const body = Array.from({ length: 3000 }, (_, i) => LINE_POOL[i % LINE_POOL.length]!);
		const old_lines = ["/* opened", ...body];
		// Closing the comment early changes the states until the pool's
		// own comment closes them again, a few lines later.
		const new_lines = ["/* opened */", ...body];
		const old_side = { identity: "peer|converge|old", lang: "typescript", lines: old_lines, wanted: [1, 3001] };
		const new_side = { identity: "peer|converge|new", lang: "typescript", lines: new_lines, wanted: [1, 3001] };
		const aligned = [{ old_start: 2, new_start: 2, count: Infinity }];
		await highlight_sides(null, new_side, aligned, null);
		const tokenized = stats.tokenized_lines;
		const copied = stats.copied_lines;
		const [old_sgr] = await highlight_sides(old_side, new_side, aligned, null);
		expect(stats.tokenized_lines - tokenized).toBeLessThan(20);
		expect(stats.copied_lines - copied).toBeGreaterThan(2980);
		expect(old_sgr).toEqual(await highlight_lines("peer|converge|old-ref", "typescript", old_lines, [1, 3001], null));
	});
});
