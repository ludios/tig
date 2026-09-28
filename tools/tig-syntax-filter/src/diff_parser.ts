// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5
// Model-output: ChatGPT 6 Astra

/**
 * Byte-exact parsing of `git diff`/`git show` output into per-file sections.
 * All splitting works on Buffers so that untouched parts of the stream can
 * be re-emitted byte-identically; strings are only derived for inspection.
 */

import { A } from "ayy";

const DIFF_GIT = Buffer.from("diff --git ");

/** One input line, its bytes excluding the newline, and whether one followed. */
export interface diff_line {
	bytes: Buffer;
	had_newline: boolean;
}

/** A run of input lines: the preamble before any diff, one file's diff, or
 * a slice of an oversized file's diff being streamed through raw. */
export interface diff_section {
	kind: "preamble" | "file" | "oversized";
	lines: diff_line[];
	/** Total input bytes these lines consumed (including newlines). */
	byte_length: number;
}

/**
 * Incrementally splits a diff byte stream into sections, each starting at
 * a "diff --git " line.  feed() returns the sections a chunk completes;
 * finish() flushes the rest.
 *
 * Once a file section's complete lines exceed `max_section_bytes`, it
 * stops being buffered: its lines flush as "oversized" sections as they
 * arrive, up to the next boundary, and callers pass those through raw.
 * So a giant generated file is neither held in memory nor highlighted.
 * The preamble, also raw, streams the same way, so input that never
 * reaches a diff (`git log | tig`) is not held until EOF.  Sections end
 * on line boundaries: a trailing partial line waits in `carry` for its
 * newline or EOF.
 */
export class SectionSplitter {
	/** The trailing partial line in the pieces it arrived in; joining them
	 * only once its newline arrives keeps a long line linear. */
	private carry: Buffer[] = [];
	private current: diff_line[] = [];
	private current_bytes = 0;
	private current_kind: "preamble" | "file" | "oversized" = "preamble";
	private max_section_bytes: number;

	constructor(max_section_bytes: number = Infinity) {
		this.max_section_bytes = max_section_bytes;
	}

	private take_section(): diff_section | null {
		if (this.current.length === 0) {
			return null;
		}
		const section: diff_section = {
			kind: this.current_kind,
			lines: this.current,
			byte_length: this.current_bytes,
		};
		this.current = [];
		this.current_bytes = 0;
		return section;
	}

	private push_line(bytes: Buffer, had_newline: boolean, completed: diff_section[]): void {
		if (bytes.subarray(0, DIFF_GIT.length).equals(DIFF_GIT)) {
			const done = this.take_section();
			if (done !== null) {
				completed.push(done);
			}
			this.current_kind = "file";
		}
		this.current.push({ bytes, had_newline });
		this.current_bytes += bytes.length + (had_newline ? 1 : 0);
		if (this.current_kind === "file" && this.current_bytes > this.max_section_bytes) {
			// From here to the next boundary this file streams through
			// raw; flush what is buffered so it stops occupying memory.
			this.current_kind = "oversized";
			const done = this.take_section();
			if (done !== null) {
				completed.push(done);
			}
		}
	}

	feed(chunk: Buffer): diff_section[] {
		const completed: diff_section[] = [];
		if (chunk.indexOf(0x0a) === -1) {
			// No line completes, so nothing new could stream out either.
			if (chunk.length > 0) {
				this.carry.push(chunk);
			}
			return completed;
		}
		const data = this.carry.length > 0 ? Buffer.concat([...this.carry, chunk]) : chunk;
		let start = 0;
		// The carried bytes hold no newline: search only the new chunk.
		let from = data.length - chunk.length;

		while (true) {
			const nl = data.indexOf(0x0a, from);
			if (nl === -1) {
				break;
			}
			this.push_line(data.subarray(start, nl), true, completed);
			start = nl + 1;
			from = start;
		}
		this.carry = start < data.length ? [data.subarray(start)] : [];
		if (this.current_kind !== "file") {
			// Stream, do not buffer: everything complete goes out now.
			const done = this.take_section();
			if (done !== null) {
				completed.push(done);
			}
		}
		return completed;
	}

	finish(): diff_section[] {
		const completed: diff_section[] = [];
		if (this.carry.length > 0) {
			this.push_line(Buffer.concat(this.carry), false, completed);
			this.carry = [];
		}
		const done = this.take_section();
		if (done !== null) {
			completed.push(done);
		}
		return completed;
	}
}

