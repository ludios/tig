/**
 * Budget and limit knobs, read from the environment at daemon start.  A
 * missing, malformed, or out-of-range value means the default; the ranges
 * keep a typo from disabling a bound.
 *
 * - TIG_SYNTAX_BUDGET_MS: time per file section, from when the daemon
 *   starts on it, shared by both sides; a side not tokenized by then
 *   renders raw (see process.ts and highlight.ts).  Generous, since
 *   tokenization is cached and resumes where it stopped: a big budget is
 *   usually paid once per document, while a small one keeps giant files
 *   raw across several visits.  Must fit inside the client's frame
 *   deadline (60 s by default), with room for contention.
 * - TIG_SYNTAX_MAX_LINES: a side whose hunks reach deeper into its source
 *   is not highlighted (bounds tokenization memory).
 * - TIG_SYNTAX_MAX_SECTION_BYTES: larger file sections stream through raw
 *   instead of being buffered (see diff_parser.ts), as do sections of
 *   more than twice TIG_SYNTAX_MAX_LINES lines.  Highlighted output can
 *   be ~20 times its input, and the client takes frames of up to 1 GiB
 *   and spools up to 64 MiB of the diff.
 * - TIG_SYNTAX_LINE_CACHE_MB / TIG_SYNTAX_BLOB_CACHE_MB: approximate
 *   budgets for the tokenization cache (line-start grammar states and
 *   rendered lines; highlight.ts) and the blob cache (git.ts).
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
	budget_ms: int_env("TIG_SYNTAX_BUDGET_MS", 45000, 50, 600000),
	max_lines: int_env("TIG_SYNTAX_MAX_LINES", 1000000, 100, 1000000),
	max_section_bytes: int_env("TIG_SYNTAX_MAX_SECTION_BYTES", 1 << 25, 1 << 16, 1 << 26),
	line_cache_mb: int_env("TIG_SYNTAX_LINE_CACHE_MB", 128, 1, 4096),
	blob_cache_mb: int_env("TIG_SYNTAX_BLOB_CACHE_MB", 64, 1, 4096),
};
