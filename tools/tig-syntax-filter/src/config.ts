// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5

/**
 * Budget and limit knobs, read from the environment at daemon start.  A
 * missing, malformed, or out-of-range value means the default; the ranges
 * keep a typo from disabling a bound.
 *
 * - TIG_SYNTAX_BUDGET_MS: tokenization time per file section, shared by
 *   both sides; a side not done by then renders raw (see highlight.ts).
 *   Grammar loading and blob fetching don't count.  Generous, since
 *   tokenization is cached and resumes where it stopped: a big budget is
 *   usually paid once per document, while a small one keeps slow-grammar
 *   files raw across several visits.  Must fit inside the client's frame
 *   deadline, with room for contention.
 * - TIG_SYNTAX_MAX_LINES: a side whose hunks reach deeper into its source
 *   is not highlighted (bounds tokenization memory).
 * - TIG_SYNTAX_MAX_SECTION_BYTES: larger file sections stream through raw
 *   instead of being buffered (see diff_parser.ts).
 * - TIG_SYNTAX_LINE_CACHE_MB / TIG_SYNTAX_BLOB_CACHE_MB: approximate
 *   budgets for the tokenized-line cache (highlight.ts) and the blob cache
 *   (git.ts).
 */

/** Parse integer environment variable `name`, enforcing [min, max]. */
function int_env(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		return fallback;
	}
	const value = parseInt(raw, 10);
	if (!Number.isFinite(value) || String(value) !== raw.trim() ||
	    value < min || value > max) {
		return fallback;
	}
	return value;
}

export const config = {
	budget_ms: int_env("TIG_SYNTAX_BUDGET_MS", 10000, 50, 600000),
	max_lines: int_env("TIG_SYNTAX_MAX_LINES", 100000, 100, 1000000),
	max_section_bytes: int_env("TIG_SYNTAX_MAX_SECTION_BYTES", 1 << 20, 1 << 16, 1 << 26),
	line_cache_mb: int_env("TIG_SYNTAX_LINE_CACHE_MB", 64, 1, 4096),
	blob_cache_mb: int_env("TIG_SYNTAX_BLOB_CACHE_MB", 64, 1, 4096),
};
