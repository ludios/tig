/**
 * Which shiki language a file is in, decided from its path and first line
 * the way VS Code decides it for a user without settings of their own
 * (getAssociations() in VS Code's languagesAssociations.ts), from two
 * lists of associations:
 *
 * - vscode_langs: those of the languages that come with VS Code
 *   (generated; see vscode_langs.ts).
 * - extra_langs, below: those that VS Code users get by installing
 *   extensions, and a few deliberate differences from VS Code.
 *
 * Two more differences: every alternative of a first-line pattern must
 * match at the line's start (see first_line_regex()); and extra_langs
 * names the interpreters of some languages, so that a shebang line that
 * runs one of them decides the language before any first-line pattern.
 *
 * A null language means "do not highlight".
 */

import { A } from "ayy";
import { first_line_regex, glob_regex, type lang_association } from "./lang_association.ts";
import { shebang_program } from "./shebang.ts";
import { vscode_langs } from "./vscode_langs.ts";

/** An association of extra_langs. */
interface extra_association extends lang_association {
	/** Matches, as a whole, the file name of a program that runs files of
	 * the language, as shebang_program() returns it; without flags.
	 * Unlike a first-line pattern such as `^#!.*\bawk\b`, it does not take
	 * a directory or an argument of that name for the interpreter. */
	interpreter?: RegExp,
}

/**
 * Associations that do not come with VS Code.  These are registered after
 * VS Code's, so where both have the same extension, file name or pattern,
 * these win.
 */
const extra_langs: readonly extra_association[] = [
	// Deliberate differences from VS Code.
	// VS Code takes these endings for C++, which colors C identifiers
	// such as `class` and `new` as keywords.
	{ lang: "c", extensions: [".h", ".h.in"] },
	// VS Code takes .mod for XML.  A go.mod is not XML, and shiki lacks
	// a grammar for it.
	{ lang: null, filenames: ["go.mod"] },
	// VS Code's first-line pattern for Raku finds `#!/usr/bin/env raku`
	// through an alternative "raku", which first_line_regex() anchors at
	// the line's start; this association finds it instead.  Rakudo
	// installs raku, rakudo, rakudo-m, rakudo-debug-m and so on.
	{ lang: "raku", interpreter: /(?:raku|rakudo)(?:-(?:debug|gdb|lldb|valgrind))?(?:-(?:m|j|js))?/ },
	// Docker reads Dockerfile.dockerignore as the ignore file of the
	// Dockerfile, and Dockerfile.dev.dockerignore as that of
	// Dockerfile.dev; Podman reads Containerfile.containerignore, and so
	// on.  VS Code's patterns `dockerfile.*` and `containerfile.*` take
	// such ignore files for Dockerfiles; the patterns below are longer
	// than those, and so win.
	{ lang: "ini", patterns: ["containerfile*.containerignore", "containerfile*.dockerignore", "dockerfile*.containerignore", "dockerfile*.dockerignore"] },

	// More names for languages that come with VS Code.
	// VS Code registers .txt itself, not from an extension's manifest.
	{ lang: null, extensions: [".txt"] },
	// As VS Code's own ignore files: see STAND_INS in
	// scripts/gen-vscode-langs.ts.
	{ lang: "ini", extensions: [".containerignore", ".dockerignore", ".prettierignore", ".eslintignore"] },
	{ lang: "ini", filenames: [".flake8", ".coveragerc"] },
	{ lang: "json", filenames: ["flake.lock"] },
	// A .prettierrc is JSON or YAML; the YAML grammar colors both.
	{ lang: "yaml", filenames: [".clang-format", ".clang-tidy", ".prettierrc"] },

	// Languages that VS Code gets from installed extensions.
	{ lang: "asciidoc", extensions: [".adoc", ".asciidoc"] },
	{ lang: "asm", extensions: [".asm", ".s"] },
	// Debian installs the one true awk as original-awk.
	{ lang: "awk", extensions: [".awk"], interpreter: /(?:[gmn]|original-)?awk/ },
	{ lang: "cmake", extensions: [".cmake"], filenames: ["cmakelists.txt"] },
	{ lang: "codeowners", filenames: ["codeowners"] },
	{ lang: "csv", extensions: [".csv"] },
	{ lang: "d", extensions: [".d"] },
	{ lang: "desktop", extensions: [".desktop"] },
	{ lang: "elixir", extensions: [".ex", ".exs"], interpreter: /elixir/ },
	// VS Code takes .erb for Ruby.
	{ lang: "erb", extensions: [".erb"] },
	{ lang: "erlang", extensions: [".erl"] },
	// VS Code takes fish scripts for shell scripts.
	{ lang: "fish", extensions: [".fish"], interpreter: /fish/ },
	{ lang: "graphql", extensions: [".graphql", ".gql"] },
	{ lang: "haskell", extensions: [".hs"] },
	{ lang: "haxe", extensions: [".hx"] },
	{ lang: "kotlin", extensions: [".kt", ".kts"] },
	{ lang: "lean", extensions: [".lean"] },
	{ lang: "nix", extensions: [".nix"] },
	{ lang: "nushell", extensions: [".nu"], interpreter: /nu/ },
	{ lang: "ocaml", extensions: [".ml", ".mli"] },
	{ lang: "po", extensions: [".po", ".pot"] },
	{ lang: "proto", extensions: [".proto"] },
	// VS Code takes .ron for Markdown in the ronn format.
	{ lang: "ron", extensions: [".ron"] },
	{ lang: "scala", extensions: [".scala"] },
	{ lang: "svelte", extensions: [".svelte"] },
	{ lang: "systemd", extensions: [".service", ".socket", ".timer"] },
	{ lang: "tcl", extensions: [".tcl"], interpreter: /tclsh[0-9.]*/ },
	{ lang: "terraform", extensions: [".tf"] },
	{ lang: "toml", extensions: [".toml"], filenames: ["cargo.lock", "poetry.lock", "uv.lock"] },
	{ lang: "tsv", extensions: [".tsv"] },
	{ lang: "viml", extensions: [".vim"] },
	{ lang: "vue", extensions: [".vue"] },
	{ lang: "zig", extensions: [".zig"] },
];

