/**
 * Which program a shebang line runs, found the way env and busybox find
 * it, so that a script's language can be decided from that program's own
 * name: neither a directory nor an argument that has a language's name
 * decides it.
 */

/**
 * A word of a shebang line: a run of characters other than white space,
 * where a quoted string can hold white space.  Each alternative starts
 * with a different character, so a word matches in only one way.
 */
const WORD = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+/g;

/** A quoted string or an escaped character in a word. */
const QUOTED = /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g;

/** Short options of env that take an operand: -a, -C, -S and -u of GNU
 * env, and -L, -P and -U of FreeBSD's env. */
const SHORT_WITH_OPERAND = "aCLPSUu";

/** Long options of GNU env that take an operand, other than
 * --split-string. */
const LONG_WITH_OPERAND = ["argv0", "chdir", "env0-from", "unset"];

/**
 * @param text  The part of a shebang line after the `#!`.
 * @returns The words of `text`, without their quotes and backslashes,
 *          as env -S splits them (except for env's `\_`, `\c` and
 *          `${NAME}`, which are kept as they are).
 */
function split_words(text: string): string[] {
	return Array.from(text.matchAll(WORD), ([word]) => word.replace(
		QUOTED,
		(_, single?: string, double?: string, escaped?: string) => single ?? double?.replace(/\\(.)/g, "$1") ?? escaped ?? "",
	));
}

/**
 * Removes from the start of `words` the words that env takes for itself:
 * options with their operands, then variable assignments.  As in GNU
 * env, options end at `--` or at the first word that is not an option,
 * and the words of the operand of -S are taken as more of env's words:
 * the operand's first word, when it is in the option's own word (as in
 * `-Sawk`), is put back at the start of `words`.
 *
 * @param words  The words that follow env on a shebang line.
 */
function drop_env_words(words: string[]): void {
	for (;;) {
		const option = words[0];
		if (option === undefined || !option.startsWith("-") || option === "-") {
			break;
		}
		words.shift();
		if (option === "--") {
			break;
		}

		if (option.startsWith("--")) {
			const equals = option.indexOf("=");
			// getopt takes any start of a long option's name.
			const name = option.slice(2, equals === -1 ? undefined : equals);
			const operand = equals === -1 ? "" : option.slice(equals + 1);
			if ("split-string".startsWith(name)) {
				if (operand !== "") {
					words.unshift(operand);
				}
			} else if (equals === -1 && LONG_WITH_OPERAND.some((long) => long.startsWith(name))) {
				words.shift();
			}
			continue;
		}

		for (let i = 1; i < option.length; i++) {
			const letter = option.charAt(i);
			if (SHORT_WITH_OPERAND.includes(letter)) {
				const attached = option.slice(i + 1);
				if (letter === "S") {
					if (attached !== "") {
						words.unshift(attached);
					}
				} else if (attached === "") {
					words.shift();
				}
				break;
			}
		}
	}

	// `-` alone stands for -i.
	if (words[0] === "-") {
		words.shift();
	}
	while (words[0]?.includes("=")) {
		words.shift();
	}
}

/**
 * @param line  A file's first line.
 * @returns The file name of the program that `line` runs as a shebang
 *          line: of the program after `#!`, or of the program that env
 *          or busybox runs when that is env or busybox.  null when
 *          `line` does not start with `#!`, or names no such program.
 */
export function shebang_program(line: string): string | null {
	if (!line.startsWith("#!")) {
		return null;
	}
	const words = split_words(line.slice(2));
	// busybox runs the program that its next word names; so does env,
	// after its own words.  busybox runs as busybox.static and so on, too.
	for (let program = words.shift(); program !== undefined; program = words.shift()) {
		const name = program.slice(program.lastIndexOf("/") + 1);
		if (name === "env") {
			drop_env_words(words);
		} else if (!name.startsWith("busybox")) {
			return name;
		}
	}
	return null;
}
