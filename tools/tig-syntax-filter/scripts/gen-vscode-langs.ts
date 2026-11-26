/**
 * Writes src/vscode_langs.ts: which file names, extensions, path patterns
 * and first lines VS Code's built-in extensions associate with each
 * language, for the languages that shiki has a grammar for.
 *
 *	node scripts/gen-vscode-langs.ts VSCODE_CHECKOUT > src/vscode_langs.ts
 *
 * A VS Code language becomes the shiki language whose grammar has the same
 * scope name: the two sets of language ids differ ("makefile" and "make"),
 * and an equal id would not promise an equal grammar anyway.  VS Code
 * languages whose scope shiki lacks are left out, and listed on stderr.
 */

import { A } from "ayy";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { bundledLanguagesInfo } from "shiki";
import type { lang_association } from "../src/lang_map.ts";

/** A `contributes.languages` entry of a VS Code extension's package.json. */
interface vscode_language {
	id: string,
	extensions?: string[],
	filenames?: string[],
	filenamePatterns?: string[],
	firstLine?: string,
}

/** A `contributes.grammars` entry; `language` is absent on a grammar that
 * is only embedded in or injected into others. */
interface vscode_grammar {
	language?: string,
	scopeName: string,
}

/** @returns Grammar scope name -> the shiki language that it is the main
 *           grammar of. */
async function shiki_langs_by_scope(): Promise<Map<string, string>> {
	const by_scope = new Map<string, string>();
	for (const info of bundledLanguagesInfo) {
		// A language's module holds the grammars it embeds, too.
		const grammars = (await info.import()).default;
		const main = grammars.find((grammar) => grammar.name === info.id);
		A(main !== undefined, `shiki's ${info.id} module lacks its own grammar`);
		A(!by_scope.has(main.scopeName), `two shiki languages have the scope ${main.scopeName}`);
		by_scope.set(main.scopeName, info.id);
	}
	return by_scope;
}

/** @returns `values` lowercased (VS Code compares all of them without
 *           regard to case), sorted, without duplicates. */
function normalized(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.toLowerCase()))].toSorted();
}

const checkout = process.argv[2];
A(checkout !== undefined, "usage: gen-vscode-langs.ts VSCODE_CHECKOUT");
const extensions_dir = `${checkout}/extensions`;
const languages: vscode_language[] = [];
/** VS Code language id -> its grammar's scope name.  One extension gives
 * a language its grammar; others may add file names to the language. */
const scopes = new Map<string, string>();
for (const dir of readdirSync(extensions_dir).toSorted()) {
	const manifest_path = `${extensions_dir}/${dir}/package.json`;
	if (!existsSync(manifest_path)) {
		continue;
	}
	const contributes = JSON.parse(readFileSync(manifest_path, "utf8")).contributes ?? {};
	languages.push(...(contributes.languages as vscode_language[] | undefined ?? []));
	for (const grammar of contributes.grammars as vscode_grammar[] | undefined ?? []) {
		// Of several grammars for one language, VS Code uses the last.
		if (grammar.language !== undefined) {
			scopes.set(grammar.language, grammar.scopeName);
		}
	}
}

const by_scope = await shiki_langs_by_scope();
/** shiki language -> what VS Code associates with it; several VS Code
 * languages can share one grammar, and several extensions can add to one
 * language. */
const merged = new Map<string, { extensions: string[], filenames: string[], patterns: string[], first_lines: string[] }>();
const left_out = new Set<string>();
for (const language of languages) {
	const scope = scopes.get(language.id);
	const lang = scope === undefined ? undefined : by_scope.get(scope);
	if (lang === undefined) {
		left_out.add(`${language.id} (${scope ?? "no grammar"})`);
		continue;
	}
	let entry = merged.get(lang);
	if (entry === undefined) {
		entry = { extensions: [], filenames: [], patterns: [], first_lines: [] };
		merged.set(lang, entry);
	}
	entry.extensions.push(...language.extensions ?? []);
	entry.filenames.push(...language.filenames ?? []);
	entry.patterns.push(...language.filenamePatterns ?? []);
	if (language.firstLine !== undefined) {
		entry.first_lines.push(language.firstLine);
	}
}

const associations: lang_association[] = [];
/** "kind value" -> the language that has it, to catch a value that two
 * languages claim: VS Code then takes whichever it registered last. */
const claimed = new Map<string, string>();
for (const [lang, entry] of [...merged.entries()].toSorted(([a], [b]) => a < b ? -1 : 1)) {
	A.lte(entry.first_lines.length, 1, `several first-line patterns for ${lang}`);
	const association: lang_association = {
		lang,
		extensions: normalized(entry.extensions),
		filenames: normalized(entry.filenames),
		patterns: normalized(entry.patterns),
		...(entry.first_lines[0] === undefined ? {} : { first_line: entry.first_lines[0] }),
	};
	for (const kind of ["extensions", "filenames", "patterns"] as const) {
		for (const value of association[kind]!) {
			const key = `${kind} ${value}`;
			A(!claimed.has(key), `${key} belongs to both ${claimed.get(key)} and ${lang}`);
			claimed.set(key, lang);
		}
	}
	associations.push(association);
}

const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const blocks = associations.map((association) => {
	const fields = Object.entries(association)
		.filter(([, value]) => typeof value === "string" || value.length > 0)
		.map(([key, value]) => `\t\t${key}: ${JSON.stringify(value).replaceAll('","', '", "')},\n`);
	return `\t{\n${fields.join("")}\t},\n`;
});
process.stdout.write(`/**
 * The file associations of VS Code's built-in languages, under shiki's
 * language ids.  See lang_map.ts for their meaning.
 *
 * Generated by scripts/gen-vscode-langs.ts from VS Code commit
 * ${commit}; do not edit.
 */

import type { lang_association } from "./lang_map.ts";

export const vscode_langs: readonly lang_association[] = [
${blocks.join("")}];
`);
console.error(`VS Code languages left out, without a grammar that shiki has:\n\t${[...left_out].toSorted().join("\n\t")}`);
