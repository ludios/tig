// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5
// Model-output: ChatGPT 6 Astra

/**
 * End-to-end tests of the C client: against the real daemon over a unix
 * socket, fed `git show` output from a scratch repository (highlighting,
 * socket fallback, slow and failed starts, concurrent clients), and
 * against scripted daemons (fallback and deadlines).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";

const tool_dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const client_bin = join(tool_dir, "bin", "tig-syntax-filter");
const daemon_script = join(tool_dir, "bin", "tig-syntax-daemon");

/** Style-selecting SGR prefix the daemon emits for every token run. */
const SGR_TOKEN = "\x1b[0;38;2;";

let work: string;
let repo: string;
let show_output: Buffer;

/** Environment for a filter run: inherited, minus daemon-locating
 * variables, plus isolated state/log/cache and `overrides`. */
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
	delete env.NODE_COMPILE_CACHE;
	delete env.NODE_DISABLE_COMPILE_CACHE;
	env.TIG_SYNTAX_DAEMON = daemon_script;
	env.XDG_STATE_HOME = join(work, "state");
	env.XDG_CACHE_HOME = join(work, "cache");
	return { ...env, ...overrides };
}

/** Run the client on `input` in the scratch repo; returns stdout and
 * the wall time the run took. */
function run_filter_timed(input: Buffer, env: Record<string, string>): { output: Buffer, ms: number } {
	const started = performance.now();
	const result = spawnSync(client_bin, [], {
		cwd: repo, env, input, maxBuffer: 64 * 1048576,
	});
	const ms = performance.now() - started;
	expect(result.status).toBe(0);
	return { output: result.stdout, ms };
}

/** Run the client on `input` in the scratch repo; returns stdout. */
function run_filter(input: Buffer, env: Record<string, string>): Buffer {
	return run_filter_timed(input, env).output;
}

/** Run the client asynchronously; resolves to stdout once it exits. */
function run_filter_async(input: Buffer, env: Record<string, string>): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(client_bin, [], { cwd: repo, env });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", reject);
		child.on("close", (status) => {
			if (status !== 0) {
				reject(new Error(`client exited with ${status}`));
				return;
			}
			resolve(Buffer.concat(chunks));
		});
		child.stdin.end(input);
	});
}

/** Write an executable daemon launcher script `name` into the work dir
 * with the given shell body; returns its path. */
function write_launcher(name: string, body: string): string {
	const path = join(work, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** PIDs of other processes whose environment contains `marker` (a
 * test-unique path) and whose command line contains `cmdline_needle`:
 * daemons by default; with "", also launchers still sleeping before they
 * exec the daemon.  Empty without procfs (e.g. macOS); spawned daemons
 * then outlive the suite until they idle-exit. */
function daemon_pids(marker: string, cmdline_needle = "start.mjs"): number[] {
	const pids: number[] = [];
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return pids;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) {
			continue;
		}
		try {
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, "latin1");
			const environ = readFileSync(`/proc/${entry}/environ`, "latin1");
			if (Number(entry) !== process.pid && cmdline.includes(cmdline_needle) &&
			    environ.includes(marker)) {
				pids.push(Number(entry));
			}
		} catch {
			// Process vanished or is not ours; either way not a daemon to kill.
		}
	}
	return pids;
}

