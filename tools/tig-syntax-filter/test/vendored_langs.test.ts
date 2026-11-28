/**
 * The vendored grammars load, and color what they are for.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { A } from "ayy";
import { init_highlighter, ensure_lang } from "../src/highlight.ts";
import { vendored_langs } from "../src/vendored_langs.ts";
import { highlight_prefix } from "./highlight_prefix.ts";

/**
 * @param sgr  A line as highlight_lines() renders it.
 * @returns    Each piece of text in `sgr` -> the SGR sequence that the
 *             piece's last occurrence follows.
 */
function styles_of(sgr: string): Map<string, string> {
	const styles = new Map<string, string>();
	for (const [, style, text] of sgr.matchAll(/\x1b\[([0-9;]*)m([^\x1b]*)/g)) {
		styles.set(text!, style!);
	}
	return styles;
}

beforeAll(async () => {
	await init_highlighter();
}, 60000);

describe("vendored_langs", () => {
	it("all load", async () => {
		for (const lang of vendored_langs.keys()) {
			expect(await ensure_lang(lang), lang).toBe(true);
		}
	});

	it("color Template Toolkit directives, and the HTML around them", async () => {
		A(await ensure_lang("template-toolkit"), "the template-toolkit grammar failed to load");
		const line = `<td class="x">[% IF n == 13 %]Thirteen[%# a note %][% END %]</td>`;
		const sgr = await highlight_prefix("test|vendored|tt", "template-toolkit", line, 1, null);
		const styles = styles_of(sgr![0]!);
		// Plain text shares its color with `<` and `[%`, and so its piece.
		const plain = styles.get("<");
		expect(plain).toBeDefined();
		for (const text of ["td", "class", `"x"`, "IF", "13", "[%# a note %]"]) {
			expect(styles.get(text), `${text} in ${JSON.stringify(sgr![0])}`).toBeDefined();
			expect(styles.get(text), text).not.toBe(plain);
		}
		expect(styles.get("IF")).toBe(styles.get("END"));
	});
});
