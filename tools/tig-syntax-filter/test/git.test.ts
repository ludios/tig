/**
 * git.ts blob fetching: rejecting an oversized blob without disturbing
 * other requests, recovering after idle shedding, and sharing concurrent
 * fetches of one blob.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cat_blob, content_identity, has_textconv, shed_git_state, MAX_BLOB_BYTES } from "../src/git.ts";

let repo: string;
let big_oid: string;
let small_oid: string;

beforeAll(async () => {
	repo = await mkdtemp(join(tmpdir(), "tig-syntax-git-test-"));
	execFileSync("git", ["-C", repo, "init", "-q"]);
	await writeFile(join(repo, "big.bin"), Buffer.alloc(MAX_BLOB_BYTES + 1, 0x61));
	await writeFile(join(repo, "small.txt"), "hello blob\n");
	big_oid = execFileSync("git", ["-C", repo, "hash-object", "-w", "big.bin"],
		{ cwd: repo, encoding: "utf8" }).trim();
	small_oid = execFileSync("git", ["-C", repo, "hash-object", "-w", "small.txt"],
		{ cwd: repo, encoding: "utf8" }).trim();
}, 60000);

describe("cat_blob batching", () => {
	it("rejects an oversized blob without disrupting other requests", async () => {
		const [big, small] = await Promise.all([
			cat_blob(repo, big_oid),
			cat_blob(repo, small_oid),
		]);
		expect(big).toBeNull();
		expect(small).not.toBeNull();
		expect(small!.content.toString("utf8")).toBe("hello blob\n");
		// Requests after the rejection still resolve, abbreviated ones
		// included.
		const again = await cat_blob(repo, small_oid.slice(0, 12));
		expect(again).not.toBeNull();
		expect(again!.content.toString("utf8")).toBe("hello blob\n");
		expect(again!.identity).toBe(content_identity(again!.content));
		expect(again!.identity).toBe(small!.identity);
	});

	it("recovers transparently after idle shedding", async () => {
		shed_git_state();
		const blob = await cat_blob(repo, small_oid);
		expect(blob).not.toBeNull();
		expect(blob!.content.toString("utf8")).toBe("hello blob\n");
		expect(await has_textconv(repo, "small.txt")).toBe(false);
	});

	it("coalesces concurrent fetches of the same blob", async () => {
		shed_git_state();
		const [a, b] = await Promise.all([
			cat_blob(repo, small_oid),
			cat_blob(repo, small_oid),
		]);
		expect(a).not.toBeNull();
		expect(a).toBe(b);   // literally the same shared result object
	});
});
