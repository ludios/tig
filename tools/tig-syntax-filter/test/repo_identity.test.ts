// Model-output: Claude Fable 5

/**
 * C4/C6 behavior: canonical repository identities (subdirectories and
 * linked worktrees share the object store; attribute checks resolve
 * repo-relative paths from the top level), and the byte-budgeted LRU.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "@logtape/logtape";
import { repo_info, has_textconv, shed_git_state } from "../src/git.ts";
import { ByteLRU } from "../src/lru.ts";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
	await configure({
		sinks: {},
		loggers: [
			{ category: ["tig-syntax"], lowestLevel: "fatal", sinks: [] },
			{ category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
		],
	});
	repo = await mkdtemp(join(tmpdir(), "tig-syntax-repo-test-"));
	execFileSync("git", ["-C", repo, "init", "-q"]);
	await mkdir(join(repo, "sub", "dir"), { recursive: true });
	await writeFile(join(repo, ".gitattributes"), "*.secret diff=hexdump\n");
	await writeFile(join(repo, "sub", "dir", "keys.secret"), "s3kr1t\n");
	await writeFile(join(repo, "sub", "dir", "plain.c"), "int x;\n");
	git("config", "diff.hexdump.textconv", "xxd");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.invalid");
	git("add", "-A");
	git("commit", "-qm", "init");
}, 60000);

describe("repo_info", () => {
	it("resolves the same object store from the root and a subdirectory", async () => {
		const root = await repo_info(repo);
		const sub = await repo_info(join(repo, "sub", "dir"));
		expect(root).not.toBeNull();
		expect(sub).not.toBeNull();
		expect(sub!.common_dir).toBe(root!.common_dir);
		expect(sub!.toplevel).toBe(root!.toplevel);
		expect(["sha1", "sha256"]).toContain(root!.object_format);
	});

	it("resolves a linked worktree to the shared object store", async () => {
		const wt = `${repo}-wt`;   // unique per run: derived from mkdtemp
		git("worktree", "add", "-q", wt);
		const main = await repo_info(repo);
		const linked = await repo_info(wt);
		expect(linked).not.toBeNull();
		expect(linked!.common_dir).toBe(main!.common_dir);
		expect(linked!.toplevel).not.toBe(main!.toplevel);
	});

	it("returns null outside any repository", async () => {
		expect(await repo_info(tmpdir())).toBeNull();
	});
});

describe("has_textconv from a subdirectory", () => {
	it("resolves repo-relative paths from the top level, not the cwd", async () => {
		const subdir = join(repo, "sub", "dir");
		// From the subdirectory cwd, the repo-relative path does not exist
		// relative to cwd; the attribute must still be found.
		expect(await has_textconv(subdir, "sub/dir/keys.secret")).toBe(true);
		expect(await has_textconv(subdir, "sub/dir/plain.c")).toBe(false);
	});

	it("observes .gitattributes and config edits after attr state resets", async () => {
		// Persistent check-attr children and verdict caches must not pin
		// stale rules forever; shedding is one reset boundary (the 60 s
		// TTL is the other, not exercised here for test speed).
		await writeFile(join(repo, ".gitattributes"), "");
		shed_git_state();
		expect(await has_textconv(repo, "sub/dir/keys.secret")).toBe(false);
		await writeFile(join(repo, ".gitattributes"), "*.secret diff=hexdump\n");
		shed_git_state();
		expect(await has_textconv(repo, "sub/dir/keys.secret")).toBe(true);
	});
});

describe("ByteLRU", () => {
	const sized = () => new ByteLRU<string>(100, (v) => v.length);

	it("evicts oldest entries past the byte budget", () => {
		const lru = sized();
		lru.set("a", "x".repeat(40));
		lru.set("b", "x".repeat(40));
		lru.set("c", "x".repeat(40));   // 120 > 100: evicts a
		expect(lru.get("a")).toBeUndefined();
		expect(lru.get("b")).toBeDefined();
		expect(lru.get("c")).toBeDefined();
		expect(lru.bytes).toBe(80);
	});

	it("refreshes recency on get", () => {
		const lru = sized();
		lru.set("a", "x".repeat(40));
		lru.set("b", "x".repeat(40));
		lru.get("a");
		lru.set("c", "x".repeat(40));   // evicts b, not a
		expect(lru.get("a")).toBeDefined();
		expect(lru.get("b")).toBeUndefined();
	});

	it("refuses entries larger than half the budget", () => {
		const lru = sized();
		lru.set("big", "x".repeat(60));
		expect(lru.get("big")).toBeUndefined();
		expect(lru.size).toBe(0);
	});

	it("replaces an existing key without double-counting", () => {
		const lru = sized();
		lru.set("a", "x".repeat(40));
		lru.set("a", "x".repeat(30));
		expect(lru.bytes).toBe(30);
		expect(lru.size).toBe(1);
	});
});
