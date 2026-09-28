// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5
// Model-output: ChatGPT 6 Astra

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
import { configure } from "@logtape/logtape";
import { cat_blob, has_textconv, shed_git_state } from "../src/git.ts";

let repo: string;
let big_oid: string;
let small_oid: string;

beforeAll(async () => {
	await configure({
		sinks: {},
		loggers: [
			{ category: ["tig-syntax"], lowestLevel: "fatal", sinks: [] },
			{ category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
		],
	});
	repo = await mkdtemp(join(tmpdir(), "tig-syntax-git-test-"));
	execFileSync("git", ["-C", repo, "init", "-q"]);
	// 9 MiB: above the daemon's 8 MiB blob limit.
	await writeFile(join(repo, "big.bin"), Buffer.alloc(9 * 1024 * 1024, 0x61));
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
		// Requests after the rejection still resolve, and an
		// abbreviated OID comes back in full.
		const again = await cat_blob(repo, small_oid.slice(0, 12));
		expect(again).not.toBeNull();
		expect(again!.content.toString("utf8")).toBe("hello blob\n");
		expect(again!.oid).toBe(small_oid);
		expect(again!.identity).toMatch(/^sha256:/);
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
