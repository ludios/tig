import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { shebang_program } from "../src/shebang.ts";

describe("shebang_program", () => {
	it("gives the file name of the program after #!", () => {
		expect(shebang_program("#!/usr/bin/gawk -f")).toBe("gawk");
		expect(shebang_program("#! /home/nu/venv/bin/python")).toBe("python");
		expect(shebang_program("#!awk")).toBe("awk");
		expect(shebang_program("#!")).toBe(null);
		expect(shebang_program("#!/usr/bin/")).toBe(null);
		expect(shebang_program("awk")).toBe(null);
		expect(shebang_program(" #!/usr/bin/awk")).toBe(null);
	});

	it("gives the program that env runs", () => {
		expect(shebang_program("#!/usr/bin/env nu")).toBe("nu");
		expect(shebang_program("#!/usr/bin/env -S /usr/bin/awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S -u nu python3")).toBe("python3");
		expect(shebang_program("#!/usr/bin/env -S --chdir /srv/nu python3")).toBe("python3");
		expect(shebang_program("#!/usr/bin/env -S LC_ALL=C awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S FOO=\"a nu b\" python3")).toBe("python3");
		expect(shebang_program("#!/usr/bin/env -S X='it\\'s nu' python3")).toBe("python3");
		expect(shebang_program("#!/usr/bin/env -S -- awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S awk\\_-f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env")).toBe(null);
		expect(shebang_program("#!/usr/bin/env -S -u")).toBe(null);
		expect(shebang_program("#!/usr/bin/env -S '' awk")).toBe(null);
	});

	it("takes the words after the interpreter as separate arguments, as macOS passes them", () => {
		expect(shebang_program("#!/usr/bin/env -u nu awk -f")).toBe("awk");
		expect(shebang_program("#!/bin/busybox env -u nu awk")).toBe("awk");
	});

	it("takes a quote that is not closed to run to the end of the line", () => {
		expect(shebang_program("#!/usr/bin/env -S 'awk")).toBe("'awk");
		expect(shebang_program("#!/usr/bin/env -S MSG=\"/usr/bin/awk")).toBe(null);
	});

	it("stops taking env's options at the first word that is not one", () => {
		expect(shebang_program("#!/usr/bin/env -S X=1 -u nu awk")).toBe("-u");
		expect(shebang_program("#!/usr/bin/env -S -- -u nu awk")).toBe("-u");
	});

	it("takes the words of -S's operand, also when it starts in -S's own word", () => {
		expect(shebang_program("#!/usr/bin/env -Sawk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -iS-unu awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env --split-string=awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S --split-string awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S 'awk' -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S --split-string=\"nu --stdin\"")).toBe("nu");
	});

	it("gives the program that busybox runs", () => {
		expect(shebang_program("#!/usr/bin/env -S busybox awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S busybox.static /usr/bin/awk -f")).toBe("awk");
		expect(shebang_program("#!/usr/bin/env -S busybox env -u nu awk")).toBe("awk");
		expect(shebang_program("#!/bin/busybox")).toBe(null);
	});

	it("skips words that have the form of env's options, their operands, and assignments", () => {
		const name = fc.constantFrom("nu", "awk", "raku", "fish", "sh", "python3");
		const option = fc.oneof(
			fc.constantFrom("-i", "-v", "-iv", "-S", "--debug", "--ignore-environment", "--block-signal=PIPE"),
			name.map((n) => `-u ${n}`),
			name.map((n) => `-u${n}`),
			name.map((n) => `-iu ${n}`),
			name.map((n) => `-C /srv/${n}`),
			name.map((n) => `-C/srv/${n}`),
			name.map((n) => `-a ${n}`),
			name.map((n) => `-P /opt/${n}/bin`),
			name.map((n) => `--unset ${n}`),
			name.map((n) => `--uns ${n}`),
			name.map((n) => `--unset=${n}`),
			name.map((n) => `--chdir /srv/${n}`),
			name.map((n) => `--argv0 ${n}`),
		);
		const assignment = fc.oneof(
			name.map((n) => `${n}=/srv/${n}`),
			name.map((n) => `X="a ${n} b"`),
			name.map((n) => `X='${n} ${n}'`),
		);
		const env_words = fc.tuple(
			fc.array(option, { maxLength: 4 }),
			fc.constantFrom([], ["--"], ["-"], ["--", "-"]),
			fc.array(assignment, { maxLength: 3 }),
		).map((parts) => parts.flat());
		fc.assert(fc.property(env_words, name, fc.constantFrom("", "/usr/bin/", "./"), (words, program, directory) => {
			const line = `#!/usr/bin/env -S ${[...words, directory + program, "-f", "nu"].join(" ")}`;
			expect(shebang_program(line)).toBe(program);
		}));
	});
});
