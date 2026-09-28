// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5
// Model-output: ChatGPT 6 Astra

/**
 * The tig-syntax highlight daemon: a unix-socket server that accepts a
 * unified diff stream plus repository context and returns the same diff
 * with SGR color injected into hunk line bodies (see process.ts).
 *
 * Wire protocol (client -> daemon):
 *	"TIGSYN1 <cwd_byte_length>\n" <cwd bytes> <raw diff bytes ... EOF>
 * Daemon -> client, a sequence of frames:
 *	"O <consumed_input_bytes> <output_bytes>\n" <output bytes>
 *	"P 0\n", a keepalive probe once the client has half-closed.
 *	"E 0\n" on clean end of stream.
 * The client keeps its input spooled, so a daemon crash at any point lets
 * it fall back to emitting the unacknowledged rest raw.
 */

import * as net from "node:net";
import { unlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { SectionSplitter, type diff_section } from "./diff_parser.ts";
import { config } from "./config.ts";
import { shed_git_state } from "./git.ts";
import { init_highlighter } from "./highlight.ts";
import { process_section } from "./process.ts";

const logger = getLogger(["tig-syntax", "daemon"]);

/* After IDLE_SHED_MS without connections, drop the cheap-to-rebuild git
 * state (blob and attribute caches, git children) but keep the costly
 * tokenized-line cache; after IDLE_EXIT_MS, exit. */
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
			// Once the client half-closes, only a failed write
			// reveals that it was killed, so send keepalives:
			// abandoned tokenization then stops between chunks.
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

/** The unix socket path to listen on: $TIG_SYNTAX_SOCKET, which the
 * client sets when it spawns the daemon (the client alone decides where
 * daemons live, from its environment and the daemon's build id), or null
 * when unset. */
export function socket_path(): string | null {
	const path = process.env.TIG_SYNTAX_SOCKET;
	return path === undefined || path === "" ? null : path;
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

/** git 2.5x's `git rev-parse --local-env-vars`, for when git cannot say. */
const FALLBACK_REPO_ENV_VARS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
	"GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
];

/** The environment variables that select a repository, as the installed
 * git lists them. */
function repo_env_vars(): string[] {
	try {
		return execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
			.split("\n").filter((name) => name !== "");
	} catch {
		return FALLBACK_REPO_ENV_VARS;
	}
}

/** Drop what the daemon inherited from whichever client happened to spawn
 * it: every connection names its repository by cwd alone, so e.g. the
 * GIT_WORK_TREE that tig sets when run as a git alias would otherwise
 * point every later request's git commands at that one repository, and
 * the cwd would keep that directory busy for the daemon's lifetime.
 * Relative paths from the environment must be resolved before this. */
function forget_spawning_client(): void {
	for (const name of repo_env_vars()) {
		delete process.env[name];
	}
	process.chdir("/");
}

/** Listen on `path` with the socket owner-only from the moment it exists
 * (a chmod after listen leaves a window, and the path may be in a
 * world-writable /tmp fallback; the client also checks the peer UID).
 * The bind happens synchronously within listen(), so the umask is
 * restored at once rather than inherited by later git children. */
function listen_private(server: net.Server, path: string, on_listening?: () => void): void {
	const umask = process.umask(0o077);
	try {
		server.listen(path, on_listening);
	} finally {
		process.umask(umask);
	}
}

async function main(): Promise<void> {
	// Relative settings mean the spawning client's cwd, as in the client.
	const socket = socket_path();
	const path = socket === null ? null : resolve(socket);
	const state_home = process.env.XDG_STATE_HOME || join(process.env.HOME ?? "/tmp", ".local", "state");
	const log_dir = resolve(state_home, "tig-syntax");
	forget_spawning_client();
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
	if (path === null) {
		// E.g. a client built before the daemon sources it now runs.
		logger.error("TIG_SYNTAX_SOCKET is not set: the daemon is started by tig-syntax-filter; rebuild it with `make -C client` after updating");
		process.exit(1);
	}

	await init_highlighter();

	let active_connections = 0;
	let idle_timer: ReturnType<typeof setTimeout>;
	let shed_timer: ReturnType<typeof setTimeout>;
	const schedule_idle_exit = (): void => {
		clearTimeout(idle_timer);
		clearTimeout(shed_timer);
		shed_timer = setTimeout(() => {
			logger.info("idle for {min} minutes, shedding git state (pid {pid})", {
				min: IDLE_SHED_MS / 60000, pid: process.pid,
			});
			shed_git_state();
		}, IDLE_SHED_MS);
		idle_timer = setTimeout(() => {
			logger.info("idle for {hours} hours, exiting (pid {pid})", {
				hours: IDLE_EXIT_MS / 3600000, pid: process.pid,
			});
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
			// A dead daemon's socket: replace it.  One that cannot be
			// removed (another user's file in a sticky /tmp, a
			// read-only directory) would make listening fail forever.
			try {
				await unlink(path);
			} catch (unlink_err) {
				if ((unlink_err as NodeJS.ErrnoException).code !== "ENOENT") {
					logger.error("cannot replace stale {path}: {err}", {
						path, err: String(unlink_err),
					});
					process.exit(1);
				}
			}
			listen_private(server, path);
			return;
		}
		logger.error("server error: {err}", { err: String(err) });
		process.exit(1);
	});

	listen_private(server, path, () => {
		logger.info("listening on {path} (pid {pid})", { path, pid: process.pid });
		logger.info("budgets: {budget_ms}ms/section, max {max_lines} lines, passthrough over {max_section_bytes} bytes, caches {line_cache_mb}+{blob_cache_mb}MB", config);
		schedule_idle_exit();
	});
}

await main();