function kill_daemons(marker: string): void {
	for (const pid of daemon_pids(marker, "")) {
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

	it("writes its compile cache while running, not only at exit", () => {
		const cache_home = join(work, "cache-running");
		const output = run_filter(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "cache-running.sock"),
			XDG_CACHE_HOME: cache_home,
		}));
		expect_highlighted(output);
		// The daemon is still running: node's write at clean exit has
		// not happened, so these came from the flush after listening.
		const cache_dir = join(cache_home, "tig-syntax", "node-compile-cache");
		expect(readdirSync(cache_dir, { recursive: true }).length).toBeGreaterThan(10);
	}, 60000);

	it("still highlights without a usable compile cache directory", () => {
		// A regular file where the cache home should be: the cache
		// cannot be created there.
		const file_home = join(work, "cache-is-a-file");
		writeFileSync(file_home, "");
		expect_highlighted(run_filter(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "cache-file.sock"),
			XDG_CACHE_HOME: file_home,
		})));
		// A relative cache home would land inside the viewed repository,
		// whose contents may be hostile: ignored, as the XDG spec says,
		// in favor of the home directory's.
		const home = join(work, "home");
		expect_highlighted(run_filter(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "cache-relative.sock"),
			XDG_CACHE_HOME: "relative-cache",
			HOME: home,
		})));
		expect(readdirSync(repo)).not.toContain("relative-cache");
		expect(readdirSync(join(home, ".cache", "tig-syntax", "node-compile-cache")).length).toBe(1);
	}, 60000);

	it("falls back to the $TMPDIR socket when $XDG_RUNTIME_DIR is unusable", () => {
		// A regular file, not a directory: unusable as a socket home
		// no matter the privileges (a mode-0500 directory would look
		// writable when the suite runs as root), producing the same
		// verdict a foreign /run/user/<other-uid> does.
		const bad_runtime = join(work, "bad-runtime");
		writeFileSync(bad_runtime, "");
		const fallback_tmp = join(work, "fallback-tmp");
		mkdirSync(fallback_tmp);
		const output = run_filter(show_output, filter_env({
			XDG_RUNTIME_DIR: bad_runtime,
			TMPDIR: fallback_tmp,
		}));
		expect_highlighted(output);
		const uid = process.geteuid?.() ?? 0;
		const socket_name = new RegExp(`^tig-syntax-${uid}-[0-9a-f]{12}\\.sock$`);
		expect(readdirSync(fallback_tmp).some((name) => socket_name.test(name))).toBe(true);
		// The daemon really is on the fallback socket (not some
		// pre-existing one): its environment carries our unique TMPDIR.
		// procfs-only evidence, so asserted only where procfs exists.
		if (process.platform === "linux") {
			expect(daemon_pids(fallback_tmp).length).toBeGreaterThan(0);
		}
	}, 60000);

	it("emits the raw diff unchanged, and promptly, when no daemon can run", () => {
		// The launcher exits with a failure: no waiting out the spawn
		// window (60 s by default) for a daemon that will never listen.
		const { output, ms } = run_filter_timed(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "no-such-dir", "absent.sock"),
			TIG_SYNTAX_DAEMON: "/bin/false",
		}));
		expect(output.equals(show_output)).toBe(true);
		expect(ms).toBeLessThan(2000);
	}, 60000);

	it("waits for a slow daemon start rather than falling back", () => {
		// Cold starts on slow or cache-cold machines can take seconds.
		const launcher = write_launcher("slow-daemon.sh",
			`sleep 3.5\nexec ${JSON.stringify(daemon_script)}`);
		const { output, ms } = run_filter_timed(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "slow.sock"),
			TIG_SYNTAX_DAEMON: launcher,
		}));
		expect_highlighted(output);
		expect(ms).toBeGreaterThanOrEqual(3400);
	}, 60000);

	it("keeps waiting after a launcher exits successfully, up to the spawn wait", () => {
		// Exit 0 means "yielded to a live daemon" or "daemonized on its
		// own" — not conclusive — so the wait continues to the limit.
		const launcher = write_launcher("yield-daemon.sh", "exit 0");
		const { output, ms } = run_filter_timed(show_output, filter_env({
			TIG_SYNTAX_SOCKET: join(work, "yield.sock"),
			TIG_SYNTAX_DAEMON: launcher,
			TIG_SYNTAX_SPAWN_WAIT_MS: "600",
		}));
		expect(output.equals(show_output)).toBe(true);
		expect(ms).toBeGreaterThanOrEqual(550);
		expect(ms).toBeLessThan(3000);
	}, 60000);

	it("starts one daemon for concurrent clients on a cold socket", async () => {
		const launcher = write_launcher("herd-daemon.sh",
			`sleep 1.5\nexec ${JSON.stringify(daemon_script)}`);
		const marker = join(work, "herd-state");
		mkdirSync(marker);
		const env = filter_env({
			TIG_SYNTAX_SOCKET: join(work, "herd.sock"),
			TIG_SYNTAX_DAEMON: launcher,
			XDG_STATE_HOME: marker,
		});
		const runs = [1, 2, 3].map(() => run_filter_async(show_output, env));
		// Mid-startup: the launchers are still sleeping, so count them.
		await new Promise((resolve) => setTimeout(resolve, 700));
		if (process.platform === "linux") {
			expect(daemon_pids(marker, "herd-daemon.sh").length).toBe(1);
		}
		for (const output of await Promise.all(runs)) {
			expect_highlighted(output);
		}
	}, 60000);
});

