// Model-output: Claude Fable 5

/**
 * Git plumbing used by the daemon.  Every operation takes the requesting
 * client's working directory and resolves it once (cached) to the
 * repository's canonical identities: the common git directory keys
 * object-level state (worktrees sharing one object store share batchers
 * and blob cache entries) and the worktree top level keys worktree-level
 * state (attribute lookups, file reads) — see plan item C4.
 *
 * Blob reads go through a persistent cat-file child per object store plus
 * a byte-budgeted LRU, so that revisiting commits while navigating in tig
 * costs no process spawns.  On git >= 2.36 the child runs `cat-file
 * --batch-command` and every request is preflighted with `info`, so
 * missing, non-blob, and oversized objects are rejected without ever
 * transferring their payloads; older git falls back to `--batch` with
 * incremental discarding.  Responses carry a content-derived identity
 * computed once per fetch, so callers can key shared caches
 * content-addressably even when the diff only gave an abbreviated OID.
 *
 * Textconv attribute checks batch through one persistent `git check-attr
 * --stdin -z` child per worktree (plan item C1) with driver-level
 * `git config` results cached per repository, so visiting an N-file
 * commit costs no attribute-related process spawns once the child exists.
 */

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";
import { ByteLRU } from "./lru.ts";
import { content_identity } from "./highlight.ts";
import { config } from "./config.ts";

const execfile_p = promisify(execFile);
const logger = getLogger(["tig-syntax", "git"]);

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BATCHERS = 8;

/** A blob response: git's echoed full OID, a content-derived cache
 * identity (computed once per fetch; the echoed OID must NOT key shared
 * caches because `refs/replace` makes git serve different bytes under the
 * same OID), and the content. */
export interface blob_result {
	oid: string;
	identity: string;
	content: Buffer;
}

/** A repository's canonical identities, resolved from a client cwd. */
export interface repo_identity {
	/** Absolute common git directory: identifies the object store. */
	common_dir: string;
	/** "sha1" or "sha256", or null when git predates --show-object-format. */
	object_format: string | null;
	/** Absolute worktree top level, or null for a bare repository. */
	toplevel: string | null;
}

/** Cache of `cwd` -> resolved identity (null = not a repository). */
const repo_cache = new Map<string, repo_identity | null>();

/** Cache of `toplevel\0path` -> whether a textconv diff driver applies. */
const textconv_cache = new Map<string, boolean>();

/** Cache of `toplevel\0driver` -> whether the driver configures textconv. */
const driver_cache = new Map<string, boolean>();

/** Byte-budgeted LRU of `common_dir\0requested_oid` -> blob. */
const blob_cache = new ByteLRU<blob_result>(config.blob_cache_mb * 1048576,
	(blob) => blob.content.length + 128);

/** In-flight blob fetches, so concurrent requests (e.g. a prefetch racing
 * the foreground view) share one child round-trip. */
const blob_inflight = new Map<string, Promise<blob_result | null>>();

/** Run one single-value rev-parse query; null on failure or no output.
 * The value is everything before the final newline git appends, so paths
 * containing newlines survive (which is also why the queries run one per
 * spawn: multi-value output has no unambiguous delimiter). */
async function rev_parse_one(cwd: string, flag: string): Promise<string | null> {
	try {
		const { stdout } = await execfile_p("git", ["-C", cwd, "rev-parse", flag]);
		const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
		return value === "" ? null : value;
	} catch {
		return null;
	}
}

/**
 * Resolve the canonical identity of the repository containing `cwd`, or
 * null when cwd is not inside one.  A few git spawns per distinct cwd,
 * cached for the daemon's lifetime.  Every field is validated: old git
 * versions ECHO unknown rev-parse options with exit status 0, so raw
 * output can never be trusted to be the requested value.
 */
export async function repo_info(cwd: string): Promise<repo_identity | null> {
	const cached = repo_cache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	// --git-common-dir (git >= 2.5) may print a cwd-relative path.
	const common_raw = await rev_parse_one(cwd, "--git-common-dir");
	let result: repo_identity | null = null;
	if (common_raw !== null && !common_raw.startsWith("--")) {
		const format_raw = await rev_parse_one(cwd, "--show-object-format");
		const toplevel_raw = await rev_parse_one(cwd, "--show-toplevel");
		result = {
			common_dir: resolve(cwd, common_raw),
			object_format: format_raw === "sha1" || format_raw === "sha256"
				? format_raw : null,
			toplevel: toplevel_raw !== null && toplevel_raw.startsWith("/")
				? toplevel_raw : null,
		};
	}
	repo_cache.set(cwd, result);
	return result;
}

/** Whether git supports `cat-file --batch-command` (git >= 2.36); probed
 * once per daemon from `git --version`. */
let batch_command_probe: Promise<boolean> | null = null;

