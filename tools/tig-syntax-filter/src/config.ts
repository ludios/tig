// Model-output: Claude Fable 5

/**
 * Budget and limit knobs (plan item A6), read once from the environment at
 * daemon start.  Every knob falls back to its default on a missing, malformed,
 * or out-of-range value; ranges exist so a typo cannot disable a safety
 * bound entirely.
 *
 * - TIG_SYNTAX_BUDGET_MS: per-section tokenization budget shared by both
 *   sides of a file diff.  Exceeding it makes the section fall back to raw
 *   (see highlight.ts); grammar loading and blob fetching do not count.
 * - TIG_SYNTAX_MAX_LINES: deepest source line a hunk may require before the
 *   section is not highlighted at all (bounds tokenization memory).
 * - TIG_SYNTAX_MAX_SECTION_BYTES: file sections larger than this stop being
 *   buffered and stream through raw instead (see diff_parser.ts).
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
	budget_ms: int_env("TIG_SYNTAX_BUDGET_MS", 500, 50, 600000),
	max_lines: int_env("TIG_SYNTAX_MAX_LINES", 100000, 100, 1000000),
	max_section_bytes: int_env("TIG_SYNTAX_MAX_SECTION_BYTES", 1 << 20, 1 << 16, 1 << 26),
};
