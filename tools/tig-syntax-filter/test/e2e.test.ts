// Model-output: Claude Fable 5

/**
 * End-to-end tests: the real C client talking to the real daemon over a
 * unix socket, fed by `git show` from a scratch repository.  These cover
 * the full production path (client spawn -> daemon listen -> highlight ->
 * framed output), including the environments that broke it in the field:
 * an unusable $XDG_RUNTIME_DIR (e.g. a session su'd from root keeps
 * /run/user/0) must fall back to the $TMPDIR socket, not degrade every
 * diff to raw passthrough.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tool_dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const client_bin = join(tool_dir, "bin", "tig-syntax-filter");
const daemon_script = join(tool_dir, "bin", "tig-syntax-daemon");

/** Style-selecting SGR prefix the daemon emits for every token run. */
const SGR_TOKEN = "\x1b[0;38;2;";

let work: string;
let repo: string;
let show_output: Buffer;

/** Environment for a filter run: inherited, minus daemon-locating
 * variables, plus isolated state/log and `overrides`. */
function filter_env(overrides: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	delete env.TIG_SYNTAX_SOCKET;
	delete env.XDG_RUNTIME_DIR;
	delete env.TMPDIR;
	env.TIG_SYNTAX_DAEMON = daemon_script;
	env.XDG_STATE_HOME = join(work, "state");
	return { ...env, ...overrides };
}

/** Run the client on `input` in the scratch repo; returns stdout. */
function run_filter(input: Buffer, env: Record<string, string>): Buffer {
	const result = spawnSync(client_bin, [], {
		cwd: repo, env, input, maxBuffer: 64 * 1048576,
	});
	expect(result.status).toBe(0);
	return result.stdout;
}

/** PIDs of daemon processes whose environment contains `marker` (a
 * test-unique path), for cleanup: the client spawns daemons detached. */
function daemon_pids(marker: string): number[] {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) {
			continue;
		}
		try {
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, "latin1");
			const environ = readFileSync(`/proc/${entry}/environ`, "latin1");
			if (cmdline.includes("daemon.ts") && environ.includes(marker)) {
				pids.push(Number(entry));
			}
		} catch {
			// Process vanished or is not ours; either way not a daemon to kill.
		}
	}
	return pids;
}

function kill_daemons(marker: string): void {
	for (const pid of daemon_pids(marker)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
}

/** Strip the daemon's SGR injections; the remainder must be the input
 * bytes (the fixture contains no literal ESC, so no 999-marker cases). */
function strip_sgr(output: Buffer): Buffer {
	return Buffer.from(output.toString("latin1").replaceAll(/\x1b\[[0-9;]*m/g, ""), "latin1");
}

function git(args: string[]): void {
	execFileSync("git", [
		"-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid",
		"-c", "commit.gpgsign=false", ...args,
	], { cwd: repo });
}

beforeAll(() => {
	execFileSync("make", ["-C", join(tool_dir, "client")], { stdio: "pipe" });

	work = mkdtempSync(join(tmpdir(), "tig-syntax-e2e-"));
	repo = join(work, "repo");
	mkdirSync(repo);
	mkdirSync(join(work, "state"));
	git(["init", "-q"]);
	const v1 = [
		"export function greet(name: string): string {",
		"\tconst prefix = \"hello\";",
		"\treturn `${prefix} ${name}`;",
		"}",
		"",
	].join("\n");
	const v2 = [
		"export function greet(name: string): string {",
		"\tconst prefix = \"hello there\";",
		"\tconst suffix = \"!\";",
		"\treturn `${prefix} ${name}${suffix}`;",
		"}",
		"",
	].join("\n");
	writeFileSync(join(repo, "greet.ts"), v1);
	git(["add", "greet.ts"]);
	git(["commit", "-q", "-m", "v1"]);
	writeFileSync(join(repo, "greet.ts"), v2);
	git(["commit", "-q", "-am", "v2"]);
	show_output = execFileSync("git", ["show", "HEAD"], { cwd: repo });
}, 120000);

afterAll(() => {
	if (work !== undefined) {
		kill_daemons(work);
	}
});

/** Assert that both deleted and added code lines carry token styling and
 * that stripping it reproduces the input diff exactly. */
function expect_highlighted(output: Buffer): void {
	const lines = output.toString("utf8").split("\n");
	const old_styled = lines.some((line) =>
		line.startsWith("-") && line.includes(SGR_TOKEN) && line.includes("prefix"));
	const new_styled = lines.some((line) =>
		line.startsWith("+") && line.includes(SGR_TOKEN) && line.includes("suffix"));
	expect(old_styled).toBe(true);
	expect(new_styled).toBe(true);
	expect(strip_sgr(output).equals(show_output)).toBe(true);
}

describe("client + daemon end to end", () => {
	it("highlights both sides of a git show diff", () => {
		const output = run_filter(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "e2e.sock"),
		}));
		expect_highlighted(output);
	}, 60000);

	it("falls back to the $TMPDIR socket when $XDG_RUNTIME_DIR is unusable", () => {
		// Owned by us but not writable: the same verdict a foreign
		// /run/user/<other-uid> produces, achievable without root.
		const bad_runtime = join(work, "bad-runtime");
		mkdirSync(bad_runtime);
		chmodSync(bad_runtime, 0o500);
		const fallback_tmp = join(work, "fallback-tmp");
		mkdirSync(fallback_tmp);
		const output = run_filter(show_output, filter_env({
			XDG_RUNTIME_DIR: bad_runtime,
			TMPDIR: fallback_tmp,
		}));
		expect_highlighted(output);
		const uid = process.geteuid?.() ?? 0;
		expect(readdirSync(fallback_tmp)).toContain(`tig-syntax-${uid}.sock`);
		// The daemon really is on the fallback socket (not some
		// pre-existing one): its environment carries our unique TMPDIR.
		expect(daemon_pids(fallback_tmp).length).toBeGreaterThan(0);
	}, 60000);

	it("emits the raw diff unchanged when no daemon can run", () => {
		const output = run_filter(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "no-such-dir", "absent.sock"),
			TIG_SYNTAX_DAEMON: "/bin/false",
		}));
		expect(output.equals(show_output)).toBe(true);
	}, 60000);
});
