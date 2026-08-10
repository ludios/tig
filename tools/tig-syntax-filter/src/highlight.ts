// Model-output: Claude Fable 5

/**
 * Tokenization and SGR emission.  Wraps shiki (vscode-textmate +
 * vscode-oniguruma, the engine lineage VS Code uses) with One Monokai and
 * turns source documents into per-line SGR-annotated strings, cached by
 * content identity.  Only foreground colors and bold/italic/underline are
 * emitted; backgrounds belong to tig's own diff row styling.
 */

import { setImmediate } from "node:timers/promises";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";
import { config } from "./config.ts";
import { ByteLRU } from "./lru.ts";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["tig-syntax", "highlight"]);

/**
 * Bump when the emission format or an emitted color changes, to invalidate
 * cache keys.
 */
const EMIT_VERSION = 2;

/**
 * Foreground overrides for the vendored theme, keyed by the name of the
 * `tokenColors` rule they patch.  The vendored JSON stays a verbatim copy of
 * upstream so it can be re-imported wholesale; terminal-readability
 * deviations live here, where they are visible and reviewable.
 *
 * Comment: upstream's #676f7d is a dim gray-blue tuned for the theme's own
 * editor background.  tig draws code over its diff row tints instead, which
 * sit lighter than that background, so comments lose too much contrast; this
 * lifts them ~25% while keeping the hue.
 */
const TOKEN_COLOR_OVERRIDES: Record<string, string> = {
	Comment: "#828c9c",
};

export const MAX_LINE_CHARS = 20000;
export const MAX_RUNS_PER_LINE = 4000;

/** Lines tokenized between deadline checks; ~10-60 ms of work per chunk at
 * measured grammar rates, so a section overshoots its budget by at most
 * roughly that. */
const CHUNK_LINES = 128;

/** identity|lang -> shallowest requested depth whose tokenization has
 * exceeded the budget.  Requests at least that deep fail fast; shallower
 * hunks in the same document still get a fresh attempt (the budget verdict
 * depends on the requested prefix, so the key alone must not damn the
 * whole document). */
const budget_fail_cache = new Map<string, number>();
const FAIL_CACHE_MAX = 512;

function fail_cache_put(key: string, last_line: number): void {
	const prev = budget_fail_cache.get(key);
	budget_fail_cache.delete(key);
	budget_fail_cache.set(key, prev === undefined ? last_line : Math.min(prev, last_line));
	while (budget_fail_cache.size > FAIL_CACHE_MAX) {
		const oldest = budget_fail_cache.keys().next().value as string;
		budget_fail_cache.delete(oldest);
	}
}

/** The private SGR parameter marking a literal ESC byte of content. */
const LITERAL_ESC_MARKER = "\x1b[999m";

let highlighter: Highlighter | null = null;
let theme_name = "one-monokai";
let theme_fg = "#bbbbbb";
let theme_bg = "#282c34";

/** Byte-budgeted LRU: content identity -> SGR-ready lines (no trailing
 * newline).  Sized by approximate JS string memory. */
const line_cache = new ByteLRU<string[]>(config.line_cache_mb * 1048576,
	(lines) => lines.reduce((n, line) => n + line.length * 2 + 48, 64));

/**
 * Apply `TOKEN_COLOR_OVERRIDES` to a parsed VS Code theme, in place.  Every
 * override must name a rule the theme actually defines: a silently-dropped
 * override would otherwise be the outcome of re-importing a theme whose rules
 * were renamed.
 */
function apply_token_color_overrides(theme: { tokenColors?: unknown }): void {
	const rules = theme.tokenColors;
	A(Array.isArray(rules), "theme has no tokenColors array");
	for (const [name, foreground] of Object.entries(TOKEN_COLOR_OVERRIDES)) {
		const rule = rules.find((candidate) => candidate?.name === name);
		A(rule !== undefined, `theme has no tokenColors rule named ${name}`);
		A(typeof rule.settings?.foreground === "string",
		  `tokenColors rule ${name} sets no foreground to override`);
		rule.settings.foreground = foreground;
	}
}

/**
 * Initialize the shiki highlighter with the One Monokai theme and an
 * explicitly-instantiated Oniguruma WASM engine (shiki also offers a
 * JavaScript regex engine, which would break engine-lineage fidelity).
 */
