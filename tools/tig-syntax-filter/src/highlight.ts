// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5

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
const EMIT_VERSION = 3;

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

/** identity|lang -> shallowest requested depth that exceeded the budget,
 * and when.  While fresh, requests at least that deep fail fast unless
 * the cache covers them; shallower ones still get an attempt.  Verdicts
 * expire after FAIL_TTL_MS: a failure may reflect transient contention
 * (the deadline is wall time, shared with concurrent sections), and even
 * a deterministic one should not leave a document raw forever. */
const budget_fail_cache = new Map<string, { depth: number, at: number }>();
const FAIL_CACHE_MAX = 512;
const FAIL_TTL_MS = 60 * 1000;

function fail_cache_put(key: string, last_line: number): void {
	const prev = budget_fail_cache.get(key);
	budget_fail_cache.delete(key);
	budget_fail_cache.set(key, {
		depth: prev === undefined ? last_line : Math.min(prev.depth, last_line),
		at: performance.now(),
	});
	while (budget_fail_cache.size > FAIL_CACHE_MAX) {
		const oldest = budget_fail_cache.keys().next().value as string;
		budget_fail_cache.delete(oldest);
	}
}

/** The depth at which `key` is known to exceed the budget, or undefined
 * when unknown or the verdict has expired. */
function fail_cache_depth(key: string): number | undefined {
	const entry = budget_fail_cache.get(key);
	if (entry === undefined) {
		return undefined;
	}
	if (performance.now() - entry.at > FAIL_TTL_MS) {
		budget_fail_cache.delete(key);
		return undefined;
	}
	return entry.depth;
}

/** The private SGR parameter marking a literal ESC byte of content. */
const LITERAL_ESC_MARKER = "\x1b[999m";

let highlighter: Highlighter | null = null;
let theme_name = "one-monokai";
let theme_fg = "#bbbbbb";
let theme_bg = "#282c34";

/** A cached tokenization prefix: SGR-annotated lines (without newlines)
 * and the grammar state after the last one, from which a deeper request
 * resumes.  Retries after a missed budget resume too, so a slow document
 * can highlight eventually. */
interface cached_prefix {
	lines: string[],
	state: unknown,
}

/** Byte-budgeted LRU: content identity -> cached prefix.  Sized by
 * approximate JS string memory (the grammar state, a small immutable
 * stack sharing structure with the grammar, is not counted). */
const line_cache = new ByteLRU<cached_prefix>(config.line_cache_mb * 1048576,
	(entry) => entry.lines.reduce((n, line) => n + line.length * 2 + 48, 64));

/** Running counters for diagnostics and tests. */
export const stats = {
	/** Source lines run through the grammar (cache hits excluded). */
	tokenized_lines: 0,
};

/** In-flight tokenizations by cache key.  Tokenization yields to the
 * event loop, so a concurrent request for the same document (e.g. a
 * prefetch racing the foreground view) can join a pass going at least as
 * deep. */
const tokenize_inflight = new Map<string, {
	last_line: number,
	promise: Promise<string[] | null>,
}>();

/**
 * Apply `TOKEN_COLOR_OVERRIDES` to a parsed VS Code theme, in place,
 * asserting that each names an existing rule with a foreground, so
 * re-importing a theme with renamed rules can't silently drop one.
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

const loaded_langs = new Set<string>();
const failed_langs = new Set<string>();
const loading_langs = new Map<string, Promise<boolean>>();

/** Whether `lang` has a grammar in shiki's bundle, loading it on demand.
 * Load failures are remembered (a grammarless language stays grammarless)
 * and concurrent loads of one language coalesce into a single attempt. */
