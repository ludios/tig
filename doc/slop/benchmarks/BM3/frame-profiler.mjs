// Model-output: Claude Fable 5
// BM3: speak the client side of the tig-syntax protocol and timestamp every
// frame the daemon returns.
//
// Usage: node frame-profiler.mjs <socket> <cwd-for-daemon> <diff-file>
// Output (stdout): CSV
//	frame,kind,consumed_bytes,out_bytes,line_aligned,ms_since_connect
// with a trailing "# total_ms=... frames=... input_bytes=..." comment line.
// ms_since_connect counts from connect() completion; connect_ms is reported
// separately in the trailer.  line_aligned is 1 when the frame's payload
// ends in "\n" (verifies the E4 line-alignment assumption; "-" for E and
// empty frames).
// The daemon must already be listening on <socket>; this tool never spawns it.
//
// Parsing is O(total bytes): payloads are skipped by counting, never
// re-concatenated (a naive per-chunk Buffer.concat is quadratic and would
// dominate the measurement for multi-MB frames).

import * as net from "node:net";
import { readFile } from "node:fs/promises";

const [socket_path, repo_cwd, diff_file] = process.argv.slice(2);
if (!diff_file) {
	console.error("usage: frame-profiler.mjs <socket> <cwd> <diff-file>");
	process.exit(2);
}

const diff = await readFile(diff_file);
const t0 = performance.now();
const sock = net.connect(socket_path);
await new Promise((resolve, reject) => {
	sock.on("connect", resolve);
	sock.on("error", reject);
});
const t_connect = performance.now() - t0;
const t_frames = performance.now();

sock.write(`TIGSYN1 ${Buffer.byteLength(repo_cwd)}\n${repo_cwd}`);
sock.write(diff);
sock.end(); // half-close: daemon allows it and keeps writing

/** Small buffer of not-yet-parsed header bytes (headers are < 64 bytes). */
let head = Buffer.alloc(0);
/** Payload bytes still to skip for the current frame. */
let payload_left = 0;
let frame = 0;
let last_payload_byte = -1;

function finish_run() {
	const total = (performance.now() - t_frames).toFixed(2);
	console.log(`# total_ms=${total} connect_ms=${t_connect.toFixed(2)} frames=${frame} input_bytes=${diff.length}`);
	process.exit(0);
}

console.log("frame,kind,consumed_bytes,out_bytes,line_aligned,ms_since_connect");
sock.on("data", (chunk) => {
	let off = 0;
	while (off < chunk.length) {
		if (payload_left > 0) {
			const take = Math.min(payload_left, chunk.length - off);
			last_payload_byte = chunk[off + take - 1];
			payload_left -= take;
			off += take;
			if (payload_left === 0) {
				// frame complete only when its payload is fully here
				frame++;
				const aligned = last_payload_byte === 0x0a ? 1 : 0;
				const ms = (performance.now() - t_frames).toFixed(2);
				console.log(current_row + "," + aligned + "," + ms);
			}
			continue;
		}
		head = head.length === 0 ? chunk.subarray(off) : Buffer.concat([head, chunk.subarray(off)]);
		off = chunk.length;
		const nl = head.indexOf(0x0a);
		if (nl === -1) {
			if (head.length > 4096) {
				console.error("unterminated frame header");
				process.exit(1);
			}
			return;
		}
		const header = head.subarray(0, nl).toString("utf8");
		const m = /^([OE]) (\d+)(?: (\d+))?$/.exec(header);
		if (m === null) {
			console.error(`bad frame header: ${JSON.stringify(header)}`);
			process.exit(1);
		}
		const out_len = m[3] === undefined ? 0 : parseInt(m[3], 10);
		const rest = head.subarray(nl + 1);
		head = Buffer.alloc(0);
		if (m[1] === "E") {
			frame++;
			const ms = (performance.now() - t_frames).toFixed(2);
			console.log(`${frame},E,${m[2]},0,-,${ms}`);
			finish_run();
		}
		current_row = `${frame + 1},${m[1]},${m[2]},${out_len}`;
		payload_left = out_len;
		if (payload_left === 0) {
			frame++;
			const ms = (performance.now() - t_frames).toFixed(2);
			console.log(current_row + ",-," + ms);
		}
		// re-process the payload bytes that arrived with the header
		chunk = rest;
		off = 0;
	}
});
let current_row = "";
sock.on("close", () => {
	console.log(`# closed-early ms=${(performance.now() - t_frames).toFixed(2)} frames=${frame}`);
	process.exit(1);
});
