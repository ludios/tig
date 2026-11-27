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

	it("takes the ignore file of a Dockerfile for an ignore file", () => {
		expect(detect_lang("Dockerfile.dockerignore", null)).toBe("ini");
		expect(detect_lang("app/Dockerfile.dev.dockerignore", null)).toBe("ini");
		expect(detect_lang("Containerfile.dockerignore", null)).toBe("ini");
		expect(detect_lang("Containerfile.containerignore", null)).toBe("ini");
		expect(detect_lang(".containerignore", null)).toBe("ini");
		expect(detect_lang("Dockerfile.dev", null)).toBe("docker");
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
		// Not a shell script, as VS Code's first-line pattern would have it.
		expect(detect_lang("pkgs/x/update.nu", "#!/usr/bin/env nix-shell")).toBe("nushell");
		expect(detect_lang("bin/run", "run")).toBe(null);
		expect(detect_lang("bin/run", null)).toBe(null);
	});

	it("takes only the interpreter's own name in a shebang for a language that does not come with VS Code", () => {
		expect(detect_lang("bin/run", "#!/usr/bin/env nu")).toBe("nushell");
		expect(detect_lang("bin/run", "#! /usr/bin/env -S raku --ll-exception")).toBe("raku");
		expect(detect_lang("bin/run", "#!/usr/bin/tclsh8.6")).toBe("tcl");
		expect(detect_lang("bin/run", "#!/usr/bin/gawk -f")).toBe("awk");
		expect(detect_lang("bin/run", "#!/usr/bin/original-awk -f")).toBe("awk");
		expect(detect_lang("bin/run", "#!/bin/busybox awk -f")).toBe("awk");
		expect(detect_lang("bin/run", "#!/usr/bin/env -S LC_ALL=C awk -f")).toBe("awk");
		expect(detect_lang("bin/run", "#!/usr/bin/env -S /usr/bin/awk -f")).toBe("awk");
		expect(detect_lang("bin/run", "#!/usr/bin/env rakudo-m")).toBe("raku");
		expect(detect_lang("bin/run", "#!/usr/bin/env -S -u nu python3")).toBe("python");
		expect(detect_lang("bin/run", "#!/home/nu/venv/bin/python")).toBe("python");
		expect(detect_lang("bin/run", "#!/home/elixir/venv/bin/python3")).toBe("python");
		expect(detect_lang("bin/run", "#!/bin/sh -c 'exec awk'")).toBe("shellscript");
	});

	it("takes none of the words that env takes for itself for the interpreter", () => {
		const name = fc.constantFrom("nu", "awk", "elixir", "raku", "tclsh");
		const env_word = fc.oneof(
			fc.constantFrom("-", "-i", "-v", "-S", "-iS"),
			name.map((n) => `-u ${n}`),
			name.map((n) => `-u${n}`),
			name.map((n) => `-C /srv/${n}`),
			name.map((n) => `-C/srv/${n}`),
			name.map((n) => `--unset=${n}`),
			name.map((n) => `${n}=/srv/${n}`),
		);
		const program = fc.constantFrom(["python3", "python"], ["/usr/bin/awk", "awk"], ["nu", "nushell"], ["tclsh8.6", "tcl"]);
		fc.assert(fc.property(fc.array(env_word, { maxLength: 4 }), program, (words, [interpreter, lang]) => {
			expect(detect_lang("bin/run", `#!/usr/bin/env ${[...words, interpreter].join(" ")}`)).toBe(lang);
		}));
	});

	it("searches a first line from its start, in its first 1000 characters", () => {
		expect(detect_lang("page", "<?xml version=\"1.0\"?>")).toBe("xml");
		expect(detect_lang("page", "see <?xml version=\"1.0\"?>")).toBe(null);
		expect(detect_lang("bin/run", `#!${" ".repeat(994)}perl`)).toBe("perl");
		expect(detect_lang("bin/run", `#!${" ".repeat(995)}perl`)).toBe(null);
	});

	it("anchors every alternative of a first-line pattern, unlike VS Code", () => {
		expect(detect_lang("icon", "<svg xmlns=\"http://www.w3.org/2000/svg\">")).toBe("xml");
		expect(detect_lang("page", "<p>An <svg> element</p>")).toBe(null);
		expect(detect_lang("README", "Notes from my class on compilers")).toBe(null);
		expect(detect_lang("bin/run", "my class Point { }")).toBe("raku");
		expect(detect_lang("bin/run", "#!/usr/bin/env raku")).toBe("raku");
		expect(detect_lang("bin/run", "#!/usr/bin/env rakudo")).toBe("raku");
		expect(detect_lang("bin/run", "#!/usr/bin/env perl6")).toBe("raku");
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
