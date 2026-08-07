// Model-output: Claude Fable 5

/**
 * Git plumbing used by the daemon.  Every operation takes the requesting
 * client's working directory explicitly (`git -C`): the daemon serves many
 * repositories and its own cwd is meaningless.
 *
 * Blob reads go through a persistent `git cat-file --batch` child per
 * repository plus an in-memory LRU, so that revisiting commits while
 * navigating in tig costs no process spawns.
 */

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";

const execfile_p = promisify(execFile);
const logger = getLogger(["tig-syntax", "git"]);

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BATCHERS = 8;
const BLOB_CACHE_ENTRIES = 128;

/** Cache of `cwd` -> worktree top-level directory (or null outside a repo). */
const toplevel_cache = new Map<string, string | null>();

/** Cache of `cwd\0path` -> whether a textconv diff driver applies. */
const textconv_cache = new Map<string, boolean>();

/** LRU of `cwd\0oid` -> blob content. */
const blob_cache = new Map<string, Buffer>();

/**
 * A persistent `git cat-file --batch` child for one repository.  Requests
 * are answered strictly in order, so a FIFO of pending resolvers plus an
 * incremental buffer parser is sufficient.
 */
class blob_batcher {
	private child: ChildProcessByStdio<Writable, Readable, null>;
	private pending: { resolve: (blob: Buffer | null) => void }[] = [];
	/** Unparsed stdout, as a chunk list to avoid per-chunk concatenation. */
	private chunks: Buffer[] = [];
	private buffered = 0;
	/** Size and blobness of the payload the last header announced. */
	private expecting: { size: number, is_blob: boolean } | null = null;
	broken = false;

	constructor(cwd: string) {
		this.child = spawn("git", ["-C", cwd, "cat-file", "--batch"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.child.on("error", () => {
			this.fail();
		});
		this.child.on("exit", () => {
			this.fail();
		});
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.chunks.push(chunk);
			this.buffered += chunk.length;
			this.drain();
		});
	}

	private fail(): void {
		this.broken = true;
		for (const entry of this.pending) {
			entry.resolve(null);
		}
		this.pending = [];
	}

	/** All buffered bytes as one Buffer (at most one concat per call). */
	private contiguous(): Buffer {
		if (this.chunks.length !== 1) {
			this.chunks = [Buffer.concat(this.chunks)];
		}
		return this.chunks[0];
	}

	private consume(bytes: number): void {
		this.chunks = [this.contiguous().subarray(bytes)];
		this.buffered -= bytes;
	}

	/**
	 * Parse complete responses, resolving strictly in request order.  Every
	 * announced payload is consumed even for non-blob objects (commits and
	 * trees, e.g. submodule OIDs), since leaving it would desynchronize the
	 * FIFO.  A payload above the blob limit kills the child instead: memory
	 * stays bounded and all pending requests degrade to null.
	 */
	private drain(): void {
		while (this.pending.length > 0) {
			if (this.expecting === null) {
				const data = this.contiguous();
				const nl = data.indexOf(0x0a);
				if (nl === -1) {
					return;
				}
				const header = data.subarray(0, nl).toString("utf8");
				this.consume(nl + 1);
				const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
				if (m === null) {
					// "<oid> missing": no payload follows.
					this.pending.shift()?.resolve(null);
					continue;
				}
				const size = parseInt(m[2], 10);
				if (size > MAX_BLOB_BYTES) {
					this.kill();
					this.fail();
					return;
				}
				this.expecting = { size, is_blob: m[1] === "blob" };
			}
			// Payload plus the trailing newline git appends.
			if (this.buffered < this.expecting.size + 1) {
				return;
			}
			const content = this.contiguous().subarray(0, this.expecting.size);
			const is_blob = this.expecting.is_blob;
			this.consume(this.expecting.size + 1);
			this.expecting = null;
			this.pending.shift()?.resolve(is_blob ? Buffer.from(content) : null);
		}
	}

	request(oid: string): Promise<Buffer | null> {
		if (this.broken) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			this.pending.push({ resolve });
			this.child.stdin.write(oid + "\n");
		});
	}

	kill(): void {
		this.child.kill();
	}
}

/** LRU of `cwd` -> live batcher. */
const batchers = new Map<string, blob_batcher>();

function get_batcher(cwd: string): blob_batcher {
	let batcher = batchers.get(cwd);
	if (batcher !== undefined && !batcher.broken) {
		batchers.delete(cwd);
		batchers.set(cwd, batcher);
		return batcher;
	}
	batcher = new blob_batcher(cwd);
	batchers.set(cwd, batcher);
	while (batchers.size > MAX_BATCHERS) {
		const oldest = batchers.keys().next().value as string;
		batchers.get(oldest)?.kill();
		batchers.delete(oldest);
	}
	return batcher;
}

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
 * the object is missing, not a blob, or exceeds the size limit.
 */
export async function cat_blob(cwd: string, oid: string): Promise<Buffer | null> {
	const key = cwd + "\0" + oid;
	const cached = blob_cache.get(key);
	if (cached !== undefined) {
		blob_cache.delete(key);
		blob_cache.set(key, cached);
		return cached;
	}
	const blob = await get_batcher(cwd).request(oid);
	if (blob === null) {
		logger.debug("no blob {oid} in {cwd}", { oid, cwd });
		return null;
	}
	if (blob.length > MAX_BLOB_BYTES) {
		return null;
	}
	blob_cache.set(key, blob);
	while (blob_cache.size > BLOB_CACHE_ENTRIES) {
		const oldest = blob_cache.keys().next().value as string;
		blob_cache.delete(oldest);
	}
	return blob;
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
	A(textconv_cache.size < 100000, "textconv cache unbounded");
	return result;
}