/** As many characters of a file's first line as VS Code looks at. */
const FIRST_LINE_LIMIT = 1000;

/** File name -> language. */
const by_filename = new Map<string, string | null>();
/** File name ending -> language. */
const by_extension = new Map<string, string | null>();
/** Glob -> how to match it, and its language; in registration order. */
const by_pattern = new Map<string, { regex: RegExp, on_path: boolean, lang: string | null }>();
/** First-line patterns, the association registered last first. */
const by_first_line: { regex: RegExp, lang: string | null }[] = [];
// In VS Code, the association registered last wins among equal names,
// extensions and patterns, and its first-line pattern is tried first.
for (const association of [...vscode_langs, ...extra_langs]) {
	const { lang } = association;
	for (const filename of association.filenames ?? []) {
		by_filename.set(filename, lang);
	}
	for (const extension of association.extensions ?? []) {
		by_extension.set(extension, lang);
	}
	for (const glob of association.patterns ?? []) {
		// A Map keeps a key's place when its value is replaced.
		by_pattern.delete(glob);
		by_pattern.set(glob, { regex: glob_regex(glob), on_path: glob.includes("/"), lang });
	}
	if (association.first_line !== undefined) {
		by_first_line.unshift({ regex: first_line_regex(association.first_line), lang });
	}
}

/** The interpreters of extra_langs, as regular expressions that match a
 * whole name, with their languages; the association registered last
 * first. */
const by_interpreter = extra_langs.toReversed().flatMap(({ interpreter, lang }) => {
	if (interpreter === undefined) {
		return [];
	}
	A.eq(interpreter.flags, "", `flags of the interpreter of ${lang}`);
	return [{ regex: new RegExp(`^(?:${interpreter.source})$`), lang }];
});

/** The language of a makefile.* file that nothing else decides. */
const MAKE = "make";

/** Every language that detect_lang() can return. */
export const detectable_langs: ReadonlySet<string> = new Set([
	...[...vscode_langs, ...extra_langs].map((association) => association.lang).filter((lang) => lang !== null),
	MAKE,
]);

/**
 * Pick a shiki language for a file.  In order of precedence: its whole
 * name, the longest pattern that matches its path, the longest extension
 * that its name ends with, the program that its first line runs as a
 * shebang line (when extra_langs names it as an interpreter), a pattern
 * that matches the start of its first line, and a name that starts with
 * "makefile.".
 *
 * @param path        The file's path, relative to its repository's top.
 * @param first_line  The file's first line without a byte order mark, or
 *                    null when its content is not at hand.
 * @returns           The language, or null for a file not to highlight:
 *                    one that an association makes plain text, or that
 *                    none of the above decides.
 */
export function detect_lang(path: string, first_line: string | null): string | null {
	const lower = path.toLowerCase();
	const basename = lower.slice(lower.lastIndexOf("/") + 1);
	const named = by_filename.get(basename);
	if (named !== undefined) {
		return named;
	}

	let longest: { glob: string, lang: string | null } | null = null;
	for (const [glob, { regex, on_path, lang }] of by_pattern) {
		if ((longest === null || glob.length >= longest.glob.length) && regex.test(on_path ? lower : basename)) {
			longest = { glob, lang };
		}
	}
	if (longest !== null) {
		return longest.lang;
	}

	// The longest ending first.
	for (let start = 0; start < basename.length; start++) {
		const by_ending = by_extension.get(basename.slice(start));
		if (by_ending !== undefined) {
			return by_ending;
		}
	}

	if (first_line !== null) {
		const shown = first_line.slice(0, FIRST_LINE_LIMIT);
		const program = shebang_program(shown);
		const run_by = program === null ? undefined : by_interpreter.find(({ regex }) => regex.test(program));
		if (run_by !== undefined) {
			return run_by.lang;
		}
		for (const { regex, lang } of by_first_line) {
			if (regex.test(shown)) {
				return lang;
			}
		}
	}

	// Not from VS Code: a part of a makefile (the kernel's Makefile.lib)
	// or an input for one (Makefile.am, Makefile.in).  A pattern would
	// claim makefile.patch too.
	if (basename.startsWith("makefile.")) {
		return MAKE;
	}
	return null;
}
