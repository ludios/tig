// Model-output: Claude Fable 5

/**
 * The tig-syntax highlight daemon: a unix-socket server that accepts a
 * unified diff stream plus repository context and returns the same diff
 * with SGR color injected into hunk line bodies (see process.ts).
 *
 * Wire protocol (client -> daemon):
 *	"TIGSYN1 <cwd_byte_length>\n" <cwd bytes> <raw diff bytes ... EOF>
 * Daemon -> client, a sequence of frames, each acknowledging consumed input:
 *	"O <consumed_input_bytes> <output_bytes>\n" <output bytes>
 *	"E 0\n" on clean end of stream.
 * The client keeps unacknowledged input spooled, so a daemon crash at any
 * point lets it fall back to emitting the raw diff.
 */

import * as net from "node:net";
import { unlink, mkdir, chmod } from "node:fs/promises";
import { statSync, accessSync, constants as fs_constants } from "node:fs";
import { join } from "node:path";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { SectionSplitter, type diff_section } from "./diff_parser.ts";
import { config } from "./config.ts";
import { shed_git_state } from "./git.ts";
import { init_highlighter } from "./highlight.ts";
import { process_section } from "./process.ts";

const logger = getLogger(["tig-syntax", "daemon"]);

/* Idle lifecycle (plan item B5): after IDLE_SHED_MS the cheap-to-rebuild
 * state goes (blob cache, git children) while the valuable tokenized-line
 * cache stays, so a same-day return skips re-tokenization; only after
 * IDLE_EXIT_MS does the daemon exit entirely.  (Cold start is also hidden
 * by tig's startup warm-up, plan item B4.) */
const IDLE_SHED_MS = 30 * 60 * 1000;
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;

/** Unprocessed queued input beyond which a connection's socket pauses
 * (resuming at half); bounds daemon memory against a fast writer. */
const INPUT_QUEUE_BYTES = 8 * 1048576;

/** Serve one client connection; resolves when the connection is done. */
function handle_connection(socket: net.Socket): Promise<void> {
	return new Promise((resolve) => {
		let cwd: string | null = null;
		let header_buf = Buffer.alloc(0);
		const splitter = new SectionSplitter(config.max_section_bytes);
		let queue: Promise<void> = Promise.resolve();
		let closed = false;
		let sections_served = 0;
		let queued_bytes = 0;
		let paused = false;
		const started = performance.now();

		/** Resolves once the socket can take more output (or is gone). */
		const drained = (): Promise<void> => new Promise((resolve) => {
			const done = (): void => {
				socket.off("drain", done);
				socket.off("close", done);
				resolve();
			};
			socket.once("drain", done);
			socket.once("close", done);
		});

		const enqueue_sections = (sections: diff_section[]): void => {
			for (const section of sections) {
				queued_bytes += section.byte_length;
				queue = queue.then(async () => {
					if (closed) {
						queued_bytes -= section.byte_length;
						return;
					}
					const output = await process_section(cwd as string, section,
									     () => closed);
					queued_bytes -= section.byte_length;
					if (paused && queued_bytes <= INPUT_QUEUE_BYTES / 2) {
						paused = false;
						socket.resume();
					}
					if (closed) {
						return;
					}
					socket.write(`O ${section.byte_length} ${output.length}\n`);
					if (!socket.write(output)) {
						// Output backpressure: a client that stops
						// reading stalls the pipeline here instead of
						// growing the daemon's write queue unboundedly.
						await drained();
					}
					sections_served++;
				});
			}
			if (!paused && queued_bytes > INPUT_QUEUE_BYTES) {
				// Input backpressure: stop reading until the queue
				// shrinks; the client's spool absorbs the difference.
				paused = true;
				socket.pause();
			}
		};

		socket.on("data", (chunk: Buffer) => {
			if (cwd === null) {
				header_buf = Buffer.concat([header_buf, chunk]);
				const nl = header_buf.indexOf(0x0a);
				if (nl === -1) {
					if (header_buf.length > 4096) {
						socket.destroy();
					}
					return;
				}
				const line = header_buf.subarray(0, nl).toString("utf8");
				const m = /^TIGSYN1 (\d+)$/.exec(line);
				if (m === null) {
					logger.warn("bad handshake: {line}", { line });
					socket.destroy();
					return;
				}
				const cwd_len = parseInt(m[1], 10);
				if (header_buf.length < nl + 1 + cwd_len) {
					return;
				}
				cwd = header_buf.subarray(nl + 1, nl + 1 + cwd_len).toString("utf8");
				const rest = header_buf.subarray(nl + 1 + cwd_len);
				header_buf = Buffer.alloc(0);
				if (rest.length > 0) {
					enqueue_sections(splitter.feed(rest));
				}
				return;
			}
			enqueue_sections(splitter.feed(chunk));
		});

		let heartbeat: ReturnType<typeof setInterval> | null = null;
		const stop_heartbeat = (): void => {
			if (heartbeat !== null) {
				clearInterval(heartbeat);
				heartbeat = null;
			}
		};

		socket.on("end", () => {
			if (cwd !== null) {
				enqueue_sections(splitter.finish());
			}
			// The client half-closes after sending its diff, so from here
			// on a kill leaves the connection indistinguishable from a
			// patient client — until a write fails.  Probe with keepalive
			// frames (harmless to a live client, EPIPE from a dead one)
			// so abandoned tokenization gets cancelled between chunks.
			heartbeat = setInterval(() => {
				socket.write("P 0\n");
			}, 500);
			queue = queue.then(() => {
				stop_heartbeat();
				if (!closed) {
					socket.end("E 0\n");
					logger.info("served {sections} sections for {cwd} in {ms}ms", {
						sections: sections_served, cwd,
						ms: Math.round(performance.now() - started),
					});
				}
			});
		});

		const finish = (): void => {
			stop_heartbeat();
			closed = true;
			resolve();
		};
		socket.on("close", finish);
		socket.on("error", (err) => {
			logger.info("connection error: {err}", { err: String(err) });
			finish();
		});
	});
}

