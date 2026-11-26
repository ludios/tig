/**
 * Writes src/vscode_langs.ts: the file names, extensions, path patterns
 * and first-line patterns that the extensions in a VS Code checkout
 * associate with each language, under shiki's language ids.  Run it in
 * tools/tig-syntax-filter:
 *
 *	node scripts/gen-vscode-langs.ts VSCODE_CHECKOUT
 *
 * A VS Code language becomes the shiki language whose grammar has the same
 * scope name: the two sets of language ids differ ("makefile" and "make"),
 * and an equal id would not promise an equal grammar anyway.  Where shiki
 * lacks the scope, the language becomes its stand-in from STAND_INS, or is
 * left out and listed on stderr.
 *
 * The table is written only after every pattern in it has compiled, and
 * through a temporary file, so a failed run leaves the old table in place.
 */

import { A } from "ayy";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundledLanguagesInfo } from "shiki";
import { first_line_regex, glob_regex, type lang_association } from "../src/lang_association.ts";

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

/**
 * VS Code language id -> the shiki language to use for it, for languages
 * whose grammar scope shiki lacks.
 */
const STAND_INS: Readonly<Record<string, string>> = {
	// VS Code's grammar colors only `#` comment lines.  The INI grammar
	// colors those the same, and little else in an ignore file.
	"ignore": "ini",
	// VS Code's grammar is C++ with CUDA's additions.
	"cuda-cpp": "cpp",
	// VS Code's grammar (text.html.php) is HTML with PHP embedded;
	// shiki's is PHP alone.
	"php": "php",
	// shiki's Razor grammar (text.aspnetcorerazor) is another one than
	// VS Code's built-in (text.html.cshtml).
	"razor": "razor",
	// VS Code's grammar is JSON with comments, plus snippet placeholders.
	"snippets": "jsonc",
};

/** @returns Grammar scope name -> the shiki language that it is the main
 *           grammar of. */
async function shiki_langs_by_scope(): Promise<Map<string, string>> {
	const by_scope = new Map<string, string>();
	for (const info of bundledLanguagesInfo) {
		// A language's module holds the grammars it embeds, too.
		const grammars = (await info.import()).default;
		const own = grammars.find((grammar) => grammar.name === info.id);
		A(own !== undefined, `shiki's ${info.id} module lacks its own grammar`);
		A.eq(by_scope.get(own.scopeName), undefined, `${info.id} has the same scope as another shiki language, ${own.scopeName}`);
		by_scope.set(own.scopeName, info.id);
	}
	return by_scope;
}

/**
 * Read the manifests of the extensions in a VS Code checkout.
 *
 * @param checkout  Path of the checkout's top directory.
 * @returns `languages`: every extension's language contributions, the
 *          extensions in the order of their directory names, which is the
 *          order VS Code registers its built-in extensions in.
 *          `scopes`: VS Code language id -> its grammar's scope name.
 */
function read_manifests(checkout: string): { languages: vscode_language[], scopes: Map<string, string> } {
	const extensions_dir = `${checkout}/extensions`;
	const languages: vscode_language[] = [];
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
	return { languages, scopes };
}

/** @returns `values` (file names, extensions or globs from a manifest)
 *           lowercased, because VS Code compares them with a lowercased
 *           path; sorted and without duplicates. */
function normalized(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.toLowerCase()))].toSorted();
}

/**
 * @param language  A language contribution.
 * @param lang      The shiki language that stands for it.
 * @returns The contribution as a lang_association whose patterns all
 *          compile, or null when it associates nothing with the language
 *          (the contribution only names or configures it).
 */
function association(language: vscode_language, lang: string): lang_association | null {
	const result: lang_association = { lang };
	const lists = {
		extensions: normalized(language.extensions),
		filenames: normalized(language.filenames),
		patterns: normalized(language.filenamePatterns),
	};
	for (const [key, values] of Object.entries(lists) as [keyof typeof lists, string[]][]) {
		if (values.length > 0) {
			result[key] = values;
		}
	}
	lists.patterns.forEach(glob_regex);
	// VS Code skips an empty first-line pattern, and one that matches the
	// empty string.
	if (language.firstLine !== undefined && language.firstLine !== "" &&
	    !first_line_regex(language.firstLine).test("")) {
		result.first_line = language.firstLine;
	}
	return Object.keys(result).length > 1 ? result : null;
}

/**
 * @param associations  The table's entries, in VS Code's registration
 *                      order.
 * @param commit        The VS Code commit that they come from.
 * @returns The text of src/vscode_langs.ts.
 */
function table_source(associations: readonly lang_association[], commit: string): string {
	const blocks = associations.map((entry) => {
		const fields = Object.entries(entry).map(([key, value]) => {
			const literal = typeof value === "string"
				? JSON.stringify(value)
				: `[${(value as readonly string[]).map((item) => JSON.stringify(item)).join(", ")}]`;
			return `\t\t${key}: ${literal},\n`;
		});
		return `\t{\n${fields.join("")}\t},\n`;
	});
	return `/**
 * The file associations of the languages in VS Code's extensions/
 * directory, under shiki's language ids, in the order VS Code registers
 * them.  See lang_map.ts for their meaning.
 *
 * Generated by scripts/gen-vscode-langs.ts from VS Code commit
 * ${commit}; do not edit.
 * The associations come from VS Code's extension manifests, which are
 * Copyright (c) Microsoft Corporation and under the MIT License.
 */

import type { lang_association } from "./lang_association.ts";

export const vscode_langs: readonly lang_association[] = [
${blocks.join("")}];
`;
}

async function main(): Promise<void> {
	const checkout = process.argv[2];
	A(checkout !== undefined, "usage: node scripts/gen-vscode-langs.ts VSCODE_CHECKOUT");
	const { languages, scopes } = read_manifests(checkout);
	const by_scope = await shiki_langs_by_scope();
	const shiki_langs = new Set(by_scope.values());
	for (const [id, stand_in] of Object.entries(STAND_INS)) {
		A(shiki_langs.has(stand_in), `shiki lacks ${stand_in}, the stand-in for ${id}`);
	}

	const associations: lang_association[] = [];
	const left_out = new Set<string>();
	for (const language of languages) {
		const scope = scopes.get(language.id);
		const lang = (scope === undefined ? undefined : by_scope.get(scope)) ?? STAND_INS[language.id];
		if (lang === undefined) {
			left_out.add(`${language.id} (${scope ?? "no grammar"})`);
			continue;
		}
		const entry = association(language, lang);
		if (entry !== null) {
			associations.push(entry);
		}
	}
	A.gt(associations.length, 0, `no language associations under ${checkout}/extensions`);

	const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const table_path = fileURLToPath(new URL("../src/vscode_langs.ts", import.meta.url));
	const temp_path = `${table_path}.tmp`;
	writeFileSync(temp_path, table_source(associations, commit));
	renameSync(temp_path, table_path);
	console.error(`VS Code languages left out, whose grammar scope does not belong to a shiki language:\n\t${[...left_out].toSorted().join("\n\t")}`);
}

await main();