/** What a scripted daemon answers once it has all input: the bytes to send,
 * then whether to close the connection (false leaves it open, like a
 * daemon that stalls after them). */
interface scripted_reply {
	data: Buffer,
	end: boolean,
}

/** An output frame acknowledging `consumed` input bytes with `payload`
 * wrapped in markers, so tests can tell framed output from raw. */
function marked_frame(consumed: number, payload: Buffer): Buffer {
	const marked = Buffer.concat([Buffer.from("<<"), payload, Buffer.from(">>")]);
	return Buffer.concat([Buffer.from(`O ${consumed} ${marked.length}\n`), marked]);
}

/** The well-behaved answer: one frame acknowledging all of `input`, then
 * the end frame. */
function complete_reply(input: Buffer): scripted_reply {
	return { data: Buffer.concat([marked_frame(input.length, input), Buffer.from("E 0\n")]), end: true };
}

/** A scripted daemon's behavior: the answer to the input it received. */
type scripted_daemon = (input: Buffer) => scripted_reply;

/** A running scripted daemon. */
interface fake_daemon_handle {
	/** How many times it has answered so far. */
	answered: () => number,
	/** Stop listening and drop the connections it left open. */
	close: () => void,
}

/** A scripted stand-in for the daemon on `path`: it reads the handshake and
 * all input, then answers with `reply(input)` after `delay_ms`, or never
 * when `reply` is null (a wedged daemon). */
