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
import { join } from "node:path";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { section_splitter, type diff_section } from "./diff_parser.ts";
import { config } from "./config.ts";
import { init_highlighter } from "./highlight.ts";
import { process_section } from "./process.ts";

const logger = getLogger(["tig-syntax", "daemon"]);

const IDLE_EXIT_MS = 30 * 60 * 1000;

/** Serve one client connection; resolves when the connection is done. */
function handle_connection(socket: net.Socket): Promise<void> {
	return new Promise((resolve) => {
		let cwd: string | null = null;
		let header_buf = Buffer.alloc(0);
		const splitter = new section_splitter(config.max_section_bytes);
		let queue: Promise<void> = Promise.resolve();
		let closed = false;
		let sections_served = 0;
		const started = performance.now();

		const enqueue_sections = (sections: diff_section[]): void => {
			for (const section of sections) {
				queue = queue.then(async () => {
					if (closed) {
						return;
					}
					const output = await process_section(cwd as string, section);
					socket.write(`O ${section.byte_length} ${output.length}\n`);
					socket.write(output);
					sections_served++;
				});
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

		socket.on("end", () => {
			if (cwd !== null) {
				enqueue_sections(splitter.finish());
			}
			queue = queue.then(() => {
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

/** The daemon's unix socket path, honoring $TIG_SYNTAX_SOCKET. */
export function socket_path(): string {
	const override = process.env.TIG_SYNTAX_SOCKET;
	if (override !== undefined && override !== "") {
		return override;
	}
	const runtime_dir = process.env.XDG_RUNTIME_DIR;
	if (runtime_dir !== undefined && runtime_dir !== "") {
		return join(runtime_dir, "tig-syntax.sock");
	}
	return `/tmp/tig-syntax-${process.getuid?.() ?? 0}.sock`;
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
	const schedule_idle_exit = (): void => {
		clearTimeout(idle_timer);
		idle_timer = setTimeout(() => {
			logger.info("idle for {min} minutes, exiting", { min: IDLE_EXIT_MS / 60000 });
			server.close();
			process.exit(0);
		}, IDLE_EXIT_MS);
	};

	// allowHalfOpen: the client half-closes after sending its diff and
	// keeps reading; without this, node would auto-close our write side.
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		active_connections++;
		clearTimeout(idle_timer);
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
		logger.info("budgets: {budget_ms}ms/section, max {max_lines} lines, passthrough over {max_section_bytes} bytes", config);
		schedule_idle_exit();
	});
}

await main();
