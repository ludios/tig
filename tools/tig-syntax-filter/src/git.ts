// Model-output: Claude Fable 5

/**
 * Git plumbing used by the daemon.  Every operation takes the requesting
 * client's working directory explicitly (`git -C`): the daemon serves many
 * repositories and its own cwd is meaningless.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";

const execfile_p = promisify(execFile);
const logger = getLogger(["tig-syntax", "git"]);

const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Cache of `cwd` -> worktree top-level directory (or null outside a repo). */
const toplevel_cache = new Map<string, string | null>();

/** Cache of `cwd\0path` -> whether a textconv diff driver applies. */
const textconv_cache = new Map<string, boolean>();

/**
 * The worktree top-level directory for a repository at `cwd`, or null when
 * git cannot resolve one (bare repository, not a repository).
 */
export async function get_toplevel(cwd: string): Promise<string | null> {
	const cached = toplevel_cache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	let result: string | null;
	try {
		const { stdout } = await execfile_p("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
		result = stdout.trim() || null;
	} catch {
		result = null;
	}
	toplevel_cache.set(cwd, result);
	return result;
}

/**
 * The full content of blob `oid` in the repository at `cwd`, or null when
 * the object is missing or exceeds the size limit.
 */
export async function cat_blob(cwd: string, oid: string): Promise<Buffer | null> {
	try {
		const { stdout } = await execfile_p("git", ["-C", cwd, "cat-file", "blob", oid],
			{ encoding: "buffer", maxBuffer: MAX_BLOB_BYTES });
		return stdout;
	} catch (err) {
		logger.debug("cat-file failed for {oid} in {cwd}: {err}", { oid, cwd, err: String(err) });
		return null;
	}
}

/**
 * The worktree file content for repository-relative `path`, or null when
 * unreadable or exceeding the size limit.
 */
export async function read_worktree_file(cwd: string, path: string): Promise<Buffer | null> {
	const toplevel = await get_toplevel(cwd);
	if (toplevel === null) {
		return null;
	}
	try {
		const content = await readFile(join(toplevel, path));
		if (content.length > MAX_BLOB_BYTES) {
			return null;
		}
		return content;
	} catch {
		return null;
	}
}

/**
 * Whether git applies a textconv diff driver to `path` in the repository at
 * `cwd`.  Textconv means git may show transformed rather than literal blob
 * content, so such files must not be highlighted from raw sources.
 */
export async function has_textconv(cwd: string, path: string): Promise<boolean> {
	const key = cwd + "\0" + path;
	const cached = textconv_cache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	let result = false;
	try {
		const { stdout } = await execfile_p("git", ["-C", cwd, "check-attr", "diff", "--", path]);
		// Format: "<path>: diff: <value>"
		const value = stdout.trim().split(": ").pop() ?? "";
		if (value !== "unspecified" && value !== "unset" && value !== "set" && value !== "") {
			try {
				const { stdout: conv } = await execfile_p("git",
					["-C", cwd, "config", "--get", `diff.${value}.textconv`]);
				result = conv.trim().length > 0;
			} catch {
				result = false;
			}
		}
	} catch {
		result = false;
	}
	textconv_cache.set(key, result);
	return result;
}
