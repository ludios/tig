/**
 * After highlighting, a section is validated and rebuilt in slices that
 * yield to the event loop: yielding leaves the output byte-identical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectionSplitter, type diff_section } from "../src/diff_parser.ts";
import { init_highlighter, SLICE_MS } from "../src/highlight.ts";
import { process_section } from "../src/process.ts";

/** Lines in the test file; every one is styled, in one hunk. */
const LINES = 300;

let repo: string;

/** The commit's only file section, and its output with the clock running
 * normally, which also leaves every styled line's rendering cached. */
let section: diff_section;
let expected: Buffer;

function git(...args: string[]): Buffer {
	return execFileSync("git", ["-C", repo, ...args]);
}

/**
 * Process `section` with a clock that advances by more than SLICE_MS on
 * every reading, so that every line of validation and rebuilding ends a
 * slice.  Since every styled line's rendering is cached, no tokenizing
 * pass runs, so the clock affects nothing else.
 *
 * @param cancelled  Passed to process_section(); polled after each yield.
 * @returns          The output, and how many times cancelled() was polled.
 */
async function process_with_fast_clock(cancelled: () => boolean): Promise<{ output: Buffer, polls: number }> {
	let now = performance.now();
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now += SLICE_MS + 1);
	let polls = 0;
	try {
		const output = await process_section(repo, section, () => {
			polls++;
			return cancelled();
		});
		return { output, polls };
	} finally {
		clock.mockRestore();
	}
}

beforeAll(async () => {
	await init_highlighter();
	repo = await mkdtemp(join(tmpdir(), "tig-syntax-assembly-test-"));
	git("init", "-q");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.invalid");
	const lines = Array.from({ length: LINES }, (_, i) => `const v_${i} = ${i};`);
	await writeFile(join(repo, "doc.ts"), lines.join("\n") + "\n");
	git("add", "-A");
	git("commit", "-qm", "before");
	lines[0] = "const first = 0;";
	await writeFile(join(repo, "doc.ts"), lines.join("\n") + "\n");
	git("commit", "-qam", "after");

	const splitter = new SectionSplitter();
	const diff = git("show", "--no-color", `-U${LINES}`, "HEAD");
	section = [...splitter.feed(diff), ...splitter.finish()].find((s) => s.kind === "file")!;
	expected = await process_section(repo, section);
}, 60000);

afterAll(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("validating and rebuilding a section", () => {
	it("yields between lines without changing the output", async () => {
		expect(expected.toString("utf8")).toContain("\x1b[");
		const { output, polls } = await process_with_fast_clock(() => false);
		expect(output.equals(expected)).toBe(true);
		// A yield, and so a poll, before each line of validation (the
		// hunk's LINES + 1 lines) and of rebuilding (the section's lines).
		expect(polls).toBe(LINES + 1 + section.lines.length);
	});
});
