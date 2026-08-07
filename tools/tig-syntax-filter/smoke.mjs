import { createHighlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { readFileSync } from "node:fs";

const t0 = performance.now();
const theme = JSON.parse(readFileSync(process.env.HOME + "/cloned/vscode-one-monokai/themes/OneMonokai-color-theme.json", "utf8"));
theme.name = "one-monokai";
const hl = await createHighlighter({
	themes: [theme],
	langs: ["c", "typescript"],
	engine: createOnigurumaEngine(import("shiki/wasm")),
});
const t1 = performance.now();
const code = readFileSync("../../src/line.c", "utf8");
const tokens = hl.codeToTokensBase(code, { lang: "c", theme: "one-monokai" });
const t2 = performance.now();
const tokens2 = hl.codeToTokensBase(code, { lang: "c", theme: "one-monokai" });
const t3 = performance.now();
console.log(`startup: ${(t1 - t0).toFixed(0)}ms; tokenize ${code.split("\n").length} lines: ${(t2 - t1).toFixed(1)}ms; again: ${(t3 - t2).toFixed(1)}ms`);
const line = tokens[216];
for (const tok of line) {
	process.stdout.write(`\x1b[38;2;${parseInt(tok.color.slice(1, 3), 16)};${parseInt(tok.color.slice(3, 5), 16)};${parseInt(tok.color.slice(5, 7), 16)}m${tok.content}`);
}
console.log("\x1b[0m");
console.log(JSON.stringify(line.map(t => ({ c: t.content, color: t.color, f: t.fontStyle })), null, 0).slice(0, 400));
