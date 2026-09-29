// Model-output: Claude Opus 5.5
// BM12: the daemon's tokenize-and-emit path (highlight.ts, unmodified) in a
// fresh process, timed per phase so node/V8 flags can be compared on cold
// start, first use, and steady state.
//
// Usage: node [flags] tokenize-bench.ts <corpus.txt> <passes>
// Prints one JSON object: ms since process start at script entry, import
// and init times, the first pass (grammar loads + cold JIT), the median and
// minimum of the remaining passes, lines per pass, and peak RSS.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const entry_ms = performance.now();

type corpus_file = { lang: string, path: string, content: string };

/**
 * Read the corpus manifest.
 * @param manifest path to lines of `<lang> <path>`, relative paths taken
 *   from the manifest's directory and `~` from $HOME; `#` starts a comment.
 * @returns every listed file with its contents.
 */
function read_corpus(manifest: string): corpus_file[] {
	const base = dirname(resolve(manifest));
	const files: corpus_file[] = [];
	for (const raw of readFileSync(manifest, "utf8").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const fields = line.split(/\s+/);
		if (fields.length !== 2) {
			throw new Error(`${manifest}: want "<lang> <path>", got ${JSON.stringify(line)}`);
		}
		const [lang, spec] = fields;
		const path = spec.startsWith("~/") ? resolve(homedir(), spec.slice(2)) : resolve(base, spec);
		files.push({ lang, path, content: readFileSync(path, "utf8") });
	}
	return files;
}

function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main(): Promise<void> {
	const [manifest, passes_arg] = process.argv.slice(2);
	const passes = parseInt(passes_arg, 10);
	if (manifest === undefined || !(passes >= 2)) {
		throw new Error("usage: tokenize-bench.ts <corpus.txt> <passes >= 2>");
	}
	const corpus = read_corpus(manifest);
	const here = dirname(fileURLToPath(import.meta.url));
	const highlight_ts = resolve(here, "../../../../tools/tig-syntax-filter/src/highlight.ts");

	const t_import = performance.now();
	const hl = await import(highlight_ts);
	const t_init = performance.now();
	await hl.init_highlighter();
	const t_ready = performance.now();

	let lines = 0;
	const pass_ms: number[] = [];
	for (let pass = 0; pass < passes; pass++) {
		const started = performance.now();
		let pass_lines = 0;
		for (const file of corpus) {
			if (!await hl.ensure_lang(file.lang)) {
				throw new Error(`no grammar for ${file.lang}`);
			}
			// A fresh identity per pass defeats the line cache, as a new
			// blob would.
			const out = await hl.highlight_lines(`bm12:${pass}:${file.path}`, file.lang,
				file.content, Number.MAX_SAFE_INTEGER, null);
			if (out === null) {
				throw new Error(`highlight_lines gave up on ${file.path}`);
			}
			pass_lines += out.length;
		}
		pass_ms.push(performance.now() - started);
		lines = pass_lines;
	}
	const rest = pass_ms.slice(1);
	console.log(JSON.stringify({
		entry_ms:     +entry_ms.toFixed(1),
		import_ms:    +(t_init - t_import).toFixed(1),
		init_ms:      +(t_ready - t_init).toFixed(1),
		first_ms:     +pass_ms[0].toFixed(1),
		steady_ms:    +median(rest).toFixed(1),
		steady_min_ms: +Math.min(...rest).toFixed(1),
		lines,
		max_rss_mb:   Math.round(process.resourceUsage().maxRSS / 1024),
	}));
}

await main();
