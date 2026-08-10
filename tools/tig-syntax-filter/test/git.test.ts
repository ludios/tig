// Model-output: Claude Fable 5

/**
 * git.ts batcher behavior: an oversized blob kills the shared cat-file
 * child by design, but requests pipelined alongside it must survive via a
 * fresh batcher (C2 made both diff sides load concurrently, so one bad
 * side must not take the other down).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { cat_blob } from "../src/git.ts";

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
	// 9 MB: above the daemon's 8 MiB blob limit, so its batch response
	// kills the cat-file child.
	await writeFile(join(repo, "big.bin"), Buffer.alloc(9 * 1024 * 1024, 0x61));
	await writeFile(join(repo, "small.txt"), "hello blob\n");
	big_oid = execFileSync("git", ["-C", repo, "hash-object", "-w", "big.bin"],
		{ cwd: repo, encoding: "utf8" }).trim();
	small_oid = execFileSync("git", ["-C", repo, "hash-object", "-w", "small.txt"],
		{ cwd: repo, encoding: "utf8" }).trim();
}, 60000);

describe("cat_blob under a batcher kill", () => {
	it("still serves an innocent request pipelined with an oversized blob", async () => {
		const [big, small] = await Promise.all([
			cat_blob(repo, big_oid),
			cat_blob(repo, small_oid),
		]);
		expect(big).toBeNull();
		expect(small).not.toBeNull();
		expect(small!.content.toString("utf8")).toBe("hello blob\n");
		// The FIFO stays synchronized after the discard: later requests on
		// the same child still resolve correctly — and an abbreviated
		// request comes back with the full echoed OID (C4).
		const again = await cat_blob(repo, small_oid.slice(0, 12));
		expect(again).not.toBeNull();
		expect(again!.content.toString("utf8")).toBe("hello blob\n");
		expect(again!.oid).toBe(small_oid);
	});
});
