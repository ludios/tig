/**
 * The shape of a file association, as lang_map.ts and the generated
 * vscode_langs.ts give them, and how its patterns become regular
 * expressions.  This module does not import either table, so that
 * scripts/gen-vscode-langs.ts can run without the table that it writes.
 */

import { A } from "ayy";

/**
 * How to recognize the files of one language.  The fields other than
 * `lang` are those of a `contributes.languages` entry in a VS Code
 * extension's package.json, lowercased except for `first_line`: VS Code
 * compares them with a lowercased path.
 */
export interface lang_association {
	/** shiki language id, or null for plain text: such a file is not
	 * highlighted, whatever its first line is. */
	lang: string | null,
	/** Endings of the file name.  Most are ".ext", but any ending is
	 * allowed, e.g. "color-theme.json". */
	extensions?: readonly string[],
	/** Whole file names. */
	filenames?: readonly string[],
	/** Globs, as glob_regex() takes them.  A glob with a "/" in it is
	 * matched against the whole path, any other against the file name. */
	patterns?: readonly string[],
	/** Source of a regular expression, as first_line_regex() takes it;
	 * consulted only when the path does not match any association. */
	first_line?: string,
}

/** Characters that a regular expression takes specially. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * @param glob  A glob in the subset of VS Code's syntax that the
 *              associations use: `*` and `?` match within one path
 *              component, and a `**` component matches any number of
 *              directories; the rest is literal, in lowercase.
 * @returns A regular expression that matches the lowercased paths (or
 *          file names) that `glob` matches.
 */
export function glob_regex(glob: string): RegExp {
	A.eq(glob.search(/[{}[\]\\!]|(?<!^|\/)\*\*|\*\*(?!\/)/), -1, `glob syntax that glob_regex() lacks, in ${glob}`);
	const source = glob.split("**/")
		.map((part) => part.split("*")
			.map((piece) => piece.split("?")
				.map((literal) => literal.replace(REGEX_SPECIAL, "\\$&"))
				.join("[^/]"))
			.join("[^/]*"))
		.join("(?:.*/)?");
	return new RegExp(`^${source}$`, "s");
}

/**
 * @param source  A first-line pattern from a language contribution.
 * @returns The regular expression that VS Code searches a first line for:
 *          `source`, anchored at the line's start.  (Where `source` is
 *          alternatives without a group around them, that anchors only
 *          the first one, in VS Code too.)
 */
export function first_line_regex(source: string): RegExp {
	return new RegExp(source.startsWith("^") ? source : `^${source}`);
}
