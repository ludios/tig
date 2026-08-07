// Model-output: Claude Fable 5

/**
 * Tokenization and SGR emission.  Wraps shiki (vscode-textmate +
 * vscode-oniguruma, the engine lineage VS Code uses) with One Monokai and
 * turns source documents into per-line SGR-annotated strings, cached by
 * content identity.  Only foreground colors and bold/italic/underline are
 * emitted; backgrounds belong to tig's own diff row styling.
 */

import { createHighlighter, type Highlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { A } from "ayy";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["tig-syntax", "highlight"]);

/** Bump when the emission format changes, to invalidate cache keys. */
const EMIT_VERSION = 1;

export const MAX_LINE_CHARS = 20000;
export const MAX_DOC_LINES = 100000;
export const MAX_RUNS_PER_LINE = 4000;

const CACHE_MAX_ENTRIES = 256;

/** The private SGR parameter marking a literal ESC byte of content. */
const LITERAL_ESC_MARKER = "\x1b[999m";

let highlighter: Highlighter | null = null;
let theme_name = "one-monokai";
let theme_fg = "#bbbbbb";
let theme_bg = "#282c34";

/** LRU cache: content identity -> SGR-ready lines (no trailing newline). */
const line_cache = new Map<string, string[]>();

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

function cache_get(key: string): string[] | undefined {
	const hit = line_cache.get(key);
	if (hit !== undefined) {
		line_cache.delete(key);
		line_cache.set(key, hit);
	}
	return hit;
}

function cache_put(key: string, value: string[]): void {
	line_cache.set(key, value);
	while (line_cache.size > CACHE_MAX_ENTRIES) {
		const oldest = line_cache.keys().next().value as string;
		line_cache.delete(oldest);
	}
}

/** A stable identity for source content within a repository. */
export function content_identity(repo: string, oid_or_content: string | Buffer): string {
	if (typeof oid_or_content === "string") {
		return `${repo}|oid:${oid_or_content}`;
	}
	const hash = createHash("sha256").update(oid_or_content).digest("hex");
	return `${repo}|sha256:${hash}`;
}

/**
 * Tokenize `content` (a complete source document) as `lang` and return one
 * SGR-annotated string per source line, up to `last_line` (1-based; grammar
 * state only depends on preceding lines, so later lines need no work).
 * Lines are cached under `identity` + lang + emit version.  Returns null
 * when the document exceeds size limits or contains an overlong line, in
 * which case the caller renders the section unhighlighted.
 */
export async function highlight_lines(identity: string, lang: string, content: string,
					last_line: number): Promise<string[] | null> {
	A(highlighter !== null, "highlighter not initialized");
	const key = `${identity}|${lang}|v${EMIT_VERSION}`;
	const cached = cache_get(key);
	if (cached !== undefined && cached.length >= last_line) {
		return cached;
	}

	const all_lines = content.split("\n");
	if (all_lines.length > MAX_DOC_LINES) {
		return null;
	}
	const needed = Math.min(last_line, all_lines.length);
	const slice = all_lines.slice(0, needed);
	for (const line of slice) {
		if (line.length > MAX_LINE_CHARS) {
			return null;
		}
	}

	const started = performance.now();
	const token_lines = highlighter.codeToTokensBase(slice.join("\n"), {
		lang: lang as never,
		theme: theme_name as never,
	});
	const elapsed = performance.now() - started;
	if (elapsed > 200) {
		logger.info("tokenized {lines} lines of {lang} in {ms}ms", {
			lines: needed, lang, ms: Math.round(elapsed),
		});
	}

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
	cache_put(key, result);
	return result;
}
