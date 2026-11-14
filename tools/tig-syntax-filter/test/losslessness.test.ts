/**
 * The output invariant: for any diff, stripping injected SGR sequences and
 * unescaping the literal-ESC marker restores the input byte-for-byte.
 * Uses real diffs from the enclosing tig repository, plus synthetic
 * sections with adversarial content (literal ESC bytes, invalid UTF-8).
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fc from "fast-check";
import { execFileSync } from "node:child_process";
import { SectionSplitter, type diff_section } from "../src/diff_parser.ts";
import { init_highlighter, frame_content } from "../src/highlight.ts";
import { process_section } from "../src/process.ts";

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** Reference inverse of the wire framing: drop every SGR sequence except
 * the literal-ESC marker (ESC[999m), which becomes ESC again.  One pass,
 * so that no stand-in for ESC can collide with the content. */
function unframe_and_strip(output: Buffer): Buffer {
	const text = output.toString("latin1");
	const restored = text.replace(/\x1b\[([0-9;]*)m/g, (_sgr, params: string) => params === "999" ? "\x1b" : "");
	return Buffer.from(restored, "latin1");
}

function split_all(data: Buffer): diff_section[] {
	const splitter = new SectionSplitter();
	return [...splitter.feed(data), ...splitter.finish()];
}

beforeAll(async () => {
	await init_highlighter();
}, 60000);

describe("frame_content", () => {
	it("round-trips any string through frame + unframe", () => {
		fc.assert(fc.property(fc.string({ unit: "binary" }), (text) => {
			const framed = frame_content(text);
			const framed_bytes = Buffer.from(framed, "utf8");
			const restored = unframe_and_strip(framed_bytes);
			expect(restored.equals(Buffer.from(text, "utf8"))).toBe(true);
		}));
	});
});

describe("process_section losslessness", () => {
	it("holds for recent real commits of this repository", async () => {
		const revs = execFileSync("git", ["-C", REPO, "rev-list", "--max-count=5", "HEAD"],
			{ encoding: "utf8" }).trim().split("\n");
		for (const rev of revs) {
			const diff = execFileSync("git", ["-C", REPO, "show", "--no-color", rev],
				{ maxBuffer: 1 << 26 });
			const sections = split_all(diff);
			const outputs: Buffer[] = [];
			for (const section of sections) {
				outputs.push(await process_section(REPO, section));
			}
			const restored = unframe_and_strip(Buffer.concat(outputs));
			expect(restored.equals(diff), `lossless for ${rev}`).toBe(true);
		}
	}, 120000);

	it("holds for synthetic sections with ESC bytes and invalid UTF-8", async () => {
		const nasty = Buffer.concat([
			Buffer.from("some preamble with \x1b[31m raw escapes\n"),
			Buffer.from("diff --git a/x.bin b/x.bin\n"),
			Buffer.from("index 1111111..2222222 100644\n"),
			Buffer.from("--- a/x.bin\n"),
			Buffer.from("+++ b/x.bin\n"),
			Buffer.from("@@ -1 +1 @@\n"),
			Buffer.from([0x2d, 0xff, 0xfe, 0x1b, 0x0a]),
			Buffer.from([0x2b, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x0a]),
		]);
		const sections = split_all(nasty);
		const outputs: Buffer[] = [];
		for (const section of sections) {
			outputs.push(await process_section(REPO, section));
		}
		const restored = unframe_and_strip(Buffer.concat(outputs));
		expect(restored.equals(nasty)).toBe(true);
	});
});
