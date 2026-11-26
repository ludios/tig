/**
 * Which shiki language a file is in, decided from its path and first line
 * the way VS Code decides it (getAssociations() in VS Code's
 * languagesAssociations.ts), from two lists of associations:
 *
 * - vscode_langs: those of VS Code's built-in extensions (generated; see
 *   vscode_langs.ts).
 * - extra_langs, below: those that VS Code users get by installing
 *   extensions, and a few deliberate differences from VS Code.
 *
 * A file that no association matches (and whose name does not start with
 * "makefile.") yields null, which callers treat as "do not highlight".
 */

import { A } from "ayy";
import { vscode_langs } from "./vscode_langs.ts";

/**
 * How to recognize the files of one language.  The fields other than
 * `lang` are those of a `contributes.languages` entry in a VS Code
 * extension's package.json, lowercased except for `first_line`: VS Code
 * compares them with a lowercased path.
 */
export interface lang_association {
	/** shiki language id. */
	lang: string,
	/** Endings of the file name.  Most are ".ext", but any ending is
	 * allowed, e.g. "color-theme.json". */
	extensions?: readonly string[],
	/** Whole file names. */
	filenames?: readonly string[],
	/** Globs in which `*` and `?` match within one path component, and a
	 * leading or inner `**` followed by "/" matches any number of
	 * directories.  A glob with a "/" in it is matched against the whole
	 * path, any other against the file name. */
	patterns?: readonly string[],
	/** Source of a regular expression to search the file's first line
	 * for; consulted only when the path matches no association. */
	first_line?: string,
}

/**
 * Associations that are not VS Code's built-in ones.  These come after
 * VS Code's, so where both claim the same extension, file name or
 * pattern, these win.
 */
const extra_langs: readonly lang_association[] = [
	// Deliberate differences from VS Code.
	// VS Code takes every .h file for C++, which colors C identifiers
	// such as `class` and `new` as keywords.
	{ lang: "c", extensions: [".h"] },
	// For VS Code's "ignore" language, which shiki lacks.  It colors
	// only `#` comment lines; the INI grammar colors those the same,
	// and also a line that has a `=` in it.
	{ lang: "ini", extensions: [".gitignore", ".dockerignore", ".npmignore", ".prettierignore", ".eslintignore"] },
	// For VS Code's CUDA C++ grammar, which shiki lacks.
	{ lang: "cpp", extensions: [".cu", ".cuh"] },
	// VS Code's grammar for a .php file is HTML with PHP embedded
	// (text.html.php), which shiki lacks; shiki's is PHP alone.
	{ lang: "php", extensions: [".php"], first_line: "^#!\\s*/.*\\bphp\\b" },
	// shiki's Razor grammar is another one than VS Code's built-in
	// (text.html.cshtml).
	{ lang: "razor", extensions: [".cshtml", ".razor"] },

	// More names for languages that VS Code has built in.
	{ lang: "ini", filenames: [".flake8", ".coveragerc"] },
	{ lang: "json", filenames: ["flake.lock", ".prettierrc"] },
	{ lang: "yaml", filenames: [".clang-format", ".clang-tidy"] },

	// Languages that VS Code gets from installed extensions.
	{ lang: "asciidoc", extensions: [".adoc", ".asciidoc"] },
	{ lang: "asm", extensions: [".asm", ".s"] },
	{ lang: "awk", extensions: [".awk"], first_line: "^#!.*\\bawk\\b" },
	{ lang: "cmake", extensions: [".cmake"], filenames: ["cmakelists.txt"] },
	{ lang: "codeowners", filenames: ["codeowners"] },
	{ lang: "csv", extensions: [".csv"] },
	{ lang: "d", extensions: [".d"] },
	{ lang: "desktop", extensions: [".desktop"] },
	{ lang: "elixir", extensions: [".ex", ".exs"], first_line: "^#!.*\\belixir\\b" },
	{ lang: "erlang", extensions: [".erl"] },
	{ lang: "graphql", extensions: [".graphql", ".gql"] },
	{ lang: "haskell", extensions: [".hs"] },
	{ lang: "haxe", extensions: [".hx"] },
	{ lang: "kotlin", extensions: [".kt", ".kts"] },
	{ lang: "lean", extensions: [".lean"] },
	{ lang: "nix", extensions: [".nix"] },
	{ lang: "ocaml", extensions: [".ml", ".mli"] },
	{ lang: "po", extensions: [".po", ".pot"] },
	{ lang: "proto", extensions: [".proto"] },
	// VS Code takes .ron for Markdown in the ronn format.
	{ lang: "ron", extensions: [".ron"] },
	{ lang: "scala", extensions: [".scala"] },
	{ lang: "svelte", extensions: [".svelte"] },
	{ lang: "systemd", extensions: [".service", ".socket", ".timer"] },
	{ lang: "tcl", extensions: [".tcl"], first_line: "^#!.*\\btclsh\\b" },
	{ lang: "terraform", extensions: [".tf"] },
	{ lang: "toml", extensions: [".toml"], filenames: ["cargo.lock", "poetry.lock", "uv.lock"] },
	{ lang: "tsv", extensions: [".tsv"] },
	{ lang: "viml", extensions: [".vim"] },
	{ lang: "vue", extensions: [".vue"] },
	{ lang: "zig", extensions: [".zig"] },
];

