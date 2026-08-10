// Model-output: Claude Fable 5
// A9 acceptance metric: how much input a never-reading client can push into
// the daemon, and how large the daemon grows doing it.  Without
// backpressure the daemon accepts and processes the whole stream, queueing
// every output frame in memory; with it, input pauses once the section
// queue's byte cap fills and the unread output stalls the pipeline.
//
// Usage: node backpressure.mjs <socket> <cwd> <total-mb>
// Sends a synthetic <total-mb> MB diff of many small sections, NEVER reads
// responses, and reports how many bytes the daemon accepted before write
// progress stalled for 2 s, plus the daemon's RSS at that point.

import * as net from "node:net";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [socket_path, cwd, total_mb] = process.argv.slice(2);
const target = parseInt(total_mb, 10) * 1048576;

function make_section(i) {
	const body = `+line ${i} `.padEnd(160, "x");
	return `diff --git a/f${i}.c b/f${i}.c\n` +
		`index 1111111..2222222 100644\n--- a/f${i}.c\n+++ b/f${i}.c\n` +
		`@@ -1,0 +1,40 @@\n` + (body + "\n").repeat(40);
}

let payload = "";
for (let i = 0; payload.length < target; i++) {
	payload += make_section(i);
}
const diff = Buffer.from(payload);

const sock = net.connect(socket_path);
sock.pause();   // never read a byte of response
let sent = 0;
let last_progress = performance.now();

sock.on("connect", () => {
	sock.write(`TIGSYN1 ${Buffer.byteLength(cwd)}\n${cwd}`);
	pump();
});

function pump() {
	while (sent < diff.length) {
		const chunk = diff.subarray(sent, sent + 65536);
		const ok = sock.write(chunk);
		sent += chunk.length;
		last_progress = performance.now();
		if (!ok) {
			sock.once("drain", pump);
			return;
		}
	}
}

function daemon_rss_mb() {
	try {
		const pid = execFileSync("pgrep", ["-f", "bin/[.][.]/src/daemon[.]ts"],
			{ encoding: "utf8" }).trim().split("\n")[0];
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		return Math.round(parseInt(/VmRSS:\s+(\d+)/.exec(status)[1], 10) / 1024);
	} catch {
		return -1;
	}
}

const timer = setInterval(() => {
	if (performance.now() - last_progress > 2000 || sent >= diff.length) {
		clearInterval(timer);
		console.log(`accepted_mb=${(sent / 1048576).toFixed(1)} of=${total_mb} daemon_rss_mb=${daemon_rss_mb()}`);
		process.exit(0);
	}
}, 250);
