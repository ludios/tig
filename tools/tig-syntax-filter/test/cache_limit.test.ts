/**
 * A document whose rendered lines would make its cache entry too big
 * keeps its line-start states cached without the renderings.  The cache
 * budget is read at import, so this file sets a small one first.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { A } from "ayy";

process.env["TIG_SYNTAX_LINE_CACHE_MB"] = "1";
const { init_highlighter, ensure_lang, highlight_lines, stats } = await import("../src/highlight.ts");

beforeAll(async () => {
	await init_highlighter();
	A(await ensure_lang("typescript"), "the typescript grammar failed to load");
}, 60000);

describe("a 1 MB tokenization cache", () => {
	it("keeps a document's states when its renderings would not fit", async () => {
		// ~240 KB of states, fitting the 512 KB entry limit, but ~1.5 MB
		// of rendered lines, not fitting.
		const lines = Array.from({ length: 3000 }, (_, i) => `const v_${i} = "${"x".repeat(150)}"; // ${i}`);
		const rows = lines.map((_, i) => i + 1);
		const first = await highlight_lines("limit|doc", "typescript", lines, rows, null);
		const tokenized = stats.tokenized_lines;
		const retokenized = stats.retokenized_lines;
		const again = await highlight_lines("limit|doc", "typescript", lines, rows, null);
		expect(again).toEqual(first);
		expect(stats.tokenized_lines).toBe(tokenized);
		expect(stats.retokenized_lines - retokenized).toBe(lines.length);
	});
});
