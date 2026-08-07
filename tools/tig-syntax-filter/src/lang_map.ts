// Model-output: Claude Fable 5

/**
 * Mapping from file names to shiki (VS Code) language identifiers.
 * Only languages in shiki's bundled grammar set are returned; anything
 * unknown yields null, which callers treat as "do not highlight".
 */

const extension_to_lang: Record<string, string> = {
	"c": "c", "h": "c",
	"cpp": "cpp", "cxx": "cpp", "cc": "cpp", "hpp": "cpp", "hxx": "cpp", "hh": "cpp",
	"ts": "typescript", "mts": "typescript", "cts": "typescript",
	"tsx": "tsx",
	"js": "javascript", "mjs": "javascript", "cjs": "javascript",
	"jsx": "jsx",
	"py": "python", "pyi": "python",
	"rs": "rust",
	"go": "go",
	"nix": "nix",
	"ex": "elixir", "exs": "elixir",
	"erl": "erlang",
	"md": "markdown", "markdown": "markdown",
	"sh": "shellscript", "bash": "shellscript", "zsh": "shellscript",
	"json": "json", "jsonc": "jsonc",
	"yaml": "yaml", "yml": "yaml",
	"toml": "toml",
	"html": "html", "htm": "html",
	"css": "css", "scss": "scss", "less": "less",
	"svelte": "svelte",
	"vue": "vue",
	"sql": "sql",
	"pl": "perl", "pm": "perl",
	"rb": "ruby",
	"java": "java",
	"kt": "kotlin", "kts": "kotlin",
	"swift": "swift",
	"lua": "lua",
	"vim": "viml",
	"zig": "zig",
	"hs": "haskell",
	"ml": "ocaml", "mli": "ocaml",
	"clj": "clojure", "cljs": "clojure", "cljc": "clojure",
	"scala": "scala",
	"cs": "csharp",
	"fs": "fsharp", "fsi": "fsharp",
	"php": "php",
	"r": "r",
	"dart": "dart",
	"tex": "latex",
	"proto": "proto",
	"cmake": "cmake",
	"dockerfile": "docker",
	"diff": "diff", "patch": "diff",
	"xml": "xml", "svg": "xml",
	"ini": "ini", "cfg": "ini",
	"tf": "terraform",
	"graphql": "graphql", "gql": "graphql",
	"adoc": "asciidoc", "asciidoc": "asciidoc",
	"m": "objective-c", "mm": "objective-cpp",
	"asm": "asm", "s": "asm",
	"d": "d",
	"jl": "julia",
	"groovy": "groovy",
	"ps1": "powershell",
	"bat": "bat", "cmd": "bat",
	"awk": "awk",
	"m4": "m4",
	"tcl": "tcl",
};

const basename_to_lang: Record<string, string> = {
	"makefile": "make",
	"gnumakefile": "make",
	"dockerfile": "docker",
	"cmakelists.txt": "cmake",
	".bashrc": "shellscript",
	".zshrc": "shellscript",
	".profile": "shellscript",
	".gitignore": "ini",
	".gitattributes": "ini",
	".gitmodules": "ini",
};

const shebang_to_lang: [RegExp, string][] = [
	[/\bpython[0-9.]*\b/, "python"],
	[/\b(bash|sh|zsh|dash|ksh)\b/, "shellscript"],
	[/\bnode\b/, "javascript"],
	[/\bdeno\b/, "typescript"],
	[/\bperl\b/, "perl"],
	[/\bruby\b/, "ruby"],
	[/\belixir\b/, "elixir"],
	[/\bawk\b/, "awk"],
	[/\btclsh\b/, "tcl"],
];

/**
 * Pick a shiki language for a repository-relative `path`, consulting the
 * file's `first_line` for a shebang when the name alone does not decide.
 * Returns null when no bundled grammar is known for the file.
 */
export function detect_lang(path: string, first_line: string | null): string | null {
	const basename = path.replace(/^.*\//, "").toLowerCase();
	const named = basename_to_lang[basename];
	if (named) {
		return named;
	}

	const dot = basename.lastIndexOf(".");
	if (dot > 0) {
		const ext = basename.slice(dot + 1);
		const by_ext = extension_to_lang[ext];
		if (by_ext) {
			return by_ext;
		}
	}

	if (first_line !== null && first_line.startsWith("#!")) {
		for (const [pattern, lang] of shebang_to_lang) {
			if (pattern.test(first_line)) {
				return lang;
			}
		}
	}

	if (basename.endsWith(".mk") || basename.startsWith("makefile.")) {
		return "make";
	}
	return null;
}