export async function init_highlighter(): Promise<void> {
	A(highlighter === null, "init_highlighter called twice");
	const theme_path = join(dirname(fileURLToPath(import.meta.url)), "..", "themes", "one-monokai.json");
	const theme = JSON.parse(await readFile(theme_path, "utf8"));
	theme.name = theme_name;
	apply_token_color_overrides(theme);
	highlighter = await createHighlighter({
		themes: [theme],
		langs: [],
		engine: createOnigurumaEngine(import("shiki/wasm")),
	});
	const loaded = highlighter.getTheme(theme_name);
	theme_fg = loaded.fg || theme_fg;
	theme_bg = loaded.bg || theme_bg;
	logger.info("highlighter ready: theme fg={fg} bg={bg}", { fg: theme_fg, bg: theme_bg });
}

/** Whether `lang` has a grammar in shiki's bundle, loading it on demand. */
export async function ensure_lang(lang: string): Promise<boolean> {
	A(highlighter !== null, "highlighter not initialized");
	if (highlighter.getLoadedLanguages().includes(lang)) {
		return true;
	}
	try {
		await highlighter.loadLanguage(lang as never);
		return true;
	} catch (err) {
		logger.warn("no grammar for {lang}: {err}", { lang, err: String(err) });
		return false;
	}
}

/**
 * Parse "#rrggbb" or "#rrggbbaa" into [r, g, b], compositing an alpha
 * component over the theme's editor background (terminals cannot blend).
 */
function color_to_rgb(color: string): [number, number, number] {
	let hex = color.replace("#", "");
	let alpha = 1.0;
	if (hex.length === 8) {
		alpha = parseInt(hex.slice(6, 8), 16) / 255;
		hex = hex.slice(0, 6);
	}
	if (hex.length === 3) {
		hex = hex.replace(/./g, "$&$&");
	}
	let r = parseInt(hex.slice(0, 2), 16);
	let g = parseInt(hex.slice(2, 4), 16);
	let b = parseInt(hex.slice(4, 6), 16);
	if (alpha < 1.0) {
		const bg_hex = theme_bg.replace("#", "");
		const br = parseInt(bg_hex.slice(0, 2), 16);
		const bg_ = parseInt(bg_hex.slice(2, 4), 16);
		const bb = parseInt(bg_hex.slice(4, 6), 16);
		r = Math.round(alpha * r + (1 - alpha) * br);
		g = Math.round(alpha * g + (1 - alpha) * bg_);
		b = Math.round(alpha * b + (1 - alpha) * bb);
	}
	return [r, g, b];
}

/** Replace literal ESC bytes in content with the reversible wire marker. */
export function frame_content(text: string): string {
	if (!text.includes("\x1b")) {
		return text;
	}
	return text.replaceAll("\x1b", LITERAL_ESC_MARKER);
}

/** The SGR prefix selecting a token's style; always resets first. */
function style_sequence(color: string | undefined, font_style: number | undefined): string {
	const [r, g, b] = color_to_rgb(color ?? theme_fg);
	let params = `0;38;2;${r};${g};${b}`;
	const style = font_style ?? 0;
	if (style > 0) {
		if (style & 2) {
			params += ";1";
		}
		if (style & 1) {
			params += ";3";
		}
		if (style & 4) {
			params += ";4";
		}
	}
	return `\x1b[${params}m`;
}

/**
 * A stable, repository-independent identity for source content.  Git
 * objects are content-addressed, so a FULL object id (as echoed by
 * cat-file — never the diff's abbreviated form, which is unique only
 * within one repository) identifies content globally; worktree bytes are
 * identified by their own hash.  Cross-worktree and cross-clone cache
 * hits fall out for free.
 */
export function content_identity(oid_or_content: string | Buffer): string {
	if (typeof oid_or_content === "string") {
		return `oid:${oid_or_content}`;
	}
	const hash = createHash("sha256").update(oid_or_content).digest("hex");
	return `sha256:${hash}`;
}

/** Render token lines into SGR-annotated strings (exported for tests). */
export function emit_sgr_lines(token_lines: ThemedToken[][]): string[] {
	const result: string[] = [];
	for (const tokens of token_lines) {
		let out = "";
		let last_style = "";
		let runs = 0;
		for (const token of tokens) {
			const seq = style_sequence(token.color, token.fontStyle);
			if (seq !== last_style) {
				out += seq;
				last_style = seq;
				runs++;
			}
			out += frame_content(token.content);
		}
		out += "\x1b[0m";
		// tig stores at most 8192 cells per line; emit pathological
		// lines unstyled rather than have tig truncate the text.
		if (runs > MAX_RUNS_PER_LINE) {
			out = frame_content(tokens.map((token) => token.content).join(""));
		}
		result.push(out);
	}
	return result;
}

