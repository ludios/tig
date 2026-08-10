// Model-output: Claude Fable 5
// BM3: speak the client side of the tig-syntax protocol and timestamp every
// frame the daemon returns.
//
// Usage: node frame-profiler.mjs <socket> <cwd-for-daemon> <diff-file>
// Output (stdout): CSV "frame,kind,consumed_bytes,out_bytes,ms_since_connect"
// with a trailing "# total_ms=... frames=... input_bytes=..." comment line.
// The daemon must already be listening on <socket>; this tool never spawns it.

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

sock.write(`TIGSYN1 ${Buffer.byteLength(repo_cwd)}\n${repo_cwd}`);
sock.write(diff);
sock.end(); // half-close: daemon allows it and keeps writing

let buf = Buffer.alloc(0);
let frame = 0;
console.log("frame,kind,consumed_bytes,out_bytes,ms_since_connect");
sock.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (true) {
		const nl = buf.indexOf(0x0a);
		if (nl === -1) {
			return;
		}
		const header = buf.subarray(0, nl).toString("utf8");
		const m = /^([OE]) (\d+)(?: (\d+))?$/.exec(header);
		if (m === null) {
			console.error(`bad frame header: ${JSON.stringify(header)}`);
			process.exit(1);
		}
		const out_len = m[3] === undefined ? 0 : parseInt(m[3], 10);
		if (buf.length - (nl + 1) < out_len) {
			return; // wait for full payload before stamping
		}
		frame++;
		const ms = (performance.now() - t0).toFixed(2);
		console.log(`${frame},${m[1]},${m[2]},${out_len},${ms}`);
		buf = buf.subarray(nl + 1 + out_len);
		if (m[1] === "E") {
			const total = (performance.now() - t0).toFixed(2);
			console.log(`# total_ms=${total} connect_ms=${t_connect.toFixed(2)} frames=${frame} input_bytes=${diff.length}`);
			process.exit(0);
		}
	}
});
sock.on("close", () => {
	console.log(`# closed-early ms=${(performance.now() - t0).toFixed(2)} frames=${frame}`);
	process.exit(1);
});
