// Model-output: Claude Fable 5

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { section_splitter, parse_file_section, unquote_git_path, type diff_section } from "../src/diff_parser.ts";

/** Split `data` into sections in one go. */
function split_all(data: Buffer): diff_section[] {
	const splitter = new section_splitter();
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

describe("section_splitter", () => {
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

	it("produces identical sections for any chunking of the input", () => {
		const reference = split_all(Buffer.from(SAMPLE_DIFF));
		fc.assert(fc.property(
			fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 60 }),
			(chunk_sizes) => {
				const data = Buffer.from(SAMPLE_DIFF);
				const splitter = new section_splitter();
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
				expect(sections.length).toBe(reference.length);
				for (let i = 0; i < sections.length; i++) {
					expect(section_bytes(sections[i]).equals(section_bytes(reference[i]))).toBe(true);
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
