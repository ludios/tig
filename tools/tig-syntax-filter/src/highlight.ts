/**
 * Tokenization and SGR emission.  Wraps shiki's grammars (vscode-textmate
 * + vscode-oniguruma, the engine lineage VS Code uses) with One Monokai.
 * Per source document, keyed by content identity, it caches the grammar
 * state at the start of each line, which is all that later lines depend
 * on, and renders only the lines a diff shows as SGR-annotated strings.
 * Only foreground colors and bold/italic/underline are emitted;
 * backgrounds belong to tig's own diff row styling.
 */

import { setImmediate } from "node:timers/promises";
import { createHighlighter, type Highlighter } from "shiki";
import { INITIAL, EncodedTokenMetadata, type StateStack } from "shiki/textmate";
import { config } from "./config.ts";
import { ByteLRU } from "./lru.ts";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["tig-syntax", "highlight"]);

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

/** Grammar runs (lines) between deadline checks and event-loop yields;
 * ~10-60 ms of work at measured grammar rates, so a section overshoots
 * its budget by at most roughly that. */
export const CHUNK_LINES = 128;

/** Time limit for tokenizing one line, as in VS Code and shiki; a line
 * that hits it keeps the tokens found so far. */
const LINE_TIME_LIMIT_MS = 500;

/** Approximate memory per cached line-start state: the array slot plus,
 * amortized, the state objects that lines open (measured ~70-85 bytes
 * per line on 170k- and 330k-line bundled JavaScript files). */
const STATE_BYTES_PER_LINE = 80;

/** The private SGR parameter marking a literal ESC byte of content. */
const LITERAL_ESC_MARKER = "\x1b[999m";

type Grammar = ReturnType<Highlighter["getLanguage"]>;

let highlighter: Highlighter | null = null;
let theme_name = "one-monokai";
let theme_fg = "#bbbbbb";
let theme_bg = "#282c34";

/** What the cache keeps for one document under one grammar. */
interface doc_entry {
	/** Line-start states: element i is the grammar state at the start of
	 * line i + 1 (element 0 is INITIAL), so length n means lines 1..n-1
	 * have run through the grammar and any of lines 1..n can be rendered
	 * by tokenizing just that line.  States are immutable and share
	 * structure, so arrays can share elements.  Arrays are never mutated;
	 * a longer one replaces a shorter one. */
	states: readonly StateStack[],
	/** Line -> its SGR-annotated text, for every line rendered so far;
	 * only ever grows. */
	rendered: Map<number, string>,
	/** Approximate memory of `rendered`. */
	rendered_bytes: number,
}

/** Byte-budgeted LRU: cache_key() -> doc_entry. */
const doc_cache = new ByteLRU<doc_entry>(config.line_cache_mb * 1048576,
	(entry) => entry.states.length * STATE_BYTES_PER_LINE + entry.rendered_bytes);

/** Running counters for diagnostics and tests. */
export const stats = {
	/** Lines run through the grammar to extend a document's cached
	 * states. */
	tokenized_lines: 0,
	/** Lines run through the grammar again, from a cached start state,
	 * only to render them (cached renderings excluded). */
	retokenized_lines: 0,
	/** Times a pass started over because its grammar was rebuilt. */
	grammar_restarts: 0,
};

/** In-flight passes by cache key, with the deepest line each needs.
 * Passes yield to the event loop, so a concurrent request for the same
 * document (e.g. a prefetch racing the foreground view) can wait for a
 * pass going at least as deep and then render from its cached states. */
const passes_inflight = new Map<string, {
	depth: number,
	promise: Promise<unknown>,
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
 * The engine gets the WASM file's bytes: shiki's "shiki/wasm" module
 * instead decodes a base64 copy of it and gunzips that on every start.
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
		engine: createOnigurumaEngine(readFile(fileURLToPath(import.meta.resolve("shiki/onig.wasm")))),
	});
	const loaded = highlighter.getTheme(theme_name);
	// render_line() maps colors straight from the color map.
	A.eq(Object.keys(loaded.colorReplacements ?? {}).length, 0, "theme has colorReplacements");
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
			await highlighter.loadLanguage(lang as never);
			loaded_langs.add(lang);
			return true;
		} catch (err) {
			logger.warn("no grammar for {lang}: {err}", () => ({ lang, err: String(err) }));
			failed_langs.add(lang);
			return false;
		} finally {
			loading_langs.delete(lang);
		}
	})();
	loading_langs.set(lang, attempt);
	return attempt;
}

/** Numbers for the grammar objects that cache keys have named, held
 * weakly so that a disposed grammar is not kept alive. */
const grammar_ids = new WeakMap<object, number>();
let grammars_numbered = 0;

