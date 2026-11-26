import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { bundledLanguagesInfo } from "shiki";
import { glob_regex } from "../src/lang_association.ts";
import { detect_lang, detectable_langs } from "../src/lang_map.ts";

describe("lang_map", () => {
	it("returns only languages that shiki bundles, under shiki's own ids", () => {
		const ids = new Set(bundledLanguagesInfo.map((info) => info.id));
		const unbundled = [...detectable_langs].filter((lang) => !ids.has(lang));
		expect(unbundled).toEqual([]);
	});

	it("does not throw for any path and first line", () => {
		fc.assert(fc.property(fc.string(), fc.option(fc.string()), (path, first_line) => {
			const lang = detect_lang(path, first_line);
			expect(lang === null || detectable_langs.has(lang)).toBe(true);
		}));
	});

	it("uses the shiki language that has the grammar of the VS Code language", () => {
		// VS Code's "html" language has the text.html.derivative grammar.
		expect(detect_lang("index.html", null)).toBe("html-derivative");
		expect(detect_lang("GNUmakefile", null)).toBe("make");
		expect(detect_lang("App.tsx", null)).toBe("tsx");
	});

	it("uses a stand-in for a VS Code language whose grammar shiki lacks", () => {
		expect(detect_lang(".gitignore", null)).toBe("ini");
		expect(detect_lang("views/index.phtml", null)).toBe("php");
	});

	it("compares names without regard to case, in any directory", () => {
		expect(detect_lang("docs/README.MD", null)).toBe("markdown");
		expect(detect_lang("a/b/CMakeLists.txt", null)).toBe("cmake");
		expect(detect_lang("a.py/notes", null)).toBe(null);
	});

	it("takes the longest extension that the name ends with", () => {
		expect(detect_lang("x.json", null)).toBe("json");
		expect(detect_lang("x.eslintrc.json", null)).toBe("jsonc");
		expect(detect_lang("x.css.map", null)).toBe("json");
		// A name can consist of its extension.
		expect(detect_lang(".editorconfig", null)).toBe("ini");
	});

	it("prefers a pattern to an extension", () => {
		expect(detect_lang("Dockerfile.sh", null)).toBe("docker");
		expect(detect_lang("tsconfig.base.json", null)).toBe("jsonc");
	});

	it("matches a pattern with a slash against the path, in any directory", () => {
		expect(detect_lang(".github/hooks/pre.json", null)).toBe("jsonc");
		expect(detect_lang("sub/.github/hooks/pre.json", null)).toBe("jsonc");
		expect(detect_lang("hooks/pre.json", null)).toBe("json");
		expect(detect_lang(".github/hooks/deeper/pre.json", null)).toBe("json");
		expect(detect_lang(".cursor/rules/a/b/style.mdc", null)).toBe("markdown");
	});

	it("consults the first line only when the path does not decide", () => {
		expect(detect_lang("bin/run", "#!/usr/bin/env python3")).toBe("python");
		expect(detect_lang("bin/run", "#!/bin/sh")).toBe("shellscript");
		expect(detect_lang("bin/run.py", "#!/bin/sh")).toBe("python");
		expect(detect_lang("bin/run", "run")).toBe(null);
		expect(detect_lang("bin/run", null)).toBe(null);
	});

	it("searches a first line as VS Code does: from its start, in its first 1000 characters", () => {
		expect(detect_lang("page", "<?xml version=\"1.0\"?>")).toBe("xml");
		expect(detect_lang("page", "see <?xml version=\"1.0\"?>")).toBe(null);
		expect(detect_lang("page", `${" ".repeat(990)}<svg>`)).toBe("xml");
		expect(detect_lang("page", `${" ".repeat(1000)}<svg>`)).toBe(null);
	});

	it("does not highlight a plain-text file, whatever its first line is", () => {
		expect(detect_lang("notes.txt", "#!/bin/sh")).toBe(null);
		expect(detect_lang("go.mod", "<?xml version=\"1.0\"?>")).toBe(null);
	});

	it("lets an association that does not come with VS Code replace VS Code's for the same ending", () => {
		expect(detect_lang("include/tig/view.h", null)).toBe("c");
		expect(detect_lang("config.h.in", null)).toBe("c");
		expect(detect_lang("src/view.hpp", null)).toBe("cpp");
		expect(detect_lang("bin/run", "#!/usr/bin/env fish")).toBe("fish");
	});

	it("takes a makefile.* name for a makefile only when nothing else decides", () => {
		expect(detect_lang("Makefile.am", null)).toBe("make");
		expect(detectable_langs.has("make")).toBe(true);
		expect(detect_lang("scripts/Makefile.lib", null)).toBe("make");
		expect(detect_lang("makefile.patch", null)).toBe("diff");
		expect(detect_lang("Makefile.gen", "#!/usr/bin/env python3")).toBe("python");
	});
});

describe("glob_regex", () => {
	it("keeps * and ? within one path component", () => {
		expect(glob_regex("a/*.json").test("a/b.json")).toBe(true);
		expect(glob_regex("a/*.json").test("a/b/c.json")).toBe(false);
		expect(glob_regex("a?c").test("abc")).toBe(true);
		expect(glob_regex("a?c").test("a/c")).toBe(false);
		expect(glob_regex("a.c").test("abc")).toBe(false);
	});

	it("lets a ** component match any number of directories", () => {
		expect(glob_regex("**/a/*").test("a/b")).toBe(true);
		expect(glob_regex("**/a/*").test("x/y/a/b")).toBe(true);
		expect(glob_regex("**/a/*").test("xa/b")).toBe(false);
		expect(glob_regex("a/**/b").test("a/b")).toBe(true);
		expect(glob_regex("a/**/b").test("a/x\ny/b")).toBe(true);
	});

	it("refuses syntax that it lacks", () => {
		expect(() => glob_regex("{a,b}.json")).toThrow("glob syntax that glob_regex() lacks");
		expect(() => glob_regex("a**/b")).toThrow("glob syntax that glob_regex() lacks");
		expect(() => glob_regex("a/**")).toThrow("glob syntax that glob_regex() lacks");
	});
});
