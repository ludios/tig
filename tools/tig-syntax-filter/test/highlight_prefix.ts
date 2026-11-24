/**
 * highlight_lines() for every line of a document from line 1, as an
 * array: the shape most tests compare.
 */

import { A } from "ayy";
import { highlight_lines } from "../src/highlight.ts";

/**
 * Render lines 1..`depth` of `content` (split at "\n") as `lang`.
 * `identity`, `deadline` and `cancelled` are as for highlight_lines().
 *
 * @returns  Element i is line i + 1's SGR-annotated text, or null when
 *           highlight_lines() gave up.
 */
export async function highlight_prefix(identity: string, lang: string, content: string, depth: number,
				       deadline: number | null, cancelled?: () => boolean): Promise<string[] | null> {
	const lines = content.split("\n");
	A.lte(depth, lines.length, "depth past the end of content");
	const rows = Array.from({ length: depth }, (_, i) => i + 1);
	const sgr = await highlight_lines(identity, lang, lines, rows, deadline, cancelled);
	return sgr === null ? null : rows.map((row) => sgr.get(row)!);
}