async function fake_daemon(path: string, reply: scripted_daemon | null, delay_ms: number): Promise<fake_daemon_handle> {
	const sockets = new Set<Socket>();
	let answered = 0;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		const chunks: Buffer[] = [];
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("end", () => {
			if (reply === null) {
				return;
			}
			const received = Buffer.concat(chunks);
			const header_end = received.indexOf(0x0a);
			const cwd_length = Number(received.subarray(0, header_end).toString().split(" ")[1]);
			const answer = reply(received.subarray(header_end + 1 + cwd_length));
			answered++;
			setTimeout(() => {
				if (answer.end) {
					socket.end(answer.data);
				} else {
					socket.write(answer.data);
				}
			}, delay_ms);
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return {
		answered: () => answered,
		close: () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close();
		},
	};
}

/** The client's stdout and wall time from a run against a fake daemon, and
 * how many times the daemon answered. */
interface fake_run {
	output: string,
	ms: number,
	answered: number,
}

/** Run the client on `input` against a fake daemon answering with `reply`,
 * under a frame deadline of `deadline_ms`. */
async function run_against_fake(name: string, input: Buffer, reply: scripted_daemon, deadline_ms: number): Promise<fake_run> {
	const socket_path = join(work, `${name}.sock`);
	const daemon = await fake_daemon(socket_path, reply, 0);
	try {
		const started = performance.now();
		const output = await run_filter_async(input, filter_env({
			TIG_SYNTAX_SOCKET: socket_path,
			TIG_SYNTAX_DEADLINE_MS: String(deadline_ms),
		}));
		return { output: output.toString(), ms: performance.now() - started, answered: daemon.answered() };
	} finally {
		daemon.close();
	}
}

describe("client fallback against a misbehaving scripted daemon", () => {
	const input = Buffer.from(("y".repeat(99) + "\n").repeat(1000));
	const half = Math.floor(input.length / 2);
	// Long enough that a run which only fell back at the deadline shows
	// in its wall time: each of these must fall back at once.
	const deadline_ms = 30000;

	it("emits the unacknowledged rest raw when the daemon hangs up", async () => {
		const run = await run_against_fake("hangup", input, (received) =>
			({ data: marked_frame(half, received.subarray(0, half)), end: true }), deadline_ms);
		expect(run.answered).toBe(1);
		expect(run.output).toBe(`<<${input.subarray(0, half)}>>${input.subarray(half)}`);
		expect(run.ms).toBeLessThan(deadline_ms / 3);
	}, 60000);

	it("emits the unacknowledged rest raw after an early end frame", async () => {
		const run = await run_against_fake("early-end", input, (received) => ({
			data: Buffer.concat([marked_frame(half, received.subarray(0, half)), Buffer.from("E 0\n")]),
			end: false,
		}), deadline_ms);
		expect(run.answered).toBe(1);
		expect(run.output).toBe(`<<${input.subarray(0, half)}>>${input.subarray(half)}`);
		expect(run.ms).toBeLessThan(deadline_ms / 3);
	}, 60000);

	it("emits everything raw after a malformed frame", async () => {
		const run = await run_against_fake("garbage", input, () =>
			({ data: Buffer.from("Q nonsense\n"), end: false }), deadline_ms);
		expect(run.answered).toBe(1);
		expect(run.output).toBe(input.toString());
		expect(run.ms).toBeLessThan(deadline_ms / 3);
	}, 60000);

	it("repeats nothing when only the end frame is missing", async () => {
		// Only the deadline can end this run, so keep it short.
		const run = await run_against_fake("no-end", input, (received) =>
			({ data: marked_frame(received.length, received), end: false }), 500);
		expect(run.answered).toBe(1);
		expect(run.output).toBe(`<<${input}>>`);
	}, 60000);
});

describe("client deadline against a scripted daemon", () => {
	// Bigger than a socket buffer, so the frame cannot be read in one go.
	const input = ("x".repeat(99) + "\n").repeat(10000);

	it("does not count time it was stopped against the daemon", async () => {
		const daemon = await fake_daemon(join(work, "stop.sock"), complete_reply, 300);
		try {
			const child = spawn(client_bin, [], { cwd: repo, env: filter_env({
				TIG_SYNTAX_SOCKET: join(work, "stop.sock"),
				TIG_SYNTAX_DEADLINE_MS: "1000",
			}) });
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			const closed = new Promise((resolve) => child.on("close", resolve));
			child.stdin.end(input);
			// Stopped (as by ^Z in tig) well past the deadline, while
			// the daemon finishes its frame.
			await new Promise((resolve) => setTimeout(resolve, 100));
			child.kill("SIGSTOP");
			await new Promise((resolve) => setTimeout(resolve, 2500));
			child.kill("SIGCONT");
			await closed;
			const output = Buffer.concat(chunks).toString();
			expect(output).toBe(`<<${input}>>`);
		} finally {
			daemon.close();
		}
	}, 60000);

	it("still falls back at the deadline when the daemon never answers", async () => {
		const daemon = await fake_daemon(join(work, "wedged.sock"), null, 0);
		try {
			const started = performance.now();
			const output = await run_filter_async(Buffer.from(input), filter_env({
				TIG_SYNTAX_SOCKET: join(work, "wedged.sock"),
				TIG_SYNTAX_DEADLINE_MS: "500",
			}));
			expect(output.toString()).toBe(input);
			expect(performance.now() - started).toBeLessThan(5000);
		} finally {
			daemon.close();
		}
	}, 60000);
});
