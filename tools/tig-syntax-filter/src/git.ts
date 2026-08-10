// Model-output: Claude Fable 5

/**
 * Git plumbing used by the daemon.  Every operation takes the requesting
 * client's working directory and resolves it once (cached) to the
 * repository's canonical identities: the common git directory keys
 * object-level state (worktrees sharing one object store share batchers
 * and blob cache entries) and the worktree top level keys worktree-level
 * state (attribute lookups, file reads) — see plan item C4.
 *
 * Blob reads go through a persistent `git cat-file --batch` child per
 * object store plus a byte-budgeted LRU, so that revisiting commits while
 * navigating in tig costs no process spawns.  Responses carry the full
 * OID git echoes, so callers can key caches content-addressably even when
 * the diff only gave an abbreviated OID.
 */

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";
import { byte_lru } from "./lru.ts";
import { config } from "./config.ts";

const execfile_p = promisify(execFile);
const logger = getLogger(["tig-syntax", "git"]);

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BATCHERS = 8;

/** A blob response: git's echoed full OID and the content. */
export interface blob_result {
	oid: string;
	content: Buffer;
}

/** A repository's canonical identities, resolved from a client cwd. */
export interface repo_identity {
	/** Absolute common git directory: identifies the object store. */
	common_dir: string;
	/** "sha1" or "sha256". */
	object_format: string;
	/** Absolute worktree top level, or null for a bare repository. */
	toplevel: string | null;
}

/** Cache of `cwd` -> resolved identity (null = not a repository). */
const repo_cache = new Map<string, repo_identity | null>();

/** Cache of `toplevel\0path` -> whether a textconv diff driver applies. */
const textconv_cache = new Map<string, boolean>();

/** Byte-budgeted LRU of `common_dir\0requested_oid` -> blob. */
const blob_cache = new byte_lru<blob_result>(config.blob_cache_mb * 1048576,
	(blob) => blob.content.length + 128);

/**
 * Resolve the canonical identity of the repository containing `cwd`, or
 * null when cwd is not inside one.  One git spawn per distinct cwd, cached
 * for the daemon's lifetime.
 */
export async function repo_info(cwd: string): Promise<repo_identity | null> {
	const cached = repo_cache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	let result: repo_identity | null = null;
	try {
		// --show-toplevel prints nothing in a bare repository, so it goes
		// last where a missing line is detectable.
		const { stdout } = await execfile_p("git", ["-C", cwd, "rev-parse",
			"--path-format=absolute", "--git-common-dir",
			"--show-object-format", "--show-toplevel"]);
		const lines = stdout.split("\n").filter((line) => line !== "");
		if (lines.length >= 2) {
			result = {
				common_dir: lines[0],
				object_format: lines[1],
				toplevel: lines.length >= 3 ? lines[2] : null,
			};
		}
	} catch {
		result = null;
	}
	repo_cache.set(cwd, result);
	return result;
}

/**
 * A persistent `git cat-file --batch` child for one object store.  Requests
 * are answered strictly in order, so a FIFO of pending resolvers plus an
 * incremental buffer parser is sufficient.
 */
class blob_batcher {
	private child: ChildProcessByStdio<Writable, Readable, null>;
	private pending: { resolve: (blob: blob_result | null) => void }[] = [];
	/** Unparsed stdout, as a chunk list to avoid per-chunk concatenation. */
	private chunks: Buffer[] = [];
	private buffered = 0;
	/** Full OID, size, and blobness announced by the last header. */
	private expecting: { oid: string, size: number, is_blob: boolean } | null = null;
	/** Bytes of an oversized payload still being discarded. */
	private discard_left = 0;
	broken = false;

