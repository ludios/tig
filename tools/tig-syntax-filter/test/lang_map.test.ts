import { describe, it, expect } from "vitest";
import { bundledLanguages } from "shiki";
import { detect_lang, detectable_langs } from "../src/lang_map.ts";

describe("lang_map", () => {
	it("returns only languages that shiki bundles", () => {
		const unbundled = [...detectable_langs].filter((lang) => !Object.hasOwn(bundledLanguages, lang));
		expect(unbundled).toEqual([]);
	});

	it("counts the make fallback among the detectable languages", () => {
		const lang = detect_lang("build/rules.mk", null);
		expect(lang).toBe("make");
		expect(detectable_langs.has(lang!)).toBe(true);
	});
});
