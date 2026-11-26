import { describe, it, expect } from "vitest";
import { first_line_regex, glob_regex } from "../src/lang_association.ts";

describe("glob_regex", () => {
	it("keeps * and ? within one path component", () => {
		expect(glob_regex("a/*.json").test("a/b.json")).toBe(true);
		expect(glob_regex("a/*.json").test("a/b/c.json")).toBe(false);
		expect(glob_regex("a?c").test("abc")).toBe(true);
		expect(glob_regex("a?c").test("a/c")).toBe(false);
		expect(glob_regex("a.c").test("abc")).toBe(false);
	});

	it("lets a ** component match any number of directories", () => {
		expect(glob_regex("**/a/*").test("a/b")).toBe(true);
		expect(glob_regex("**/a/*").test("x/y/a/b")).toBe(true);
		expect(glob_regex("**/a/*").test("xa/b")).toBe(false);
		expect(glob_regex("a/**/b").test("a/b")).toBe(true);
		expect(glob_regex("a/**/b").test("a/x\ny/b")).toBe(true);
	});

	it("refuses syntax that it lacks", () => {
		expect(() => glob_regex("{a,b}.json")).toThrow("glob syntax that glob_regex() lacks");
		expect(() => glob_regex("a**/b")).toThrow("glob syntax that glob_regex() lacks");
		expect(() => glob_regex("a/**")).toThrow("glob syntax that glob_regex() lacks");
	});
});

describe("first_line_regex", () => {
	it("anchors every alternative at the line's start", () => {
		expect(first_line_regex("a|b").test("b")).toBe(true);
		expect(first_line_regex("a|b").test("xb")).toBe(false);
		expect(first_line_regex("(a|b)c").test("bc")).toBe(true);
		expect(first_line_regex("(a|b)c").test("xbc")).toBe(false);
		expect(first_line_regex("^#!|^<").test("<svg")).toBe(true);
	});

	it("refuses a pattern that compiles only inside the group around it", () => {
		expect(() => first_line_regex("a)|(b")).toThrow(SyntaxError);
	});
});