	constructor(dir: string) {
		this.child = spawn("git", ["-C", dir, "cat-file", "--batch"], {
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
	 * FIFO.  A payload above the blob limit resolves null and is discarded
	 * incrementally as it arrives — never accumulated (memory stays
	 * bounded) and never fatal (requests pipelined behind it, e.g. the
	 * other side of the same diff, must not be taken down with it).
	 */
	private drain(): void {
		while (this.pending.length > 0 || this.discard_left > 0) {
			if (this.discard_left > 0) {
				const take = Math.min(this.discard_left, this.buffered);
				if (take === 0) {
					return;
				}
				this.consume(take);
				this.discard_left -= take;
				continue;
			}
			if (this.expecting === null) {
				const data = this.contiguous();
				const nl = data.indexOf(0x0a);
				if (nl === -1) {
					return;
				}
				const header = data.subarray(0, nl).toString("utf8");
				this.consume(nl + 1);
				const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
				if (m === null) {
					// "<oid> missing"/"<oid> ambiguous": no payload.
					this.pending.shift()?.resolve(null);
					continue;
				}
				const size = parseInt(m[3], 10);
				if (size > MAX_BLOB_BYTES) {
					this.pending.shift()?.resolve(null);
					// Payload plus the trailing newline git appends.
					this.discard_left = size + 1;
					continue;
				}
				this.expecting = { oid: m[1], size, is_blob: m[2] === "blob" };
			}
			// Payload plus the trailing newline git appends.
			if (this.buffered < this.expecting.size + 1) {
				return;
			}
			const content = this.contiguous().subarray(0, this.expecting.size);
			const { oid, is_blob } = this.expecting;
			this.consume(this.expecting.size + 1);
			this.expecting = null;
			this.pending.shift()?.resolve(
				is_blob ? { oid, content: Buffer.from(content) } : null);
		}
	}

	request(oid: string): Promise<blob_result | null> {
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

/** LRU of object-store directory -> live batcher. */
const batchers = new Map<string, blob_batcher>();

function get_batcher(dir: string): blob_batcher {
	let batcher = batchers.get(dir);
	if (batcher !== undefined && !batcher.broken) {
		batchers.delete(dir);
		batchers.set(dir, batcher);
		return batcher;
	}
	batcher = new blob_batcher(dir);
	batchers.set(dir, batcher);
	while (batchers.size > MAX_BATCHERS) {
		const oldest = batchers.keys().next().value as string;
		batchers.get(oldest)?.kill();
		batchers.delete(oldest);
	}
	return batcher;
}

/**
 * The blob `oid` (possibly abbreviated) in the repository at `cwd`, with
 * git's full OID, or null when the object is missing, not a blob, or
 * exceeds the size limit.
 */
export async function cat_blob(cwd: string, oid: string): Promise<blob_result | null> {
	const info = await repo_info(cwd);
	const store = info?.common_dir ?? cwd;
	const key = store + "\0" + oid;
	const cached = blob_cache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const batcher = get_batcher(store);
	let blob = await batcher.request(oid);
	if (blob === null && batcher.broken) {
		// The batcher died mid-flight — a real child failure (oversized
		// payloads are discarded, not fatal).  One retry on a fresh
		// batcher for this innocent request.
		blob = await get_batcher(store).request(oid);
	}
	if (blob === null) {
		logger.debug("no blob {oid} in {store}", { oid, store });
		return null;
	}
	blob_cache.set(key, blob);
	return blob;
}

/**
 * The worktree file content for repository-relative `path`, or null when
 * unreadable or exceeding the size limit.
 */
export async function read_worktree_file(cwd: string, path: string): Promise<Buffer | null> {
	const info = await repo_info(cwd);
	if (info === null || info.toplevel === null) {
		return null;
	}
	try {
		const content = await readFile(join(info.toplevel, path));
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
 * `path` is repository-relative, so the attribute check runs from the
 * worktree top level — running it from a subdirectory cwd would resolve
 * the path against the wrong location.
 */
export async function has_textconv(cwd: string, path: string): Promise<boolean> {
	const info = await repo_info(cwd);
	const root = info?.toplevel ?? cwd;
	const key = root + "\0" + path;
	const cached = textconv_cache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	let result = false;
	try {
		const { stdout } = await execfile_p("git", ["-C", root, "check-attr", "diff", "--", path]);
		// Format: "<path>: diff: <value>"
		const value = stdout.trim().split(": ").pop() ?? "";
		if (value !== "unspecified" && value !== "unset" && value !== "set" && value !== "") {
			try {
				const { stdout: conv } = await execfile_p("git",
					["-C", root, "config", "--get", `diff.${value}.textconv`]);
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
