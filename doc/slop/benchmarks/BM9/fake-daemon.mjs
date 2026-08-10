// Model-output: Claude Fable 5
// BM9: fake daemons with injectable protocol faults, for exercising the C
// client's stall/fallback behavior.
//
// Usage: node fake-daemon.mjs <socket> <mode>
// Modes:
//   never-read       accept the connection, never read from it
//   slow-read        read 1 byte every 5 ms, never reply
//   read-never-reply read everything promptly, never reply
//   trickle          read everything; send a valid O header for 10 bytes of
//                    output, then 1 payload byte per second, forever
//   huge-frame       reply with a frame declaring a 100 GB payload
//   midframe-close   send an O header + half its payload, then close
//   late-reply       after 20 s, echo the whole input back as one valid
//                    frame sequence (tests deadline vs. correct-but-late)
//   ack-overrun      immediately acknowledge more input bytes than were
//                    ever sent (tests the client's consumed validation)
// The process prints "listening" once ready and serves exactly one
// connection; the runner kills it afterwards.

import * as net from "node:net";
import { unlink } from "node:fs/promises";

const [socket_path, mode] = process.argv.slice(2);
await unlink(socket_path).catch(() => {});

const server = net.createServer({ allowHalfOpen: true }, (sock) => {
	const input = [];
	switch (mode) {
	case "never-read":
		sock.pause();
		break;
	case "slow-read":
		sock.pause();
		setInterval(() => {
			const b = sock.read(1);
			if (b === null) {
				sock.resume();
				sock.pause();
			}
		}, 5);
		break;
	case "read-never-reply":
		sock.on("data", () => {});
		break;
	case "trickle":
		sock.on("data", () => {});
		sock.write("O 10 1000000\n");
		setInterval(() => sock.write("x"), 1000);
		break;
	case "huge-frame":
		sock.on("data", () => {});
		sock.write("O 10 100000000000\n");
		break;
	case "ack-overrun":
		sock.on("data", () => {});
		sock.write("O 99999999999 4\nabcd");
		break;
	case "midframe-close":
		sock.on("data", () => {});
		sock.write("O 10 1000\n" + "y".repeat(500));
		setTimeout(() => sock.destroy(), 100);
		break;
	case "late-reply":
		sock.on("data", (c) => input.push(c));
		sock.on("end", () => {
			setTimeout(() => {
				const all = Buffer.concat(input);
				// strip the TIGSYN1 header we received
				const nl = all.indexOf(0x0a);
				const cwd_len = parseInt(all.subarray(8, nl).toString(), 10);
				const body = all.subarray(nl + 1 + cwd_len);
				sock.write(`O ${body.length} ${body.length}\n`);
				sock.write(body);
				sock.end("E 0\n");
			}, 20_000);
		});
		break;
	default:
		console.error(`unknown mode ${mode}`);
		process.exit(2);
	}
});
server.listen(socket_path, () => console.log("listening"));
