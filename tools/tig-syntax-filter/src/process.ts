// Model-output: Claude Fable 5

/**
 * Section processing: turn one diff section into output bytes, either
 * highlighted (when every correctness precondition holds) or the raw
 * input bytes.  Pure with respect to the connection layer, so it is
 * directly testable.
 *
 * Output invariant: stripping injected SGR sequences and unescaping the
 * literal-ESC marker yields the section's input bytes exactly.
 */

import { getLogger } from "@logtape/logtape";
import { parse_file_section, type diff_section, type file_info } from "./diff_parser.ts";
import { ensure_lang, highlight_lines, frame_content, content_identity } from "./highlight.ts";
import { detect_lang } from "./lang_map.ts";
import { cat_blob, read_worktree_file, has_textconv } from "./git.ts";

const logger = getLogger(["tig-syntax", "process"]);

/** Rebuild a section's original bytes, with literal ESC bytes framed. */
export function raw_section_output(section: diff_section): Buffer {
	const parts: Buffer[] = [];
	for (const line of section.lines) {
		if (line.bytes.includes(0x1b)) {
			parts.push(Buffer.from(frame_content(line.bytes.toString("latin1")), "latin1"));
		} else {
			parts.push(line.bytes);
		}
		if (line.had_newline) {
			parts.push(Buffer.from("\n"));
		}
	}
	return Buffer.concat(parts);
}

/** Decode a Buffer as strict UTF-8, or null when it is not valid UTF-8. */
function decode_utf8(bytes: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * The source document for one side of a file diff: its full text and a
 * cache identity.  `lines` excludes newline characters.
 */
interface side_doc {
	identity: string;
	lang: string;
	text: string;
	lines: string[];
}

/**
 * Fetch and prepare one side's source document, or null when the side
 * cannot be highlighted (no source, binary/invalid UTF-8, no grammar).
 * `worktree_fallback` reads the file itself when no object is available:
 * git can print computed post-image OIDs for worktree content that is in
 * no object database (correspondence validation guards a racing edit).
 */
async function load_side(cwd: string, path: string | null, oid: string | null,
			 worktree_fallback: boolean): Promise<side_doc | null> {
	if (path === null) {
		return null;
	}
	let content: Buffer | null = null;
	if (oid !== null) {
		content = await cat_blob(cwd, oid);
	}
	if (content === null && worktree_fallback) {
		content = await read_worktree_file(cwd, path);
	}
	if (content === null || content.includes(0)) {
		return null;
	}
	const text = decode_utf8(content);
	if (text === null) {
		return null;
	}
	const first_newline = text.indexOf("\n");
	const first_line = first_newline === -1 ? text : text.slice(0, first_newline);
	const lang = detect_lang(path, first_line);
	if (lang === null || !(await ensure_lang(lang))) {
		return null;
	}
	const identity = oid !== null ? content_identity(cwd, oid) : content_identity(cwd, content);
	return { identity, lang, text, lines: text.split("\n") };
}

/**
 * Produce the highlighted output for a parsed file section, or null when
 * any correctness precondition fails and the raw bytes must be used.
 */
async function highlight_file_section(cwd: string, section: diff_section,
				      info: file_info): Promise<Buffer | null> {
	if (info.hunks.length === 0) {
		return null;
	}
	const check_path = info.new_path ?? info.old_path;
	if (check_path !== null && await has_textconv(cwd, check_path)) {
		logger.info("skipping {path}: textconv diff driver", { path: check_path });
		return null;
	}

	// The old side always has a real OID when retrievable at all; the new
	// side falls back to the worktree (all-zero OID for unstaged changes,
	// and computed OIDs whose blobs exist in no object database).
	const old_doc = await load_side(cwd, info.old_path, info.old_oid, false);
	const new_doc = await load_side(cwd, info.new_path, info.new_oid, true);
	if (old_doc === null && new_doc === null) {
		logger.debug("no sources for {path}", { path: check_path });
		return null;
	}

	const old_sgr = old_doc === null ? null :
		await highlight_lines(old_doc.identity, old_doc.lang, old_doc.text, info.old_last_line);
	const new_sgr = new_doc === null ? null :
		await highlight_lines(new_doc.identity, new_doc.lang, new_doc.text, info.new_last_line);

	// Validate every hunk body line against the mapped source line before
	// emitting anything; a single mismatch (racing worktree edit, an
	// unanticipated transformation) makes the whole section raw.
	const sgr_by_line = new Map<number, string | null>();
	for (const hunk of info.hunks) {
		let old_line = hunk.old_start;
		let new_line = hunk.new_start;
		for (const line_index of hunk.body) {
			const line = section.lines[line_index];
			const first = line.bytes.length > 0 ? line.bytes[0] : 0x20;
			let doc: side_doc | null;
			let sgr_lines: string[] | null;
			let doc_line: number;

			if (first === 0x2d) {
				doc = old_doc;
				sgr_lines = old_sgr;
				doc_line = old_line;
				old_line++;
			} else if (first === 0x2b) {
				doc = new_doc;
				sgr_lines = new_sgr;
				doc_line = new_line;
				new_line++;
			} else {
				doc = new_doc;
				sgr_lines = new_sgr;
				doc_line = new_line;
				old_line++;
				new_line++;
			}

			if (doc === null || sgr_lines === null || doc_line > sgr_lines.length ||
			    doc_line > doc.lines.length) {
				sgr_by_line.set(line_index, null);
				continue;
			}
			const body_text = line.bytes.subarray(1).toString("utf8");
			const source_line = doc.lines[doc_line - 1];
			if (body_text !== source_line) {
				logger.info("correspondence mismatch in {path} at source line {line}", {
					path: info.new_path ?? info.old_path, line: doc_line,
				});
				return null;
			}
			sgr_by_line.set(line_index, sgr_lines[doc_line - 1]);
		}
	}

	// All lines validated; rebuild the section.
	const parts: Buffer[] = [];
	for (let i = 0; i < section.lines.length; i++) {
		const line = section.lines[i];
		const sgr = sgr_by_line.get(i);
		if (sgr !== undefined && sgr !== null && line.bytes.length > 0) {
			parts.push(line.bytes.subarray(0, 1));
			parts.push(Buffer.from(sgr, "utf8"));
		} else if (line.bytes.includes(0x1b)) {
			parts.push(Buffer.from(frame_content(line.bytes.toString("latin1")), "latin1"));
		} else {
			parts.push(line.bytes);
		}
		if (line.had_newline) {
			parts.push(Buffer.from("\n"));
		}
	}
	return Buffer.concat(parts);
}

/** Process one section into its output bytes (highlighted or raw). */
export async function process_section(cwd: string, section: diff_section): Promise<Buffer> {
	if (section.kind === "file") {
		try {
			const info = parse_file_section(section);
			if (info !== null) {
				const highlighted = await highlight_file_section(cwd, section, info);
				if (highlighted !== null) {
					return highlighted;
				}
			} else {
				logger.debug("unparsed file section: {first}", {
					first: section.lines[0].bytes.toString("utf8").slice(0, 80),
				});
			}
		} catch (err) {
			logger.error("section processing failed, passing through: {err}", { err: String(err) });
		}
	}
	return raw_section_output(section);
}