function batch_command_supported(): Promise<boolean> {
	if (batch_command_probe === null) {
		batch_command_probe = (async () => {
			try {
				const { stdout } = await execfile_p("git", ["--version"]);
				const m = /git version (\d+)\.(\d+)/.exec(stdout);
				if (m === null) {
					return false;
				}
				const major = parseInt(m[1], 10);
				const minor = parseInt(m[2], 10);
				return major > 2 || (major === 2 && minor >= 36);
			} catch {
				return false;
			}
		})();
	}
	return batch_command_probe;
}

/** One request travelling through a blob batcher. */
interface blob_request {
	oid: string;
	resolve: (blob: blob_result | null) => void;
	/** Full OID from the info preflight (command mode only). */
	full_oid?: string;
}

/**
 * A persistent cat-file child for one object store.  Requests are answered
 * strictly in command order, so a FIFO of expectations plus an incremental
 * buffer parser is sufficient.
 *
 * In "command" mode (git >= 2.36) each request is `info <oid>` first, and
 * only satisfactory blobs get a `contents <oid>` follow-up, so missing,
 * non-blob, and oversized payloads are never transferred.  In "batch"
 * mode (older git) payloads always arrive, and an unwanted one resolves
 * null while being discarded incrementally as it streams — never
 * accumulated (memory stays bounded) and never fatal (requests pipelined
 * behind it, e.g. the other side of the same diff, must not be taken down
 * with it).
 */
class blob_batcher {
	private child: ChildProcessByStdio<Writable, Readable, null>;
	private mode: "command" | "batch";
	/** FIFO of what the next replies answer. */
	private expected: { kind: "info" | "contents", request: blob_request }[] = [];
	/** Unparsed stdout, as a chunk list to avoid per-chunk concatenation. */
	private chunks: Buffer[] = [];
	private buffered = 0;
	/** Size of the payload the last contents header announced. */
	private payload_size = -1;
	/** Bytes of an unwanted payload still being discarded. */
	private discard_left = 0;
	broken = false;