/** One hunk: header position, start line numbers, and body line positions. */
export interface hunk {
	old_start: number;
	new_start: number;
	/** Indexes into the section's lines for each body line (+/-/space). */
	body: number[];
}

/** Parsed identity of one file section, enough to fetch and map sources. */
export interface file_info {
	old_path: string | null;	/* null = /dev/null (added file) */
	new_path: string | null;	/* null = /dev/null (deleted file) */
	old_oid: string | null;		/* null = unusable (absent or all-zero) */
	new_oid: string | null;
	hunks: hunk[];
	/** Deepest source line each side needs for styling (1-based): "-"
	 * lines use the old side, "+" and context lines the new side.  0 means
	 * that side need not be fetched or tokenized. */
	old_last_line: number;
	new_last_line: number;
}

/** Unquote a git C-style quoted path ("\t", "\303\251", ...). */
export function unquote_git_path(quoted: string): string | null {
	if (!quoted.startsWith("\"")) {
		return quoted;
	}
	if (!quoted.endsWith("\"") || quoted.length < 2) {
		return null;
	}
	const inner = quoted.slice(1, -1);
	const bytes: number[] = [];
	let i = 0;
	while (i < inner.length) {
		const ch = inner.charCodeAt(i);
		if (ch !== 0x5c) {
			if (ch < 0x80) {
				bytes.push(ch);
				i++;
			} else {
				// Unescaped UTF-8, as with core.quotePath=false.
				const char = String.fromCodePoint(inner.codePointAt(i)!);
				bytes.push(...Buffer.from(char, "utf8"));
				i += char.length;
			}
			continue;
		}
		const esc = inner[i + 1];
		i += 2;
		if (esc === undefined) {
			return null;
		}
		const simple: Record<string, number> = {
			"a": 0x07, "b": 0x08, "f": 0x0c, "n": 0x0a, "r": 0x0d,
			"t": 0x09, "v": 0x0b, "\\": 0x5c, "\"": 0x22,
		};
		if (esc in simple) {
			bytes.push(simple[esc]);
		} else if (esc >= "0" && esc <= "7") {
			let octal = esc;
			while (octal.length < 3 && inner[i] >= "0" && inner[i] <= "7") {
				octal += inner[i];
				i++;
			}
			bytes.push(parseInt(octal, 8));
		} else {
			return null;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** The path field of a "--- " or "+++ " line.  git appends a TAB after a
 * name containing a space (a hint for GNU patch); it is not part of the
 * name, which would quote a TAB of its own. */
function header_path(text: string): string {
	const field = text.slice(4);
	return field.endsWith("\t") ? field.slice(0, -1) : field;
}

/**
 * Strip the diff prefix ("a/" or "b/") only when `prefixed` says the diff
 * actually uses the default prefixes; with --no-prefix, a repository path
 * legitimately starting with "a/" must stay intact.
 */
function strip_prefix(path: string, prefix: "a/" | "b/", prefixed: boolean): string {
	if (prefixed && path.startsWith(prefix)) {
		return path.slice(prefix.length);
	}
	return path;
}

/**
 * Whether the "diff --git" header uses the default a/ b/ prefixes, judged
 * by the old path.  Custom --src-prefix/--dst-prefix values stay in the
 * paths, where they can foil path-based lookups (attributes, worktree
 * reads); hunk validation still rejects any mismatched source.
 */
function has_default_prefixes(header: string): boolean {
	const rest = header.slice("diff --git ".length);
	return rest.startsWith("a/") || rest.startsWith("\"a/");
}

/** Parse "@@ -old[,cnt] +new[,cnt] @@ ..." into numbers, or null. */
function parse_hunk_header(text: string): { old_start: number, old_count: number, new_start: number, new_count: number } | null {
	const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
	if (m === null) {
		return null;
	}
	return {
		old_start: parseInt(m[1], 10),
		old_count: m[2] === undefined ? 1 : parseInt(m[2], 10),
		new_start: parseInt(m[3], 10),
		new_count: m[4] === undefined ? 1 : parseInt(m[4], 10),
	};
}

/**
 * Parse a file section into source identities and hunk maps.  Returns null
 * for anything that should be passed through untouched: binary files,
 * combined (merge) diffs, GIT binary patches, unparseable headers.
 */
export function parse_file_section(section: diff_section): file_info | null {
	A(section.kind === "file", "parse_file_section needs a file section");

	let old_path: string | null = null;
	let new_path: string | null = null;
	let old_oid: string | null = null;
	let new_oid: string | null = null;
	let saw_minus = false;
	let saw_plus = false;
	const hunks: hunk[] = [];
	let old_last_line = 0;
	let new_last_line = 0;
	const prefixed = has_default_prefixes(section.lines[0].bytes.toString("utf8"));

	let i = 0;
	// Header lines run until the first hunk.
	for (; i < section.lines.length; i++) {
		const text = section.lines[i].bytes.toString("utf8");

		if (text.startsWith("@@")) {
			break;
		}
		if (text.startsWith("Binary files ") || text.startsWith("GIT binary patch")) {
			return null;
		}
		if (text.startsWith("diff --cc") || text.startsWith("diff --combined")) {
			return null;
		}
		if (text.startsWith("index ")) {
			// "index <old>..<new>[ <mode>]"; either OID may be abbreviated.
			const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(text);
			if (m !== null) {
				old_oid = /^0+$/.test(m[1]) ? null : m[1];
				new_oid = /^0+$/.test(m[2]) ? null : m[2];
			}
		} else if (text.startsWith("--- ")) {
			saw_minus = true;
			const raw = unquote_git_path(header_path(text));
			if (raw === null) {
				return null;
			}
			old_path = raw === "/dev/null" ? null : strip_prefix(raw, "a/", prefixed);
		} else if (text.startsWith("+++ ")) {
			saw_plus = true;
			const raw = unquote_git_path(header_path(text));
			if (raw === null) {
				return null;
			}
			new_path = raw === "/dev/null" ? null : strip_prefix(raw, "b/", prefixed);
		}
	}

	// A section with no hunks (pure rename/mode change) parses as no work.
	if (i === section.lines.length) {
		return { old_path, new_path, old_oid, new_oid, hunks, old_last_line, new_last_line };
	}
	if (!saw_minus || !saw_plus) {
		return null;
	}

	for (; i < section.lines.length; i++) {
		const text = section.lines[i].bytes.toString("utf8");

		if (text.startsWith("@@@")) {
			return null;
		}
		if (!text.startsWith("@@")) {
			// Text after the last complete hunk that belongs to no file:
			// the next commit's header in a multi-commit stream (`git log
			// -p`), a format-patch signature.  It passes through raw.
			break;
		}
		const header = parse_hunk_header(text);
		if (header === null) {
			return null;
		}
		const body: number[] = [];
		let old_left = header.old_count;
		let new_left = header.new_count;
		let old_row = header.old_start;
		let new_row = header.new_start;

		for (i++; i < section.lines.length && (old_left > 0 || new_left > 0); i++) {
			const line = section.lines[i];
			const first = line.bytes.length > 0 ? line.bytes[0] : 0x20;

			if (first === 0x5c) {
				// "\ No newline at end of file" annotates the previous
				// line; it is not part of the hunk counts.
				continue;
			}
			if (first === 0x2d) {
				old_last_line = Math.max(old_last_line, old_row);
				old_row++;
				old_left--;
			} else if (first === 0x2b) {
				new_last_line = Math.max(new_last_line, new_row);
				new_row++;
				new_left--;
			} else if (first === 0x20 || line.bytes.length === 0) {
				// An entirely empty line is a context line whose single
				// space some tools trim.  Context is styled from the
				// new side.
				new_last_line = Math.max(new_last_line, new_row);
				old_row++;
				new_row++;
				old_left--;
				new_left--;
			} else {
				return null;
			}
			body.push(i);
		}
		// Account for a trailing "\ No newline at end of file".
		while (i < section.lines.length && section.lines[i].bytes.length > 0 &&
		       section.lines[i].bytes[0] === 0x5c) {
			i++;
		}
		i--;

		if (old_left !== 0 || new_left !== 0) {
			return null;
		}
		hunks.push({ old_start: header.old_start, new_start: header.new_start, body });
	}

	return { old_path, new_path, old_oid, new_oid, hunks, old_last_line, new_last_line };
}
