/**
 * Languages whose grammars shiki does not bundle: grammars of VS Code
 * extensions, vendored in ../grammars as JSON (licenses beside them).
 */

import { readFile } from "node:fs/promises";
import { A } from "ayy";
import type { BundledLanguage, LanguageRegistration } from "shiki";

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
	const text = await readFile(new URL(file, GRAMMARS), "utf8");
	const grammar = JSON.parse(text);
	A.eq(grammar.scopeName, scope_name, `the scope name of ${file}`);
	return { ...grammar, name, embeddedLangs: embedded_langs };
}

/** What to give shiki's loadLanguage() for a language: the ids of the
 * bundled languages whose grammars its grammar includes, then the
 * vendored grammars, each after the grammars that it includes. */
export type lang_inputs = readonly (BundledLanguage | LanguageRegistration)[];

/**
 * Read the vendored grammars.
 *
 * @returns  Language id -> what to give shiki's loadLanguage() for it.
 */
export async function read_vendored_langs(): Promise<ReadonlyMap<string, lang_inputs>> {
	// From the Template Toolkit extension (samosad.tt), which VS Code
	// users install for .tt files.  Of the extension's four grammars,
	// VS Code gives .tt files the one that the extension registers last:
	// HTML+TT2, which colors TT2 directives with the TT2 grammar.
	const tt2 = await read_grammar("TT2.tmLanguage.json", "source.tt2", "template-toolkit-directives", []);
	const html_tt2 = await read_grammar("HTML+TT2.tmLanguage.json", "text.html.tt2", "template-toolkit", ["template-toolkit-directives", "css", "javascript"]);
	return new Map([["template-toolkit", ["css", "javascript", tt2, html_tt2]]]);
}
