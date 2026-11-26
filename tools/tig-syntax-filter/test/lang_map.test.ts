import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { bundledLanguagesInfo } from "shiki";
import { detect_lang, detectable_langs } from "../src/lang_map.ts";

describe("lang_map", () => {
	it("returns only languages that shiki bundles, under shiki's own ids", () => {
		const ids = new Set(bundledLanguagesInfo.map((info) => info.id));
		const unbundled = [...detectable_langs].filter((lang) => !ids.has(lang));
		expect(unbundled).toEqual([]);
	});

	it("returns null or a detectable language for any path and first line", () => {
		fc.assert(fc.property(fc.string(), fc.option(fc.string()), (path, first_line) => {
			const lang = detect_lang(path, first_line);
			expect(lang === null || detectable_langs.has(lang)).toBe(true);
		}));
	});

	it("ignores case and directories", () => {
		expect(detect_lang("docs/README.MD", null)).toBe("markdown");
		expect(detect_lang("a/b/CMakeLists.txt", null)).toBe("cmake");
		expect(detect_lang("a.txt/notes", null)).toBe(null);
	});

	it("takes the longest extension that the name ends with", () => {
		expect(detect_lang("x.json", null)).toBe("json");
		expect(detect_lang("x.eslintrc.json", null)).toBe("jsonc");
		expect(detect_lang("config.h.in", null)).toBe("cpp");
		// A name can consist of its extension.
		expect(detect_lang(".editorconfig", null)).toBe("ini");
	});

	it("prefers a whole name to a pattern, and a pattern to an extension", () => {
		expect(detect_lang("Dockerfile.sh", null)).toBe("docker");
		expect(detect_lang("bun.lock", null)).toBe("jsonc");
		expect(detect_lang("tsconfig.base.json", null)).toBe("jsonc");
		// "composer.lock" is a whole name, "compose.*.yml" a pattern.
		expect(detect_lang("compose.override.yml", null)).toBe("yaml");
	});

	it("matches a pattern with a slash against the path, in any directory", () => {
		expect(detect_lang(".github/hooks/pre.json", null)).toBe("jsonc");
		expect(detect_lang("sub/.github/hooks/pre.json", null)).toBe("jsonc");
		expect(detect_lang("hooks/pre.json", null)).toBe("json");
		expect(detect_lang(".github/hooks/deeper/pre.json", null)).toBe("json");
		expect(detect_lang(".cursor/rules/a/b/style.mdc", null)).toBe("markdown");
	});

	it("consults the first line only when the path decides nothing", () => {
		expect(detect_lang("bin/run", "#!/usr/bin/env python3")).toBe("python");
		expect(detect_lang("bin/run", "#!/bin/sh")).toBe("shellscript");
		expect(detect_lang("bin/run.py", "#!/bin/sh")).toBe("python");
		expect(detect_lang("bin/run", "<?xml version=\"1.0\"?>")).toBe("xml");
		expect(detect_lang("bin/run", "run")).toBe(null);
		expect(detect_lang("bin/run", null)).toBe(null);
	});

	it("lets the associations that are not VS Code's win over VS Code's", () => {
		expect(detect_lang("include/tig/view.h", null)).toBe("c");
		expect(detect_lang("src/view.hpp", null)).toBe("cpp");
	});

	it("takes a makefile.* name for a makefile only when nothing else decides", () => {
		expect(detect_lang("Makefile.am", null)).toBe("make");
		expect(detect_lang("scripts/Makefile.lib", null)).toBe("make");
		expect(detect_lang("makefile.patch", null)).toBe("diff");
		expect(detect_lang("Makefile.gen", "#!/usr/bin/env python3")).toBe("python");
	});
});