	constructor(dir: string, mode: "command" | "batch") {
		this.mode = mode;
		this.child = spawn("git", ["-C", dir, "cat-file",
			mode === "command" ? "--batch-command" : "--batch"], {
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
		for (const entry of this.expected) {
			entry.request.resolve(null);
		}
		this.expected = [];
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

	/** Take one full reply line from the buffer, or null when incomplete. */
	private take_line(): string | null {
		const data = this.contiguous();
		const nl = data.indexOf(0x0a);
		if (nl === -1) {
			return null;
		}
		const line = data.subarray(0, nl).toString("utf8");
		this.consume(nl + 1);
		return line;
	}

	private drain(): void {
		while (this.expected.length > 0 || this.discard_left > 0) {
			if (this.discard_left > 0) {
				const take = Math.min(this.discard_left, this.buffered);
				if (take === 0) {
					return;
				}
				this.consume(take);
				this.discard_left -= take;
				continue;
			}
			if (this.payload_size >= 0) {
				// Payload plus the trailing newline git appends.
				if (this.buffered < this.payload_size + 1) {
					return;
				}
				const entry = this.expected.shift();
				const content = this.contiguous().subarray(0, this.payload_size);
				const result: blob_result = {
					oid: entry?.request.full_oid ?? "",
					identity: "",
					content: Buffer.from(content),
				};
				this.consume(this.payload_size + 1);
				this.payload_size = -1;
				entry?.request.resolve(result);
				continue;
			}
			const line = this.take_line();
			if (line === null) {
				return;
			}
			const next = this.expected[0];
			A(next !== undefined, "cat-file reply without expectation");
			const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
			if (m === null) {
				// "<oid> missing"/"<oid> ambiguous": no payload follows.
				this.expected.shift();
				next.request.resolve(null);
				continue;
			}
			const size = parseInt(m[3], 10);
			const acceptable = m[2] === "blob" && size <= MAX_BLOB_BYTES;
			if (next.kind === "info") {
				this.expected.shift();
				if (!acceptable) {
					next.request.resolve(null);
					continue;
				}
				// Ask for the payload; its reply repeats the header.
				next.request.full_oid = m[1];
				this.expected.push({ kind: "contents", request: next.request });
				this.child.stdin.write(`contents ${next.request.oid}\n`);
				continue;
			}
			if (!acceptable) {
				this.expected.shift();
				next.request.resolve(null);
				// Payload plus the trailing newline git appends.
				this.discard_left = size + 1;
				continue;
			}
			next.request.full_oid = m[1];
			this.payload_size = size;
		}
	}

	request(oid: string): Promise<blob_result | null> {
		if (this.broken) {
			return Promise.resolve(null);
		}
		return new Promise((resolve_request) => {
			const request: blob_request = { oid, resolve: resolve_request };

			if (this.mode === "command") {
				this.expected.push({ kind: "info", request });
				this.child.stdin.write(`info ${oid}\n`);
			} else {
				this.expected.push({ kind: "contents", request });
				this.child.stdin.write(oid + "\n");
			}
		});
	}

	kill(): void {
		this.child.kill();
	}
}

/** LRU of object-store directory -> live batcher. */
const batchers = new Map<string, blob_batcher>();

async function get_batcher(dir: string): Promise<blob_batcher> {
	let batcher = batchers.get(dir);
	if (batcher !== undefined && !batcher.broken) {
		batchers.delete(dir);
		batchers.set(dir, batcher);
		return batcher;
	}
	batcher = new blob_batcher(dir, await batch_command_supported() ? "command" : "batch");
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
 * exceeds the size limit.  Concurrent requests for the same object share
 * one fetch.
 */
export async function cat_blob(cwd: string, oid: string): Promise<blob_result | null> {
	const info = await repo_info(cwd);
	const store = info?.common_dir ?? cwd;
	const key = store + "\0" + oid;
	const cached = blob_cache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const inflight = blob_inflight.get(key);
	if (inflight !== undefined) {
		return inflight;
	}
	const fetch = (async () => {
		const batcher = await get_batcher(store);
		let blob = await batcher.request(oid);
		if (blob === null && batcher.broken) {
			// The batcher died mid-flight — a real child failure.  One
			// retry on a fresh batcher for this innocent request.
			blob = await (await get_batcher(store)).request(oid);
		}
		if (blob === null) {
			logger.debug("no blob {oid} in {store}", { oid, store });
			return null;
		}
		// Hash once per fetch; cache hits reuse the stored identity.
		blob.identity = content_identity(blob.content);
		blob_cache.set(key, blob);
		return blob;
	})();
	blob_inflight.set(key, fetch);
	try {
		return await fetch;
	} finally {
		blob_inflight.delete(key);
	}
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
 * A persistent `git check-attr --stdin -z diff` child for one worktree.
 * Queries are answered strictly in order; -z output is NUL-separated
 * (path, attribute name, value) triples.
 */
class attr_batcher {
	private child: ChildProcessByStdio<Writable, Readable, null>;
	private pending: { resolve: (value: string | null) => void }[] = [];
	private carry: Buffer = Buffer.alloc(0);
	private fields: string[] = [];
	broken = false;

	constructor(root: string) {
		this.child = spawn("git", ["-C", root, "check-attr", "--stdin", "-z", "diff"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.child.on("error", () => {
			this.fail();
		});
		this.child.on("exit", () => {
			this.fail();
		});
		this.child.stdout.on("data", (chunk: Buffer) => {
			const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
			let start = 0;

			while (true) {
				const nul = data.indexOf(0, start);
				if (nul === -1) {
					break;
				}
				this.fields.push(data.subarray(start, nul).toString("utf8"));
				start = nul + 1;
				if (this.fields.length === 3) {
					this.pending.shift()?.resolve(this.fields[2]);
					this.fields = [];
				}
			}
			this.carry = Buffer.from(data.subarray(start));
		});
	}

	private fail(): void {
		this.broken = true;
		for (const entry of this.pending) {
			entry.resolve(null);
		}
		this.pending = [];
	}

	request(path: string): Promise<string | null> {
		if (this.broken) {
			return Promise.resolve(null);
		}
		return new Promise((resolve_request) => {
			this.pending.push({ resolve: resolve_request });
			this.child.stdin.write(path + "\0");
		});
	}

	kill(): void {
		this.child.kill();
	}
}

/** Worktree root -> live check-attr child. */
const attr_batchers = new Map<string, attr_batcher>();

function get_attr_batcher(root: string): attr_batcher {
	let batcher = attr_batchers.get(root);
	if (batcher !== undefined && !batcher.broken) {
		return batcher;
	}
	batcher = new attr_batcher(root);
	attr_batchers.set(root, batcher);
	while (attr_batchers.size > MAX_BATCHERS) {
		const oldest = attr_batchers.keys().next().value as string;
		attr_batchers.get(oldest)?.kill();
		attr_batchers.delete(oldest);
	}
	return batcher;
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
	const value = await get_attr_batcher(root).request(path);
	if (value !== null && value !== "unspecified" && value !== "unset" &&
	    value !== "set" && value !== "") {
		const driver_key = root + "\0" + value;
		const driver_cached = driver_cache.get(driver_key);

		if (driver_cached !== undefined) {
			result = driver_cached;
		} else {
			try {
				const { stdout } = await execfile_p("git",
					["-C", root, "config", "--get", `diff.${value}.textconv`]);
				result = stdout.trim().length > 0;
			} catch {
				result = false;
			}
			driver_cache.set(driver_key, result);
			A(driver_cache.size < 10000, "driver cache unbounded");
		}
	}
	textconv_cache.set(key, result);
	A(textconv_cache.size < 100000, "textconv cache unbounded");
	return result;
}

/**
 * Idle shedding (plan item B5): drop the blob cache and kill the
 * persistent git children — all cheap to rebuild on the next visit.  The
 * far more valuable tokenized-line cache is deliberately left alone.
 */
export function shed_git_state(): void {
	blob_cache.clear();
	for (const batcher of batchers.values()) {
		batcher.kill();
	}
	batchers.clear();
	for (const batcher of attr_batchers.values()) {
		batcher.kill();
	}
	attr_batchers.clear();
}
