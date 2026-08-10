// Model-output: Claude Fable 5
// A2 acceptance metric: latency of a small cache-warm request (client B)
// issued while another connection (client A) is mid-tokenization.
// Without event-loop yields, B waits for A's synchronous chunk loop (up to
// the full section budget); with them, B interleaves per chunk.
//
// Usage: node concurrent-latency.mjs <socket> <cwd-A> <diff-A> <cwd-B> <diff-B>
// Requires a running daemon with diff-B's sources already cached (prime it
// first).  Prints "B_ms=<latency>".

import * as net from "node:net";
import { readFile } from "node:fs/promises";

const [socket_path, cwd_a, diff_a, cwd_b, diff_b] = process.argv.slice(2);

function run(cwd, diff, on_done) {
	const sock = net.connect(socket_path);
	const start = performance.now();
	sock.on("connect", () => {
		sock.write(`TIGSYN1 ${Buffer.byteLength(cwd)}\n${cwd}`);
		sock.write(diff);
		sock.end();
	});
	let tail = Buffer.alloc(0);
	sock.on("data", (chunk) => {
		tail = Buffer.concat([tail.subarray(-16), chunk]).subarray(-16);
		if (tail.toString("latin1").endsWith("E 0\n")) {
			on_done(performance.now() - start);
			sock.destroy();
		}
	});
}

const a = await readFile(diff_a);
const b = await readFile(diff_b);
run(cwd_a, a, () => {});
// Let A's expensive section get going before B arrives.
setTimeout(() => {
	run(cwd_b, b, (ms) => {
		console.log(`B_ms=${ms.toFixed(0)}`);
		process.exit(0);
	});
}, 120);
setTimeout(() => {
	console.log("B_ms=timeout");
	process.exit(1);
}, 30000);