/** Characters that a regular expression takes specially. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** @returns A regular expression that matches what `glob` (a
 *           lang_association pattern) matches. */
function glob_regex(glob: string): RegExp {
	A.eq(glob.search(/[{}[\]\\!]/), -1, `glob syntax that glob_regex() lacks, in ${glob}`);
	const source = glob.split("**/")
		.map((part) => {
			A.eq(part.indexOf("**"), -1, `\`**\` without a following "/", in ${glob}`);
			return part.split("*")
				.map((piece) => piece.split("?")
					.map((literal) => literal.replace(REGEX_SPECIAL, "\\$&"))
					.join("[^/]"))
				.join("[^/]*");
		})
		.join("(?:.*/)?");
	return new RegExp(`^${source}$`);
}

/** File name -> language. */
const by_filename = new Map<string, string>();
/** File name ending -> language. */
const by_extension = new Map<string, string>();
/** Glob -> how to match it, and its language. */
const by_pattern = new Map<string, { regex: RegExp, on_path: boolean, lang: string }>();
/** First-line patterns, the last association's first. */
const by_first_line: { regex: RegExp, lang: string }[] = [];
// In VS Code, the association registered last wins among equal names,
// extensions and patterns, and is the first one whose first-line pattern
// is tried.
for (const association of [...vscode_langs, ...extra_langs]) {
	const { lang } = association;
	for (const filename of association.filenames ?? []) {
		by_filename.set(filename, lang);
	}
	for (const extension of association.extensions ?? []) {
		by_extension.set(extension, lang);
	}
	for (const glob of association.patterns ?? []) {
		by_pattern.set(glob, { regex: glob_regex(glob), on_path: glob.includes("/"), lang });
	}
	if (association.first_line !== undefined) {
		by_first_line.unshift({ regex: new RegExp(association.first_line), lang });
	}
}

/** Every language that detect_lang() can return. */
export const detectable_langs: ReadonlySet<string> = new Set(
	[...vscode_langs, ...extra_langs].map((association) => association.lang));

/**
 * Pick a shiki language for a file.  In order of precedence: its whole
 * name, the longest pattern that matches its path, the longest extension
 * that its name ends with, a pattern found in its first line, and a name
 * that starts with "makefile.".
 *
 * @param path        The file's path, relative to its repository's top.
 * @param first_line  The file's first line without a byte order mark, or
 *                    null when its content is not at hand.
 * @returns           The language, or null when no association matches.
 */
export function detect_lang(path: string, first_line: string | null): string | null {
	// VS Code matches absolute paths, so `**/a/*` matches in the top
	// directory too.
	const absolute = `/${path.toLowerCase()}`;
	const basename = absolute.slice(absolute.lastIndexOf("/") + 1);
	const named = by_filename.get(basename);
	if (named !== undefined) {
		return named;
	}

	let longest_glob = "";
	let by_glob: string | null = null;
	for (const [glob, { regex, on_path, lang }] of by_pattern) {
		if (glob.length >= longest_glob.length && regex.test(on_path ? absolute : basename)) {
			longest_glob = glob;
			by_glob = lang;
		}
	}
	if (by_glob !== null) {
		return by_glob;
	}

	// The longest ending first.
	for (let start = 0; start < basename.length; start++) {
		const by_ending = by_extension.get(basename.slice(start));
		if (by_ending !== undefined) {
			return by_ending;
		}
	}

	if (first_line !== null) {
		for (const { regex, lang } of by_first_line) {
			if (regex.test(first_line)) {
				return lang;
			}
		}
	}

	// Not from VS Code: a part of a makefile (the kernel's Makefile.lib)
	// or an input for one (Makefile.am, Makefile.in).  A pattern would
	// claim makefile.patch too.
	if (basename.startsWith("makefile.")) {
		return "make";
	}
	return null;
}