export async function ensure_lang(lang: string): Promise<boolean> {
	A(highlighter !== null, "highlighter not initialized");
	if (loaded_langs.has(lang)) {
		return true;
	}
	if (failed_langs.has(lang)) {
		return false;
	}
	const loading = loading_langs.get(lang);
	if (loading !== undefined) {
		return loading;
	}
	const attempt = (async () => {
		try {
			await highlighter!.loadLanguage(lang as never);
			loaded_langs.add(lang);
			return true;
		} catch (err) {
			logger.warn("no grammar for {lang}: {err}", { lang, err: String(err) });
			failed_langs.add(lang);
			return false;
		} finally {
			loading_langs.delete(lang);
		}
	})();
	loading_langs.set(lang, attempt);
	return attempt;
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

/** Memo of (color, font style) -> SGR sequence, sparing the color parsing
 * per token; a theme has only a handful of distinct styles. */
const style_memo = new Map<string, string>();

/** The SGR prefix selecting a token's style; always resets first. */
function style_sequence(color: string | undefined, font_style: number | undefined): string {
	const memo_key = `${color ?? ""}|${font_style ?? 0}`;
	const memoized = style_memo.get(memo_key);
	if (memoized !== undefined) {
		return memoized;
	}
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
	const sequence = `\x1b[${params}m`;
	style_memo.set(memo_key, sequence);
	A(style_memo.size < 100000, "style memo unbounded");
	return sequence;
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

/** The carriage returns ending `line`: a CRLF terminator's, or several
 * where line endings were converted twice. */
function cr_suffix(line: string): string {
	return line.endsWith("\r") ? /\r+$/.exec(line)![0] : "";
}

/**
 * Tokenize `content` (a complete source document) as `lang` and return one
 * SGR-annotated string per source line, through `last_line` (1-based) or
 * beyond when cached; later lines can't change earlier tokens, so they
 * are not tokenized.  Removing the SGR and unframing literal-ESC markers
 * yields the source lines exactly.  Lines are cached under `identity` +
 * lang + emit version.
 *
 * Like an editor, the grammar never sees a CRLF line's carriage return;
 * it follows the line's final reset, unstyled.
 *
 * Tokenization runs in CHUNK_LINES batches, continued via shiki's
 * GrammarState (token-identical to one-shot tokenization), yielding to
 * the event loop between batches so other connections and timers get to
 * run.  Before each batch it checks `deadline` (a performance.now()
 * timestamp, or null) and `cancelled`; if either trips, the lines so far
 * are cached with their grammar state for later requests to resume from,
 * and null is returned.  A missed deadline also records the requested
 * depth for fail-fast; a cancellation doesn't, as abandoned work says
 * nothing about cost.  The deadline is wall time, so under contention
 * sections give up a little earlier.
 *
 * Also returns null when the request is deeper than the configured line
 * cap or a line exceeds MAX_LINE_CHARS.
 */
export async function highlight_lines(identity: string, lang: string, content: string,
					last_line: number, deadline: number | null,
					cancelled?: () => boolean): Promise<string[] | null> {
	A(highlighter !== null, "highlighter not initialized");
	const key = `${identity}|${lang}|v${EMIT_VERSION}`;
	const cached = line_cache.get(key);
	if (cached !== undefined && cached.lines.length >= last_line) {
		return cached.lines;
	}

	const fail_key = `${identity}|${lang}`;
	const failed_at = fail_cache_depth(fail_key);
	if (failed_at !== undefined && last_line >= failed_at) {
		return null;
	}

	const inflight = tokenize_inflight.get(key);
	if (inflight !== undefined && inflight.last_line >= last_line) {
		// Someone else is already tokenizing this document at least as
		// deep: join their result instead of redoing the work.
		const theirs = await inflight.promise;
		if (theirs !== null && theirs.length >= last_line) {
			return theirs;
		}
		// They aborted or fell short; their partial or failure depth may
		// still answer for us.
		const after = line_cache.get(key);
		if (after !== undefined && after.lines.length >= last_line) {
			return after.lines;
		}
		const failed_after = fail_cache_depth(fail_key);
		if (failed_after !== undefined && last_line >= failed_after) {
			return null;
		}
	}

	const hl = highlighter;
	const work = async (): Promise<string[] | null> => {
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
	// A shorter cached prefix is a head start: its lines are reused as
	// they are and tokenization resumes from its grammar state.
	const resume = line_cache.get(key);
	const prefix = resume === undefined ? [] : resume.lines;
	A(prefix.length < last_line, "cached prefix already covers the request");
	A(resume === undefined || resume.state !== undefined, "cached prefix lacks its grammar state");
	const token_lines: ThemedToken[][] = [];
	// The union-typed method needs a cast to its element overload.
	const get_state = hl.getLastGrammarState as (tokens: ThemedToken[][]) => unknown;
	let state: unknown = resume === undefined ? undefined : resume.state;
	// Store-time length comparisons re-read the cache: after yields, a
	// concurrent call for the same identity may have cached a longer
	// prefix than the snapshot taken at entry, and it must survive.
	const keep_if_longer = (lines: string[]): void => {
		const current = line_cache.get(key);
		if (current === undefined || lines.length > current.lines.length) {
			line_cache.set(key, { lines, state });
		}
	};
	const emit = (): string[] => emit_sgr_lines(token_lines).map((line, i) =>
		line + cr_suffix(slice[prefix.length + i]));
	const keep_partial = (): void => {
		if (token_lines.length > 0) {
			keep_if_longer(prefix.concat(emit()));
		}
	};
	for (let start = prefix.length; start < needed; start += CHUNK_LINES) {
		if (start > prefix.length) {
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
		const chunk_lines = slice.slice(start, start + CHUNK_LINES);
		const chunk = chunk_lines.map((line) => line.slice(0, line.length - cr_suffix(line).length));
		const chunk_tokens = hl.codeToTokensBase(chunk.join("\n"), {
			lang: lang as never,
			theme: theme_name as never,
			grammarState: state as never,
		});
		A(chunk_tokens.length === chunk_lines.length, "tokenizer split a chunk into a different number of lines");
		state = get_state(chunk_tokens);
		token_lines.push(...chunk_tokens);
		stats.tokenized_lines += chunk_tokens.length;
	}
	const elapsed = performance.now() - started;
	if (elapsed > 200) {
		logger.info("tokenized lines {from}-{to} of {lang} in {ms}ms", {
			from: prefix.length + 1, to: needed, lang, ms: Math.round(elapsed),
		});
	}

	const result = prefix.concat(emit());
	keep_if_longer(result);
	return result;
	};

	const entry = { last_line, promise: work() };
	tokenize_inflight.set(key, entry);
	try {
		return await entry.promise;
	} finally {
		if (tokenize_inflight.get(key) === entry) {
			tokenize_inflight.delete(key);
		}
	}
}