/** Whether `dir` is a directory this process owns and can create a
 * socket in.  $XDG_RUNTIME_DIR can name another user's directory (e.g. a
 * session su'd from root keeps /run/user/0), where listening fails with
 * EACCES — such a value must be ignored, not obeyed into a spawn loop
 * that never serves anyone. */
function usable_socket_dir(dir: string): boolean {
	try {
		const st = statSync(dir);
		if (!st.isDirectory() || st.uid !== (process.geteuid?.() ?? st.uid)) {
			return false;
		}
		accessSync(dir, fs_constants.W_OK | fs_constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The daemon's unix socket path, honoring $TIG_SYNTAX_SOCKET; must stay
 * in agreement with socket_path() in the C client for any environment. */
export function socket_path(): string {
	const override = process.env.TIG_SYNTAX_SOCKET;
	if (override !== undefined && override !== "") {
		return override;
	}
	const runtime_dir = process.env.XDG_RUNTIME_DIR;
	if (runtime_dir !== undefined && runtime_dir !== "" && usable_socket_dir(runtime_dir)) {
		return join(runtime_dir, "tig-syntax.sock");
	}
	// $TMPDIR gets the same scrutiny: a stale or unwritable value must
	// not regress the plain-/tmp case that always worked.
	const env_tmpdir = process.env.TMPDIR;
	const tmpdir = env_tmpdir !== undefined && env_tmpdir !== "" &&
		usable_socket_dir(env_tmpdir) ? env_tmpdir : "/tmp";
	return join(tmpdir, `tig-syntax-${process.geteuid?.() ?? 0}.sock`);
}

/** True when another live daemon already listens on `path`. */
function daemon_alive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.connect(path);
		probe.on("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.on("error", () => {
			resolve(false);
		});
	});
}

async function main(): Promise<void> {
	const state_home = process.env.XDG_STATE_HOME || join(process.env.HOME ?? "/tmp", ".local", "state");
	const log_dir = join(state_home, "tig-syntax");
	await mkdir(log_dir, { recursive: true });
	await configure({
		sinks: {
			file: getFileSink(join(log_dir, "daemon.log")),
			console: getConsoleSink(),
		},
		loggers: [
			{ category: ["tig-syntax"], lowestLevel: "info", sinks: ["file"] },
			{ category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
		],
	});

	await init_highlighter();

	const path = socket_path();
	let active_connections = 0;
	let idle_timer: ReturnType<typeof setTimeout>;
	let shed_timer: ReturnType<typeof setTimeout>;
	const schedule_idle_exit = (): void => {
		clearTimeout(idle_timer);
		clearTimeout(shed_timer);
		shed_timer = setTimeout(() => {
			logger.info("idle for {min} minutes, shedding git state", {
				min: IDLE_SHED_MS / 60000,
			});
			shed_git_state();
		}, IDLE_SHED_MS);
		idle_timer = setTimeout(() => {
			logger.info("idle for {hours} hours, exiting", { hours: IDLE_EXIT_MS / 3600000 });
			server.close();
			process.exit(0);
		}, IDLE_EXIT_MS);
	};

	// allowHalfOpen: the client half-closes after sending its diff and
	// keeps reading; without this, node would auto-close our write side.
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		active_connections++;
		clearTimeout(idle_timer);
		clearTimeout(shed_timer);
		void handle_connection(socket).then(() => {
			active_connections--;
			if (active_connections === 0) {
				schedule_idle_exit();
			}
		});
	});

	server.on("error", async (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			if (await daemon_alive(path)) {
				logger.info("another daemon is live on {path}, exiting", { path });
				process.exit(0);
			}
			await unlink(path).catch(() => {});
			server.listen(path);
			return;
		}
		logger.error("server error: {err}", { err: String(err) });
		process.exit(1);
	});

	server.listen(path, () => {
		// Owner-only: the socket may live in a world-writable /tmp
		// fallback; the client additionally checks the peer UID.
		void chmod(path, 0o600).catch(() => {});
		logger.info("listening on {path} (pid {pid})", { path, pid: process.pid });
		logger.info("budgets: {budget_ms}ms/section, max {max_lines} lines, passthrough over {max_section_bytes} bytes, caches {line_cache_mb}+{blob_cache_mb}MB", config);
		schedule_idle_exit();
	});
}

await main();
