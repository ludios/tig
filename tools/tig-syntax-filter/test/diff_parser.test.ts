// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SectionSplitter, parse_file_section, unquote_git_path, type diff_section } from "../src/diff_parser.ts";

/** Split `data` into sections in one go. */
function split_all(data: Buffer): diff_section[] {
	const splitter = new SectionSplitter();
	return [...splitter.feed(data), ...splitter.finish()];
}

/** Rejoin a section's lines into the original bytes. */
function section_bytes(section: diff_section): Buffer {
	const parts: Buffer[] = [];
	for (const line of section.lines) {
		parts.push(line.bytes);
		if (line.had_newline) {
			parts.push(Buffer.from("\n"));
		}
	}
	return Buffer.concat(parts);
}

/** Each section's bytes, with the preamble's pieces (it streams as it
 * arrives, so chunking decides how it is cut) joined into one. */
function merge_preamble(sections: diff_section[]): Buffer[] {
	const preamble = sections.filter((s) => s.kind === "preamble").map(section_bytes);
	const rest = sections.filter((s) => s.kind !== "preamble").map(section_bytes);
	return preamble.length > 0 ? [Buffer.concat(preamble), ...rest] : rest;
}

const SAMPLE_DIFF = [
	"commit 0123456789abcdef",
	"Author: Someone <someone@example.com>",
	"",
	"    A commit message with\x1btricky bytes",
	"",
	"diff --git a/foo.c b/foo.c",
	"index 1111111..2222222 100644",
	"--- a/foo.c",
	"+++ b/foo.c",
	"@@ -1,3 +1,4 @@",
	" int main(void)",
	" {",
	"+\treturn 0;",
	" }",
	"diff --git a/bar.py b/baz.py",
	"similarity index 90%",
	"rename from bar.py",
	"rename to baz.py",
	"index 3333333..4444444 100644",
	"--- a/bar.py",
	"+++ b/baz.py",
	"@@ -1 +1 @@",
	"-x = 1",
	"+x = 2",
].join("\n") + "\n";

describe("SectionSplitter", () => {
	it("splits into preamble and per-file sections", () => {
		const sections = split_all(Buffer.from(SAMPLE_DIFF));
		expect(sections.map((s) => s.kind)).toEqual(["preamble", "file", "file"]);
	});

	it("sections reassemble byte-identically and byte_length is exact", () => {
		const sections = split_all(Buffer.from(SAMPLE_DIFF));
		const joined = Buffer.concat(sections.map(section_bytes));
		expect(joined.toString("latin1")).toBe(SAMPLE_DIFF);
		for (const section of sections) {
			expect(section.byte_length).toBe(section_bytes(section).length);
		}
	});

	it("streams the preamble as it arrives", () => {
		const splitter = new SectionSplitter();
		const sections = splitter.feed(Buffer.from("commit 0123456789abcdef\nAuthor: x\npartial"));
		expect(sections.map((s) => s.kind)).toEqual(["preamble"]);
		expect(section_bytes(sections[0]).toString()).toBe("commit 0123456789abcdef\nAuthor: x\n");
	});

	it("takes in a long line spanning many chunks in linear time", () => {
		// Re-concatenating the partial line per chunk took ~1 s here.
		const splitter = new SectionSplitter(1048576);
		const chunk = Buffer.alloc(65536, 0x61);
		const started = performance.now();
		for (let i = 0; i < 512; i++) {
			splitter.feed(chunk);
		}
		const sections = [...splitter.feed(Buffer.from("\n")), ...splitter.finish()];
		expect(performance.now() - started).toBeLessThan(250);
		expect(sections.reduce((n, s) => n + s.byte_length, 0)).toBe(512 * 65536 + 1);
	});

	it("produces identical file sections for any chunking of the input", () => {
		const reference = merge_preamble(split_all(Buffer.from(SAMPLE_DIFF)));
		fc.assert(fc.property(
			fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 60 }),
			(chunk_sizes) => {
				const data = Buffer.from(SAMPLE_DIFF);
				const splitter = new SectionSplitter();
				const sections: diff_section[] = [];
				let offset = 0;
				for (const size of chunk_sizes) {
					if (offset >= data.length) {
						break;
					}
					sections.push(...splitter.feed(data.subarray(offset, offset + size)));
					offset += size;
				}
				sections.push(...splitter.feed(data.subarray(offset)));
				sections.push(...splitter.finish());
				const merged = merge_preamble(sections);
				expect(merged.length).toBe(reference.length);
				for (let i = 0; i < merged.length; i++) {
					expect(merged[i].equals(reference[i])).toBe(true);
				}
			},
		));
	});
});

describe("unquote_git_path", () => {
	it("passes plain paths through", () => {
		expect(unquote_git_path("a/some/file.c")).toBe("a/some/file.c");
	});

	it("unquotes escapes and octal UTF-8", () => {
		expect(unquote_git_path("\"a/we\\ttab\"")).toBe("a/we\ttab");
		expect(unquote_git_path("\"a/caf\\303\\251.txt\"")).toBe("a/café.txt");
		expect(unquote_git_path("\"a/q\\\"uote\"")).toBe("a/q\"uote");
	});

	it("keeps unescaped UTF-8 (core.quotePath=false)", () => {
		expect(unquote_git_path("\"a/中\\ttab-é.js\"")).toBe("a/中\ttab-é.js");
		expect(unquote_git_path("\"a/😀\\\"q.js\"")).toBe("a/😀\"q.js");
	});

	it("rejects malformed quoting", () => {
		expect(unquote_git_path("\"unterminated")).toBe(null);
		expect(unquote_git_path("\"bad\\z\"")).toBe(null);
	});
});

