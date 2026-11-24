/**
 * A document whose states or rendered lines would make its cache entry
 * too big keeps the longest prefix of states that fits and as many
 * renderings as fit beside them, whether the entry starts out too big or
 * grows too big.  The cache budget is read at import, so this file sets
 * a small one first: 1 MiB, so an entry may take 512 KiB.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { A } from "ayy";

process.env["TIG_SYNTAX_LINE_CACHE_MB"] = "1";
const { init_highlighter, ensure_lang, highlight_lines, stats } = await import("../src/highlight.ts");

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("typescript"), "the typescript grammar failed to load");
}, 60000);

/** Lines of a document with `count` short statements. */
function statements(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `let v_${i} = ${i};`);
}

/**
 * Render line `depth` of `lines` as document `identity`.
 *
 * @returns The lines run through the grammar to do so.
 */
async function tokenized_to_render(identity: string, lines: string[], depth: number): Promise<number> {
	const before = stats.tokenized_lines;
	await highlight_lines(identity, "typescript", lines, [depth], null);
	return stats.tokenized_lines - before;
}

describe("a 1 MiB tokenization cache", () => {
	it("keeps a document's states, and the renderings that fit beside them", async () => {
		// ~240 KB of states, fitting the 512 KiB entry limit, but ~1.6 MB
		// of rendered lines by the cache's estimate, not fitting.
		const lines = Array.from({ length: 3000 }, (_, i) => `const v_${i} = "${"x".repeat(150)}"; // ${i}`);
		const rows = lines.map((_, i) => i + 1);
		const first = await highlight_lines("limit|doc", "typescript", lines, rows, null);
		const tokenized = stats.tokenized_lines;
		const retokenized = stats.retokenized_lines;
		const again = await highlight_lines("limit|doc", "typescript", lines, rows, null);
		expect(again).toEqual(first);
		expect(stats.tokenized_lines).toBe(tokenized);
		const rerendered = stats.retokenized_lines - retokenized;
		expect(rerendered).toBeGreaterThan(0);
		expect(rerendered).toBeLessThan(lines.length);
	});

	it("keeps the longest prefix of states that fits", async () => {
		// 8000 states take ~640 KB, so only ~6500 lines' fit.
		const lines = statements(8000);
		const cold = await tokenized_to_render("limit|deep", lines, 8000);
		expect(cold).toBe(8000);
		const resumed = await tokenized_to_render("limit|deep", lines, 8000);
		expect(resumed).toBeGreaterThan(0);
		expect(resumed).toBeLessThan(2000);
	});

	it("keeps the longest prefix of states that fits when an entry grows", async () => {
		const lines = statements(8000);
		const shallow = await tokenized_to_render("limit|grown", lines, 100);
		expect(shallow).toBe(100);
		const deeper = await tokenized_to_render("limit|grown", lines, 8000);
		expect(deeper).toBe(7900);
		const resumed = await tokenized_to_render("limit|grown", lines, 8000);
		expect(resumed).toBeGreaterThan(0);
		expect(resumed).toBeLessThan(2000);
		const grown = await highlight_lines("limit|grown", "typescript", lines, [8000], null);
		const fresh = await highlight_lines("limit|fresh", "typescript", lines, [8000], null);
		expect(grown).toEqual(fresh);
	});
});
