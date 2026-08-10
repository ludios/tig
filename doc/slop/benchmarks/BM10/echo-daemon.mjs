// Model-output: Claude Fable 5
// BM10 layer 2: a protocol-conformant daemon that does no work — every input
// chunk is acknowledged and echoed back verbatim as one frame.  Measures
// client + socket + framing overhead in isolation.
//
// Usage: node echo-daemon.mjs <socket>

import * as net from "node:net";
import { unlink } from "node:fs/promises";

const socket_path = process.argv[2];
await unlink(socket_path).catch(() => {});

const server = net.createServer({ allowHalfOpen: true }, (sock) => {
	let header_done = false;
	let header_buf = Buffer.alloc(0);
	sock.on("data", (chunk) => {
		if (!header_done) {
			header_buf = Buffer.concat([header_buf, chunk]);
			const nl = header_buf.indexOf(0x0a);
			if (nl === -1) {
				return;
			}
			const cwd_len = parseInt(header_buf.subarray(8, nl).toString(), 10);
			if (header_buf.length < nl + 1 + cwd_len) {
				return;
			}
			header_done = true;
			chunk = header_buf.subarray(nl + 1 + cwd_len);
			if (chunk.length === 0) {
				return;
			}
		}
		sock.write(`O ${chunk.length} ${chunk.length}\n`);
		sock.write(chunk);
	});
	sock.on("end", () => sock.end("E 0\n"));
});
server.listen(socket_path, () => console.log("listening"));