describe("parse_file_section", () => {
	function file_section(lines: string[]): diff_section {
		return {
			kind: "file",
			lines: lines.map((text) => ({ bytes: Buffer.from(text), had_newline: true })),
			byte_length: lines.reduce((n, text) => n + text.length + 1, 0),
		};
	}

	it("parses a rename with different extensions and maps hunks", () => {
		const sections = split_all(Buffer.from(SAMPLE_DIFF));
		const info = parse_file_section(sections[2]);
		expect(info).not.toBe(null);
		expect(info?.old_path).toBe("bar.py");
		expect(info?.new_path).toBe("baz.py");
		expect(info?.hunks.length).toBe(1);
		expect(info?.old_last_line).toBe(1);
		expect(info?.new_last_line).toBe(1);
	});

	it("treats /dev/null sides as absent", () => {
		const info = parse_file_section(file_section([
			"diff --git a/new.c b/new.c",
			"new file mode 100644",
			"index 0000000..1234567",
			"--- /dev/null",
			"+++ b/new.c",
			"@@ -0,0 +1,2 @@",
			"+int x;",
			"+int y;",
		]));
		expect(info?.old_path).toBe(null);
		expect(info?.new_path).toBe("new.c");
		expect(info?.old_oid).toBe(null);
		expect(info?.new_oid).toBe("1234567");
	});

	it("handles --no-prefix paths", () => {
		const info = parse_file_section(file_section([
			"diff --git foo.c foo.c",
			"index 1111111..2222222 100644",
			"--- foo.c",
			"+++ foo.c",
			"@@ -1 +1 @@",
			"-a",
			"+b",
		]));
		expect(info?.old_path).toBe("foo.c");
		expect(info?.new_path).toBe("foo.c");
	});

	it("rejects combined diffs and binary files", () => {
		expect(parse_file_section(file_section([
			"diff --cc conflicted.c",
			"index 1111111,2222222..3333333",
		]))).toBe(null);
		expect(parse_file_section(file_section([
			"diff --git a/img.png b/img.png",
			"index 1111111..2222222 100644",
			"Binary files a/img.png and b/img.png differ",
		]))).toBe(null);
	});

	it("tracks per-side needs precisely: pure additions never need the old side", () => {
		const info = parse_file_section(file_section([
			"diff --git a/doc.txt b/doc.txt",
			"index 1111111..2222222 100644",
			"--- a/doc.txt",
			"+++ b/doc.txt",
			"@@ -10,2 +10,4 @@",
			" context a",
			"+added one",
			"+added two",
			" context b",
		]));
		expect(info?.old_last_line).toBe(0);   // no "-" lines: skip the old blob
		expect(info?.new_last_line).toBe(13);  // trailing context row
	});

	it("bounds the old side at the last deleted row, not the hunk end", () => {
		const info = parse_file_section(file_section([
			"diff --git a/doc.txt b/doc.txt",
			"index 1111111..2222222 100644",
			"--- a/doc.txt",
			"+++ b/doc.txt",
			"@@ -100,5 +100,4 @@",
			"-old first",
			" ctx1",
			" ctx2",
			" ctx3",
			" ctx4",
		]));
		expect(info?.old_last_line).toBe(100); // deletion at the hunk top
		expect(info?.new_last_line).toBe(103); // last context row (new side)
	});

	it("never needs the new side for a context-free pure deletion", () => {
		const info = parse_file_section(file_section([
			"diff --git a/doc.txt b/doc.txt",
			"index 1111111..2222222 100644",
			"--- a/doc.txt",
			"+++ b/doc.txt",
			"@@ -7,2 +6,0 @@",
			"-gone one",
			"-gone two",
		]));
		expect(info?.old_last_line).toBe(8);
		expect(info?.new_last_line).toBe(0);
	});

	it("drops the TAB git appends to names containing a space", () => {
		const info = parse_file_section(file_section([
			"diff --git a/my file.js b/my file.js",
			"index 1111111..2222222 100644",
			"--- a/my file.js\t",
			"+++ b/my file.js\t",
			"@@ -1 +1 @@",
			"-a",
			"+b",
		]));
		expect(info?.old_path).toBe("my file.js");
		expect(info?.new_path).toBe("my file.js");
	});

	it("ends at text following the last complete hunk", () => {
		// The next commit's header in `git log -p` lands in the previous
		// commit's last file section.
		const info = parse_file_section(file_section([
			"diff --git a/foo.c b/foo.c",
			"index 1111111..2222222 100644",
			"--- a/foo.c",
			"+++ b/foo.c",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"commit 0123456789abcdef",
			"Author: Someone <someone@example.com>",
			"",
			"    Next commit",
		]));
		expect(info?.hunks.length).toBe(1);
		expect(info?.hunks[0].body).toEqual([5, 6]);
	});

	it("rejects hunks whose counts do not match the body", () => {
		expect(parse_file_section(file_section([
			"diff --git a/foo.c b/foo.c",
			"index 1111111..2222222 100644",
			"--- a/foo.c",
			"+++ b/foo.c",
			"@@ -1,5 +1,5 @@",
			" only one line",
		]))).toBe(null);
	});
});
