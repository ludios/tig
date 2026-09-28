// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5
// Model-output: ChatGPT 6 Astra

/**
 * Section processing: turn one diff section into output bytes, either
 * highlighted (when every correctness precondition holds) or the raw
 * input bytes.  Pure with respect to the connection layer, so it is
 * directly testable.
 *
 * Output invariant: stripping injected SGR sequences and unescaping the
 * literal-ESC marker yields the section's input bytes exactly.
 */

import { createHash } from "node:crypto";
import { getLogger } from "@logtape/logtape";
import { parse_file_section, type diff_section, type file_info } from "./diff_parser.ts";
import { ensure_lang, highlight_lines, frame_content } from "./highlight.ts";
import { detect_lang } from "./lang_map.ts";
import { cat_blob, content_identity, read_worktree_file, has_textconv, repo_info } from "./git.ts";
import { config } from "./config.ts";

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

/** Content identities known to contain NUL bytes or invalid UTF-8; the
 * set is cleared wholesale at UNDECODABLE_MAX entries. */
const undecodable = new Set<string>();
const UNDECODABLE_MAX = 4096;

/** Decode a Buffer as strict UTF-8, or null when it is not valid UTF-8.
 * A leading byte-order mark is kept (as U+FEFF), not silently dropped. */
function decode_utf8(bytes: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

function remember_undecodable(identity: string): void {
	if (undecodable.size >= UNDECODABLE_MAX) {
		undecodable.clear();
	}
	undecodable.add(identity);
}

const BOM = "\uFEFF";

/**
 * The source document for one side of a file diff: its full text and a
 * cache identity.  `lines` excludes newline characters.  `bom` is the
 * byte-order mark ("\uFEFF", or "" when absent) that starts the file and
 * so line 1 of the diff, but not `text`: editors strip it before
 * tokenizing, and a grammar would mistake it for code.
 */
interface side_doc {
	identity: string;
	lang: string;
	bom: string;
	text: string;
	lines: string[];
}

/** Whether `content` hashes to the (possibly abbreviated) blob `oid`
 * under the repository's hash algorithm (both are tried only when the
 * repository's algorithm could not be resolved). */
async function content_matches_oid(cwd: string, content: Buffer, oid: string): Promise<boolean> {
	const info = await repo_info(cwd);
	const algorithms = info?.object_format != null ? [info.object_format] : ["sha1", "sha256"];
	const header = Buffer.from(`blob ${content.length}\0`);
	for (const algorithm of algorithms) {
		const hex = createHash(algorithm).update(header).update(content).digest("hex");
		if (hex.startsWith(oid)) {
			return true;
		}
	}
	return false;
}

/**
 * Fetch and prepare one side's source document, or null when the side
 * cannot be highlighted (no source, NUL bytes or invalid UTF-8, no
 * grammar).  With `worktree_fallback`, a side whose object is absent or
 * missing is read from the worktree, since git prints computed OIDs for
 * worktree content that is in no object database.  Worktree content must
 * still hash to the diff's OID, if there is one: the file may have
 * changed since.
 */
async function load_side(cwd: string, path: string | null, oid: string | null,
			 worktree_fallback: boolean): Promise<side_doc | null> {
	if (path === null) {
		return null;
	}
	let content: Buffer | null = null;
	let identity: string | null = null;
	if (oid !== null) {
		const blob = await cat_blob(cwd, oid);
		if (blob !== null) {
			content = blob.content;
			identity = blob.identity;
		}
	}
	if (content === null && worktree_fallback) {
		const file = await read_worktree_file(cwd, path);
		if (file !== null && (oid === null || await content_matches_oid(cwd, file, oid))) {
			content = file;
			identity = content_identity(file);
		}
	}
	if (content === null || identity === null) {
		return null;
	}
	if (undecodable.has(identity)) {
		return null;
	}
	if (content.includes(0)) {
		remember_undecodable(identity);
		return null;
	}
	const decoded = decode_utf8(content);
	if (decoded === null) {
		remember_undecodable(identity);
		return null;
	}
	const bom = decoded.startsWith(BOM) ? BOM : "";
	const text = decoded.slice(bom.length);
	const first_newline = text.indexOf("\n");
	const first_line = first_newline === -1 ? text : text.slice(0, first_newline);
	const lang = detect_lang(path, first_line);
	if (lang === null || !(await ensure_lang(lang))) {
		return null;
	}
	return { identity, lang, bom, text, lines: text.split("\n") };
}

/**
 * Produce the highlighted output for a parsed file section, or null when
 * any correctness precondition fails and the raw bytes must be used.
 */
async function highlight_file_section(cwd: string, section: diff_section,
				      info: file_info,
				      cancelled?: () => boolean): Promise<Buffer | null> {
	if (info.hunks.length === 0) {
		return null;
	}
	// git applies each side's own diff driver, so a rename can put textconv
	// output on one side only.
	const paths = [...new Set([info.old_path, info.new_path])]
		.filter((path): path is string => path !== null);
	const textconv = await Promise.all(paths.map((path) => has_textconv(cwd, path)));
	const textconv_path = paths.find((_, i) => textconv[i]);
	if (textconv_path !== undefined) {
		logger.info("skipping {path}: textconv diff driver", { path: textconv_path });
		return null;
	}
	const check_path = info.new_path ?? info.old_path;

	// Load only the sides the hunks style, concurrently: "-" lines use the
	// old source, "+" and context lines the new one.  Only the new side can
	// be worktree content (an all-zero OID for unstaged changes, or a
	// computed OID with no object behind it).
	const [old_doc, new_doc] = await Promise.all([
		info.old_last_line === 0 ? null : load_side(cwd, info.old_path, info.old_oid, false),
		info.new_last_line === 0 ? null : load_side(cwd, info.new_path, info.new_oid, true),
	]);
	if (old_doc === null && new_doc === null) {
		logger.debug("no sources for {path}", { path: check_path });
		return null;
	}
	// Log a side that failed to load while the other did: its lines render
	// raw next to highlighted ones (e.g. an old blob missing from a shallow
	// or partial clone).
	if (old_doc === null && info.old_last_line !== 0 && info.old_path !== null) {
		logger.info("old side of {path} unavailable ({oid}); its lines will be raw", {
			path: check_path, oid: info.old_oid,
		});
	}
	if (new_doc === null && info.new_last_line !== 0 && info.new_path !== null) {
		logger.info("new side of {path} unavailable ({oid}); its lines will be raw", {
			path: check_path, oid: info.new_oid,
		});
	}

	// One tokenization budget for the whole section, shared by both sides;
	// blob fetching and grammar loading above deliberately do not count.
	const deadline = performance.now() + config.budget_ms;
	const old_sgr = old_doc === null ? null :
		await highlight_lines(old_doc.identity, old_doc.lang, old_doc.text, info.old_last_line, deadline, cancelled);
	const new_sgr = new_doc === null ? null :
		await highlight_lines(new_doc.identity, new_doc.lang, new_doc.text, info.new_last_line, deadline, cancelled);
	if (old_sgr === null && new_sgr === null) {
		// Nothing to style (budget exhausted or size-guarded): the raw
		// path produces identical bytes without validation/rebuild work.
		return null;
	}

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
			// The diff shows a byte-order mark as part of line 1; it passes
			// through unstyled ahead of the line's tokens.
			const lead = doc_line === 1 ? doc.bom : "";
			const source_line = doc.lines[doc_line - 1];
			// Bytes, not decoded text: decoding would equate an invalid
			// byte in the diff with a U+FFFD in the source, and the
			// emitted line would then differ from the input.
			if (!line.bytes.subarray(1).equals(Buffer.from(lead + source_line, "utf8"))) {
				logger.info("correspondence mismatch in {path} at source line {line}", {
					path: info.new_path ?? info.old_path, line: doc_line,
				});
				return null;
			}
			sgr_by_line.set(line_index, lead + sgr_lines[doc_line - 1]);
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

/** Process one section into its output bytes (highlighted or raw).
 * `cancelled` lets a dead connection stop tokenization between chunks. */
export async function process_section(cwd: string, section: diff_section,
					cancelled?: () => boolean): Promise<Buffer> {
	if (section.kind === "file") {
		try {
			const info = parse_file_section(section);
			if (info !== null) {
				const highlighted = await highlight_file_section(cwd, section, info, cancelled);
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
