/**
 * Languages whose grammars shiki does not bundle: grammars of VS Code
 * extensions, vendored in ../grammars as JSON (licenses beside them).
 * This module reads them when it loads, so that a daemon installed
 * without them fails to start, instead of leaving their files plain.
 */

import { readFile } from "node:fs/promises";
import { A } from "ayy";
import type { LanguageRegistration } from "shiki";

/** The directory of the vendored grammars. */
const GRAMMARS = new URL("../grammars/", import.meta.url);

/**
 * @param file            The grammar's file in GRAMMARS.
 * @param scope_name      The scope name that the grammar must have:
 *                        the name by which other grammars include it.
 * @param name            The language id to register the grammar under.
 * @param embedded_langs  The ids of the languages whose grammars it
 *                        includes, for shiki to check that they load.
 * @returns               The grammar, as shiki's loadLanguage() takes it.
 */
async function read_grammar(file: string, scope_name: string, name: string, embedded_langs: string[]): Promise<LanguageRegistration> {
	const grammar = JSON.parse(await readFile(new URL(file, GRAMMARS), "utf8"));
	A.eq(grammar.scopeName, scope_name, `the scope name of ${file}`);
	return { ...grammar, name, embeddedLangs: embedded_langs };
}

/**
 * Language id -> what to give shiki's loadLanguage() for it: the ids of
 * the bundled languages whose grammars its grammar includes, then the
 * vendored grammars, each after the grammars that it includes.
 */
export const vendored_langs: ReadonlyMap<string, readonly (string | LanguageRegistration)[]> = new Map([
	// From the Template Toolkit extension (samosad.tt), which VS Code
	// users install for .tt files.  Of the extension's four grammars,
	// VS Code gives .tt files the one that the extension registers last:
	// HTML+TT2, which colors TT2 directives with the TT2 grammar.
	["template-toolkit", [
		"css",
		"javascript",
		await read_grammar("TT2.tmLanguage.json", "source.tt2", "template-toolkit-directives", []),
		await read_grammar("HTML+TT2.tmLanguage.json", "text.html.tt2", "template-toolkit", ["template-toolkit-directives", "css", "javascript"]),
	]],
]);