/**
 * The state cache key for `identity` as `lang`, under the grammar that
 * `hl` tokenizes `lang` with now.  Loading another language can make
 * shiki replace that grammar with a rebuilt one (loading python rebuilds
 * markdown, which embeds python lazily), whose rules are numbered
 * differently and may color differently, so the key names the grammar:
 * entries made under the old grammar, whose states must not resume under
 * the new one, are never looked up again and age out of the cache.
 */
function cache_key(hl: Highlighter, identity: string, lang: string): string {
	const grammar = hl.getLanguage(lang);
	let id = grammar_ids.get(grammar);
	if (id === undefined) {
		id = ++grammars_numbered;
		grammar_ids.set(grammar, id);
	}
	return `${identity}|${lang}|g${id}`;
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

/** A span of one line's text in one style, as shiki's ThemedToken has it. */
export interface styled_piece {
	content: string,
	/** Foreground "#rrggbb[aa]"; undefined means the theme's. */
	color?: string | undefined,
	/** shiki FontStyle bits: 1 italic, 2 bold, 4 underline. */
	fontStyle?: number | undefined,
}

/** One line's pieces as an SGR-annotated string, ending in a reset. */
export function emit_sgr_line(pieces: readonly styled_piece[]): string {
	let out = "";
	let last_style = "";
	let runs = 0;
	for (const piece of pieces) {
		const seq = style_sequence(piece.color, piece.fontStyle);
		if (seq !== last_style) {
			out += seq;
			last_style = seq;
			runs++;
		}
		out += frame_content(piece.content);
	}
	out += "\x1b[0m";
	// tig stores at most 8192 cells per line; emit pathological lines
	// unstyled rather than have tig truncate the text.
	if (runs > MAX_RUNS_PER_LINE) {
		out = frame_content(pieces.map((piece) => piece.content).join(""));
	}
	return out;
}

/** The carriage returns ending `line`: a CRLF terminator's, or several
 * where line endings were converted twice. */
function cr_suffix(line: string): string {
	return line.endsWith("\r") ? /\r+$/.exec(line)![0] : "";
}

/** `line` as the grammar sees it: like an editor, without its line
 * terminator's carriage returns. */
function grammar_text(line: string): string {
	return line.slice(0, line.length - cr_suffix(line).length);
}

/**
 * Run `text` (one line, without terminator) through `grammar` from the
 * line-start state `start`.  Returns the binary tokens (null for an empty
 * line, which shiki never runs through the grammar) and the state at the
 * start of the next line.  As in VS Code, a line that hits the time limit
 * leaves the state as it was, and an end state equal to `start` is
 * returned as `start` itself, so unchanged states share one object.
 */
function tokenize_line(grammar: Grammar, text: string,
		       start: StateStack): { tokens: Uint32Array | null, end: StateStack } {
	if (text === "") {
		return { tokens: null, end: start };
	}
	const result = grammar.tokenizeLine2(text, start, LINE_TIME_LIMIT_MS);
	if (result.stoppedEarly || start.equals(result.ruleStack)) {
		return { tokens: result.tokens, end: start };
	}
	return { tokens: result.tokens, end: result.ruleStack };
}

/**
 * Render one line from tokenize_line()'s `tokens` for `text`, decoding
 * each token's colors as shiki does: `color_map` is the theme's, indexed
 * by the token's foreground id.
 */
function render_line(text: string, tokens: Uint32Array | null, color_map: readonly string[]): string {
	const pieces: styled_piece[] = [];
	const count = tokens === null ? 0 : tokens.length / 2;
	for (let i = 0; i < count; i++) {
		const start = tokens![2 * i]!;
		const next = i + 1 < count ? tokens![2 * i + 2]! : text.length;
		if (start === next) {
			continue;
		}
		const metadata = tokens![2 * i + 1]!;
		pieces.push({
			content: text.substring(start, next),
			color: color_map[EncodedTokenMetadata.getForeground(metadata)],
			fontStyle: EncodedTokenMetadata.getFontStyle(metadata),
		});
	}
	return emit_sgr_line(pieces);
}

/**
 * One request's walk over a source document.  It extends the document's
 * cached line-start states through the deepest wanted line, rendering the
 * wanted lines that it tokenizes on the way, then renders the other
 * wanted lines from their cached start states.  Work runs in chunks of
 * CHUNK_LINES grammar runs with event-loop yields between them; if shiki
 * rebuilds the grammar during a yield (another request loaded a
 * language), the pass begins again under the new grammar.
 */
class HighlightPass {
	private readonly hl: Highlighter;
	private readonly identity: string;
	private readonly lang: string;
	private readonly lines: readonly string[];
	/** Wanted line numbers (1-based), ascending, without duplicates. */
	private readonly wanted: readonly number[];
	private readonly wanted_set: ReadonlySet<number>;
	/** The deepest wanted line. */
	private readonly depth: number;

	/** Set by begin(), from the grammar shiki has now. */
	private key!: string;
	private grammar!: Grammar;
	private color_map!: readonly string[];
	/** The cached states when the pass (re)began; never mutated. */
	private known!: readonly StateStack[];
	/** States this pass computed after `known`'s last. */
	private computed: StateStack[] = [];
	/** Wanted line -> its SGR-annotated text, plus the line's own
	 * carriage returns after the final reset. */
	private sgr = new Map<number, string>();
	/** Grammar runs since the pass (re)began, to space out the chunk
	 * checks. */
	private runs = 0;

	constructor(hl: Highlighter, identity: string, lang: string, lines: readonly string[], wanted: readonly number[]) {
		A.gt(wanted.length, 0, "a pass needs a wanted line");
		this.hl = hl;
		this.identity = identity;
		this.lang = lang;
		this.lines = lines;
		this.wanted = wanted;
		this.wanted_set = new Set(wanted);
		this.depth = wanted.at(-1)!;
		this.begin();
	}

	/** Start (over) under the grammar shiki has now, from its cached
	 * states and renderings; nothing done under an earlier grammar is
	 * reused. */
	private begin(): void {
		this.key = cache_key(this.hl, this.identity, this.lang);
		this.grammar = this.hl.getLanguage(this.lang);
		this.color_map = this.hl.getInternalContext().setTheme(theme_name).colorMap;
		const entry = doc_cache.get(this.key);
		this.known = entry?.states ?? [INITIAL];
		this.computed = [];
		this.sgr = new Map();
		for (const line of this.wanted) {
			const text = entry?.rendered.get(line);
			if (text !== undefined) {
				this.sgr.set(line, text);
			}
		}
		this.runs = 0;
	}

	/** How many lines have a known start state (lines 1..this many). */
	private state_count(): number {
		return this.known.length + this.computed.length;
	}

	/** The grammar state at the start of `line` (1-based). */
	private start_state(line: number): StateStack {
		A.lte(line, this.state_count(), "line-start state not known yet");
		const i = line - 1;
		return i < this.known.length ? this.known[i]! : this.computed[i - this.known.length]!;
	}

	/** Run `line` (1-based) through the grammar from its start state. */
	private tokenize(line: number): { tokens: Uint32Array | null, end: StateStack } {
		return tokenize_line(this.grammar, grammar_text(this.lines[line - 1]!), this.start_state(line));
	}

	/** Render `line` (1-based) from tokenize()'s `tokens` for it. */
	private render(line: number, tokens: Uint32Array | null): void {
		const text = this.lines[line - 1]!;
		this.sgr.set(line, render_line(grammar_text(text), tokens, this.color_map) + cr_suffix(text));
	}

	/** Cache the states known now, unless the cache already has more (a
	 * concurrent pass may have gone deeper meanwhile), and the lines
	 * rendered so far. */
	private store(): void {
		if (this.computed.length === 0 && this.sgr.size === 0) {
			return;
		}
		A.eq(this.key, cache_key(this.hl, this.identity, this.lang),
		     "the grammar was rebuilt after these states were computed");
		const current = doc_cache.get(this.key);
		const entry = current ?? { states: this.known, rendered: new Map(), rendered_bytes: 0 };
		if (this.state_count() > entry.states.length) {
			entry.states = this.known.concat(this.computed);
		}
		for (const [line, text] of this.sgr) {
			if (!entry.rendered.has(line)) {
				entry.rendered.set(line, text);
				entry.rendered_bytes += text.length * 2 + 48;
			}
		}
		doc_cache.set(this.key, entry);
	}

	/**
	 * Account for the grammar run about to happen.  Every CHUNK_LINES
	 * runs, starting with the first: unless it is the first, yield to the
	 * event loop and begin again if the grammar was rebuilt meanwhile;
	 * then stop on cancellation or a passed deadline, caching the states
	 * known so far.
	 *
	 * @returns "go" to make the run, "restart" after beginning again,
	 *          "stop" to give up.
	 */
	private async step(deadline: number | null, cancelled?: () => boolean): Promise<"go" | "restart" | "stop"> {
		const run = this.runs++;
		if (run % CHUNK_LINES !== 0) {
			return "go";
		}
		if (run > 0) {
			await setImmediate();
			if (cache_key(this.hl, this.identity, this.lang) !== this.key) {
				logger.info("{lang}'s grammar was rebuilt after {done} of {depth} lines had states; starting over", () => ({
					lang: this.lang, done: this.state_count() - 1, depth: this.depth,
				}));
				stats.grammar_restarts++;
				this.begin();
				return "restart";
			}
		}
		if (cancelled !== undefined && cancelled()) {
			this.store();
			return "stop";
		}
		if (deadline !== null && performance.now() > deadline) {
			logger.info("deadline hit tokenizing {lang} with states through line {done} of {depth}; caching them", () => ({
				lang: this.lang, done: this.state_count() - 1, depth: this.depth,
			}));
			this.store();
			return "stop";
		}
		return "go";
	}

	/**
	 * Do the pass.
	 *
	 * @param deadline   performance.now() time after which to give up, or
	 *                   null for none.
	 * @param cancelled  Polled between chunks; true means give up.
	 * @returns          Wanted line -> its SGR-annotated text, or null
	 *                   after giving up.
	 */
	async run(deadline: number | null, cancelled?: () => boolean): Promise<Map<number, string> | null> {
		const started = performance.now();
		const tokenized_before = stats.tokenized_lines;
		const retokenized_before = stats.retokenized_lines;
		pass: while (true) {
			while (this.state_count() <= this.depth) {
				const next = await this.step(deadline, cancelled);
				if (next === "stop") {
					return null;
				}
				if (next === "restart") {
					continue pass;
				}
				const line = this.state_count();
				const { tokens, end } = this.tokenize(line);
				this.computed.push(end);
				stats.tokenized_lines++;
				if (this.wanted_set.has(line) && !this.sgr.has(line)) {
					this.render(line, tokens);
				}
			}
			for (const line of this.wanted) {
				if (this.sgr.has(line)) {
					continue;
				}
				const next = await this.step(deadline, cancelled);
				if (next === "stop") {
					return null;
				}
				if (next === "restart") {
					continue pass;
				}
				this.render(line, this.tokenize(line).tokens);
				stats.retokenized_lines++;
			}
			break;
		}
		this.store();
		const elapsed = performance.now() - started;
		if (elapsed > 200) {
			logger.info("{lang} through line {depth}: tokenized {tokenized} lines, re-tokenized {retokenized} to render them, in {ms}ms", () => ({
				lang: this.lang, depth: this.depth,
				tokenized: stats.tokenized_lines - tokenized_before,
				retokenized: stats.retokenized_lines - retokenized_before,
				ms: Math.round(elapsed),
			}));
		}
		return this.sgr;
	}
}

/**
 * Render lines of a source document as SGR-annotated text: removing the
 * SGR and unframing literal-ESC markers yields each line exactly.  The
 * grammar never sees a line's terminating carriage returns; they follow
 * its final reset, unstyled.
 *
 * Between calls, the grammar states at line starts and the rendered
 * lines are kept in memory under `identity`, `lang` and the grammar (see
 * cache_key()), with no other version: other code, theme or dependencies
 * make a different daemon (the client's build id covers them).  So lines
 * past the deepest wanted one are never tokenized, a deeper request
 * resumes from the cached states, and rendering a line whose start state
 * is cached runs only that line through the grammar.
 *
 * @param identity   The document's content identity.
 * @param lang       A loaded language (see ensure_lang()).
 * @param lines      The document's lines, without newlines.
 * @param wanted     Line numbers (1-based) to render, in any order;
 *                   duplicates are fine and lines past the end are
 *                   ignored.
 * @param deadline   performance.now() time after which to give up, or
 *                   null for none.  It is wall time, so under contention
 *                   sections give up a little earlier.
 * @param cancelled  Polled between chunks; true means give up.
 * @returns          Wanted line -> its SGR-annotated text, or null after
 *                   giving up, when a wanted line is deeper than the
 *                   configured line cap, or when a line through the
 *                   deepest wanted one exceeds MAX_LINE_CHARS.  Giving up
 *                   still caches the states computed so far, for the
 *                   next request to resume from.
 */
export async function highlight_lines(identity: string, lang: string, lines: readonly string[],
				      wanted: Iterable<number>, deadline: number | null,
				      cancelled?: () => boolean): Promise<Map<number, string> | null> {
	A(highlighter !== null, "highlighter not initialized");
	const hl = highlighter;
	const rows = [...new Set(wanted)].filter((line) => line <= lines.length).toSorted((a, b) => a - b);
	if (rows.length === 0) {
		return new Map();
	}
	A.gte(rows[0]!, 1, "line numbers are 1-based");
	const depth = rows.at(-1)!;
	if (depth > config.max_lines) {
		return null;
	}
	for (let i = 0; i < depth; i++) {
		if (lines[i]!.length > MAX_LINE_CHARS) {
			return null;
		}
	}

	const key = cache_key(hl, identity, lang);
	const inflight = passes_inflight.get(key);
	if (inflight !== undefined && inflight.depth >= depth) {
		// Another pass is already computing these states: let it, then
		// render from what it cached.
		await inflight.promise;
	}
	const entry = { depth, promise: new HighlightPass(hl, identity, lang, lines, rows).run(deadline, cancelled) };
	passes_inflight.set(key, entry);
	try {
		return await entry.promise;
	} finally {
		if (passes_inflight.get(key) === entry) {
			passes_inflight.delete(key);
		}
	}
}
