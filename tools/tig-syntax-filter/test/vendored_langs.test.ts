/**
 * The vendored grammar of Template Toolkit colors directives, HTML, and,
 * through shiki's own grammars, CSS and JavaScript.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { A } from "ayy";
import { init_highlighter, ensure_lang } from "../src/highlight.ts";
import { highlight_prefix } from "./highlight_prefix.ts";

/**
 * @param identity  A content identity for `content`, as for
 *                  highlight_lines().
 * @param lang      A loaded language.
 * @param content   A document of one line.
 * @returns         Each piece of text in the line's rendering -> the
 *                  parameters of the SGR sequence before the piece's
 *                  last occurrence.  Adjacent text of one color is one
 *                  piece.
 */
async function styles_of(identity: string, lang: string, content: string): Promise<Map<string, string>> {
	const sgr = await highlight_prefix(identity, lang, content, 1, null);
	A(sgr !== null, "highlight_prefix() gave up without a deadline");
	const styles = new Map<string, string>();
	for (const [, style, text] of sgr[0]!.matchAll(/\x1b\[([0-9;]*)m([^\x1b]*)/g)) {
		styles.set(text!, style!);
	}
	return styles;
}

beforeAll(async () => {
	await init_highlighter();
	for (const lang of ["template-toolkit", "css", "javascript"]) {
		const loaded = await ensure_lang(lang);
		A.eq(loaded, true, `whether the ${lang} grammar loaded`);
	}
}, 60000);

describe("the template-toolkit grammar", () => {
	it("colors directives, and the HTML around them", async () => {
		const line = `<td class="x">[% IF n == 13 %]Thirteen[%# a note %][% END %]</td>`;
		const styles = await styles_of("test|vendored|tt", "template-toolkit", line);
		// The first piece, `<`, has the color of plain text, as `[%` does.
		const plain = styles.get("<");
		expect(plain).toBeDefined();
		for (const text of ["td", "class", `"x"`, "IF", "13", "[%# a note %]"]) {
			expect(styles.get(text), text).toBeDefined();
			expect(styles.get(text), text).not.toBe(plain);
		}
		expect(styles.get("IF")).toBe(styles.get("END"));
	});

	it("colors CSS and JavaScript as shiki's own grammars do", async () => {
		const line = `<style>p { color: red; }</style><script>const x = 1;</script>`;
		const styles = await styles_of("test|vendored|tt-embedded", "template-toolkit", line);
		const css = await styles_of("test|vendored|css", "css", "p { color: red; }");
		const javascript = await styles_of("test|vendored|js", "javascript", "const x = 1;");
		for (const [text, own] of [["color:", css], ["red", css], ["const", javascript], ["1", javascript]] as const) {
			expect(own.get(text), text).toBeDefined();
			expect(styles.get(text), text).toBe(own.get(text));
		}
	});
});