/**
 * Tokenize `content` (a complete source document) as `lang` and return one
 * SGR-annotated string per source line, up to `last_line` (1-based; grammar
 * state only depends on preceding lines, so later lines need no work).
 * Lines are cached under `identity` + lang + emit version.
 *
 * Tokenization runs in CHUNK_LINES batches continued via shiki's
 * GrammarState (verified token-identical to one-shot tokenization), with
 * the event loop yielded between batches (a macrotask: other connections'
 * requests, socket events, and timers interleave mid-section instead of
 * waiting out the whole budget).  `deadline` (a performance.now()
 * timestamp, or null for none) is checked between batches; it is wall
 * time, so under contention concurrent sections abort a little earlier —
 * the latency-focused reading of the budget.  On exceeding it the lines
 * tokenized so far are still cached — a valid prefix that serves
 * shallower hunks — the failure depth is remembered for fail-fast, and
 * null is returned so the section goes raw.  `cancelled` (e.g. "did the
 * client hang up") also stops between batches, keeping the partial but
 * NOT recording a failure depth: abandoned work says nothing about cost.
 * Also returns null when the request is deeper than the configured line
 * cap or a line exceeds MAX_LINE_CHARS.
 */
export async function highlight_lines(identity: string, lang: string, content: string,
					last_line: number, deadline: number | null,
					cancelled?: () => boolean): Promise<string[] | null> {
	A(highlighter !== null, "highlighter not initialized");
	const key = `${identity}|${lang}|v${EMIT_VERSION}`;
	const cached = line_cache.get(key);
	if (cached !== undefined && cached.length >= last_line) {
		return cached;
	}

	const fail_key = `${identity}|${lang}`;
	const failed_at = budget_fail_cache.get(fail_key);
	if (failed_at !== undefined && last_line >= failed_at) {
		return null;
	}

	const all_lines = content.split("\n");
	const needed = Math.min(last_line, all_lines.length);
	if (needed > config.max_lines) {
		return null;
	}
	const slice = all_lines.slice(0, needed);
	for (const line of slice) {
		if (line.length > MAX_LINE_CHARS) {
			return null;
		}
	}

	const started = performance.now();
	const token_lines: ThemedToken[][] = [];
	// The union-typed method needs a cast to its element overload.
	const get_state = highlighter.getLastGrammarState as (tokens: ThemedToken[][]) => unknown;
	let state: unknown;
	// Store-time length comparisons re-read the cache: after yields, a
	// concurrent call for the same identity may have cached a longer
	// prefix than the snapshot taken at entry, and it must survive.
	const keep_if_longer = (lines: string[]): void => {
		const current = line_cache.get(key);
		if (current === undefined || lines.length > current.length) {
			line_cache.set(key, lines);
		}
	};
	const keep_partial = (): void => {
		if (token_lines.length > 0) {
			keep_if_longer(emit_sgr_lines(token_lines));
		}
	};
	for (let start = 0; start < needed; start += CHUNK_LINES) {
		if (start > 0) {
			await setImmediate();
		}
		if (cancelled !== undefined && cancelled()) {
			keep_partial();
			return null;
		}
		if (deadline !== null && performance.now() > deadline) {
			const elapsed_ms = Math.round(performance.now() - started);
			logger.info("budget exhausted tokenizing {lang} at line {done}/{needed} after {ms}ms", {
				lang, done: token_lines.length, needed, ms: elapsed_ms,
			});
			// Keep whichever cached prefix is longer: a deep retry
			// that dies early must not shrink an existing entry.
			keep_partial();
			fail_cache_put(fail_key, last_line);
			return null;
		}
		const chunk = slice.slice(start, start + CHUNK_LINES).join("\n");
		const chunk_tokens = highlighter.codeToTokensBase(chunk, {
			lang: lang as never,
			theme: theme_name as never,
			grammarState: state as never,
		});
		state = get_state(chunk_tokens);
		token_lines.push(...chunk_tokens);
	}
	const elapsed = performance.now() - started;
	if (elapsed > 200) {
		logger.info("tokenized {lines} lines of {lang} in {ms}ms", {
			lines: needed, lang, ms: Math.round(elapsed),
		});
	}

	const result = emit_sgr_lines(token_lines);
	keep_if_longer(result);
	return result;
}
