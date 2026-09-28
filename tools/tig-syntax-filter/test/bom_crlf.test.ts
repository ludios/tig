// Model-output: Claude Opus 5.5

/**
 * Bytes that editors strip before tokenizing — a UTF-8 byte-order mark
 * (the norm for C# written in Visual Studio) and CRLF carriage returns —
 * are kept out of the grammar and passed through unstyled: such files
 * highlight exactly like their LF, mark-less twins, and the output stays
 * byte-lossless.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "@logtape/logtape";
import { SectionSplitter } from "../src/diff_parser.ts";
import { init_highlighter, ensure_lang, highlight_lines } from "../src/highlight.ts";
import { process_section } from "../src/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const BOM = "\uFEFF";

/** `text` with every LF line ending replaced by `ending`. */
function with_endings(text: string, ending: string): string {
	return text.replaceAll("\n", ending);
}

const PROGRAM = [
	"using System;",
	"",
	"namespace Demo",
	"{",
	"    public static class Greeter",
	"    {",
	"        public static string Greet(string name) => $\"Hello, {name}!\";",
	"    }",
	"}",
	"",
].join("\n");

const EDITED = PROGRAM
	.replace("using System;", "using System.Linq;")
	.replace("Hello, ", "Hi, ");

/** Each test file's content before and after the commit under test. */
const FILES: Record<string, [string, string]> = {
	"Plain.cs":   [PROGRAM, EDITED],
	"Bom.cs":     [BOM + PROGRAM, BOM + EDITED],
	"Crlf.cs":    [with_endings(PROGRAM, "\r\n"), with_endings(EDITED, "\r\n")],
	"BomCrlf.cs": [BOM + with_endings(PROGRAM, "\r\n"), BOM + with_endings(EDITED, "\r\n")],
	"CrCrlf.cs":  [with_endings(PROGRAM, "\r\r\n"), with_endings(EDITED, "\r\r\n")],
	"Gains.cs":   [PROGRAM, BOM + PROGRAM],
};

let repo: string;

/** Input and output bytes of each file section of the commit's diff,
 * keyed by file name. */
const sections = new Map<string, { input: Buffer, output: Buffer }>();

function git(...args: string[]): Buffer {
	return execFileSync("git", ["-C", repo, ...args]);
}

/** Write each file's `side` (0: before, 1: after) and commit them. */
async function commit(side: 0 | 1): Promise<void> {
	for (const [name, contents] of Object.entries(FILES)) {
		await writeFile(join(repo, name), contents[side]);
	}
	git("add", "-A");
	git("commit", "-qm", `side ${side}`);
}

beforeAll(async () => {
	await configure({
		sinks: {},
		loggers: [
			{ category: ["tig-syntax"], lowestLevel: "fatal", sinks: [] },
			{ category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
		],
	});
	await init_highlighter();
	repo = await mkdtemp(join(tmpdir(), "tig-syntax-bom-crlf-test-"));
	git("init", "-q");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.invalid");
	git("config", "core.autocrlf", "false");
	await commit(0);
	await commit(1);

	const splitter = new SectionSplitter();
	const diff = git("show", "--no-color", "HEAD");
	for (const section of [...splitter.feed(diff), ...splitter.finish()]) {
		if (section.kind !== "file") {
			continue;
		}
		const input = Buffer.concat(section.lines.map((line) =>
			Buffer.concat([line.bytes, Buffer.from(line.had_newline ? "\n" : "")])));
		const name = /^diff --git a\/(\S+) /.exec(input.toString("utf8"))![1];
		sections.set(name, { input, output: await process_section(repo, section) });
	}
}, 60000);

/** Section output from its first hunk header on, as text. */
function hunks_of(name: string): string {
	const text = sections.get(name)!.output.toString("utf8");
	return text.slice(text.indexOf("\n@@"));
}

describe("byte-order marks and carriage returns", () => {
	it("keep every section lossless", () => {
		expect([...sections.keys()].sort()).toEqual(Object.keys(FILES).sort());
		for (const [name, { input, output }] of sections) {
			const stripped = output.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
			expect(Buffer.from(stripped, "utf8").equals(input), `lossless for ${name}`).toBe(true);
		}
	});

	it("leave every hunk line styled", () => {
		for (const name of sections.keys()) {
			const body = hunks_of(name).split("\n")
				.filter((line) => line !== "" && !line.startsWith("@@"));
			expect(body.length, name).toBeGreaterThan(0);
			for (const line of body) {
				expect(line, `${name}: ${JSON.stringify(line)}`).toContain("\x1b[");
			}
		}
	});

	it("highlight like the LF, mark-less twin", () => {
		const plain = hunks_of("Plain.cs");
		for (const name of ["Bom.cs", "Crlf.cs", "BomCrlf.cs", "CrCrlf.cs"]) {
			expect(hunks_of(name).replaceAll(BOM, "").replaceAll("\r", ""), name).toBe(plain);
		}
		expect(hunks_of("Bom.cs")).toContain(`\n+${BOM}\x1b[`);
		expect(hunks_of("Gains.cs")).toContain(`\n-\x1b[`);
		expect(hunks_of("Gains.cs")).toContain(`\n+${BOM}\x1b[`);
	});

	it("tokenize CRLF documents like LF ones across chunk boundaries", async () => {
		// git.ts spans several 128-line tokenization chunks.
		const lines = (await readFile(join(HERE, "..", "src", "git.ts"), "utf8")).split("\n");
		await ensure_lang("typescript");
		const lf = await highlight_lines("test|lf", "typescript", lines.join("\n"), lines.length, null);
		const crlf = await highlight_lines("test|crlf", "typescript", lines.join("\r\n"), lines.length, null);
		expect(lf).not.toBeNull();
		const last = lines.length - 1;
		expect(crlf).toEqual(lf!.map((line, i) => i < last ? line + "\r" : line));
	});
});
