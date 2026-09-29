# Can porffor AOT-compile the syntax-highlighting daemon?

Model-output: Claude Opus 5.5

Status: 2026-09-29. We stopped here because
[porffor](https://github.com/CanadaHonk/porffor) isn't ready for this code.
The daemon can't be compiled at all. The part that does compile (shiki,
vscode-textmate and the pure-JS regex engine) crashes on its first
tokenization, even for `int x = 1;` as C.

Versions tested: porffor `main` at 752b421 (2026-09-28), node v26.10.0,
shiki 4.4.2, oniguruma-to-es 4.3.6, gcc 15.3.

## Blocked by design, not by bugs

These would stay even if porffor had no bugs:

- **No Node APIs.** Porffor's module loader rejects every `node:`
  specifier (`compiler/modules.js:92`: "node builtin modules are not
  supported"). The daemon uses `node:net` for the unix socket,
  `node:child_process` for `git cat-file --batch` and `check-attr`,
  `node:fs/promises`, `node:crypto`, `node:path`, `node:url` and
  `node:timers/promises`. Porffor's only I/O is `console`, a
  fetch/HTTP-server runtime (uWebSockets) and inline C
  (`` Porffor.c`...` ``, which `--safe` rejects). Running the daemon would
  mean rewriting its I/O layer in porffor-specific inline C.
- **No `WebAssembly`.** The daemon deliberately runs shiki on the
  Oniguruma WASM engine for VS Code fidelity (`src/highlight.ts`,
  `init_highlighter`). Under porffor, the only option is shiki's JS regex
  engine (`shiki/engine/javascript`), which translates each Oniguruma
  pattern into a JS `RegExp` via oniguruma-to-es. On the two files tested
  (`tools/tig-syntax-filter/src/highlight.ts` and `src/draw.c`), node gave
  byte-identical SGR output with either engine, so this cost looked
  tolerable. Two files are not proof, though.

## What was tested

Everything below is about the part that could in principle work: shiki
core, vscode-textmate and the JS regex engine.

The probe mirrors the daemon's tokenization core, minus I/O:
`createHighlighterCoreSync` with the One Monokai theme (including the
`Comment` override), statically imported `@shikijs/langs/typescript` and
`@shikijs/langs/c`, and `codeToTokensBase` in 128-line chunks that carry
`grammarState` across (as `CHUNK_LINES` does). The tokens then go through
the same SGR emission as `emit_sgr_lines`. The sample sources are embedded
as a JS module, because porffor has no fs. The probe runs three ways and
the outputs are byte-compared:

1. porffor native binary (JS engine)
2. node, JS engine
3. node, Oniguruma WASM engine (production)

Practical notes:

- Porffor's resolver doesn't follow pnpm's symlinked layout. A package's
  dependencies are looked up from the symlink's path, not its real path.
  Install into a scratch dir with `pnpm install --config.node-linker=hoisted`.
- `node ~/cloned/porffor/runtime/index.js native entry.mjs -o probe`
  compiled the whole shiki stack in about 5–8 s (72 C units, a 3.9 MB
  binary). Hello world takes about 8 s the first time and 230 KB.
- Porffor's stdout is fully buffered and lost on SIGSEGV. Run binaries under
  `stdbuf -o0` when bisecting a crash. `-d` gives a debug build with symbols
  for `gdb`.
- To isolate regex problems, dump every Oniguruma pattern the JS engine
  compiles in node (wrap `regexConstructor`), then have a porffor binary
  translate and compile each one. TypeScript plus C use 404 patterns; 25 of
  their translations are `EmulatedRegExp` instances.

## Porffor bugs found

All of these reproduce with tiny programs. Bugs 1 and 2 were fixed locally
(see the appendix), which got every regex compiling. Bug 5 is where we
stopped.

### 1. Out-of-range string indexing reads past the string

```js
const [s, a] = "(";                    // a === "\u0000", should be undefined
console.log("("[1], "ab"[5]);          // "\u0000" "\u0000"
const f = (s, i) => s[i];
console.log(f("ab", -1));              // "a" (!), should be undefined
console.log("ab"[-1]);                 // SIGSEGV
```

`strGet` in `generateMember` (`compiler/codegen.js`) loads
`ptr + 4 + index` with no bounds check. Array destructuring lowers to plain
indexing, so `const [s, a] = token` hits it too. Typed-array reads
(`taGet`) look equally unchecked from the code, but that wasn't tested.

Effect here: oniguruma-parser's tokenizer does `const [s, a] = t` and
branches on `a === "*"`. The out-of-bounds read picked up a stale `*` from
an earlier `(*` token, so a plain `(` went down the named-callout path and
threw `Incomplete or invalid named callout "("` on 4 patterns.

### 2. A regex's compiled bytecode is capped at 64 KB, and Unicode classes are inlined into it

Jump targets are u16 offsets (`if (bcTop > 0xFFF0) throw new SyntaxError('Regex too large')`
in `compiler/builtins/regexp.ts`). Class ops store their whole range table
inline (`[nR u16][32B bitmap][lo u32, hi u32]*nR`). oniguruma-to-es turns
`[:alpha:]` into `\p{Alpha}`, which has hundreds of ranges above U+00FF.
As a result, TypeScript grammar patterns of only 1.1–1.5 KB of Oniguruma
source, each with around 18 such classes, fail to compile: 4 of the 404
patterns as porffor translates them, and 10 of node's (longer) translations.

### 3. Segfault on a class with only non-Latin-1 ranges over a UTF-16 input

```js
"ΣΣ".match(/[٠-٩]/);    // SIGSEGV in __Porffor_regex_attempt
"aΣ".match(/[٠-٩]+/);   // SIGSEGV
"ab".match(/[٠-٩]+/);   // fine (Latin-1 input)
"ΣΣ".match(/[a-zĀ]+/);  // fine (class has a range <= 255)
```

This happens in unmodified porffor too. The cause wasn't found. The
emitter and the first-unit prefilter looked fine on a read-through. It
was found by delta-debugging `"abc_1 déf ΔΣω 12 x3 42x".matchAll(/(?<=[\p{Alpha}])\p{Nd}{2,3}/gv)`.

### 4. `\p{Script=…}` is unsupported

`/[\p{Script=Greek}]/u` throws `Regex parse: unsupported property name`.
The TypeScript and C grammars didn't need it, but other grammars might.

### 5. `class extends RegExp` is broken

```js
class R extends RegExp {
	#p;
	get source() { return this.#p; }
	constructor(p, f) { super(p, f); this.#p = p; }
	exec(s) { return RegExp.prototype.exec.call(this, s); }
}
const r = new R("a+", "dg");
r instanceof RegExp;      // false (node: true)
r.flags, r.global;        // undefined, undefined (node: "dg", true)
r.lastIndex = 1;
r.exec("baab");           // null (node: match "aa" at 1, indices [[1,3]])
```

oniguruma-to-es returns an `EmulatedRegExp` (a `RegExp` subclass with
private fields and overridden `exec`/`source`) whenever a pattern needs
emulation, e.g. hidden or transferred captures and search-start strategies.
shiki's scanner calls `.exec` on it. In the probe, the first tokenization
threw a value that turned out to be a corrupt RegExp object: porffor
printed `Uncaught /`, and in a `-d` build, `String(e)` ran out of memory
inside `RegExp.prototype.toString` (building a string from a garbage
source length).

### Not a bug: regex translations differ by target

With `target: "auto"`, oniguruma-to-es probes the runtime's RegExp
support. Node gets ES2025 output, which uses pattern modifiers
`(?i:…)`, and porffor's parser rejects those ("invalid group"). Under
porffor the probe picks a lower target by itself, so 75 of the 404
translated sources differ from node's. So even a working porffor build
would run a different set of JS regexes than node's JS engine. Before
trusting its output, pin `target` to the same value on both sides, or diff
the tokens as the probe does.

## Timings (node only)

The porffor binary never got far enough to time. Cold single runs in node
(including JIT and engine warm-up) took 216 ms for `highlight.ts` and 149 ms
for `draw.c` with the JS engine, and 179 ms and 91 ms with Oniguruma.

## Where things are

- `~/cloned/porffor`, branch `local-probe-fixes`: fixes 1 and 2 as
  uncommitted working-tree changes, plus a regenerated
  `compiler/builtins_precompiled.js` (`node compiler/precompile.js`, needed
  after editing any `compiler/builtins/*.ts`).
- `/tmp/porf/hl`: the probe (`entry_js.mjs`, `entry_onig.mjs`, `core.mjs`,
  `gen.mjs`, `dump_patterns.mjs`, `check_patterns.mjs`). It lives in `/tmp`,
  so expect it to vanish; the design above is enough to rebuild it.
- `/tmp/porf/porffor-orig`: an unmodified porffor worktree, for checking
  whether a bug predates the local fixes.

Porffor's `AI_POLICY.md` requires disclosing AI use and says PR and issue
text must not be LLM-written. Any upstream report of bugs 1, 3 or 5 has to
be written by a human. The snippets above are the repros.

## Worth rechecking when

Porffor fixes RegExp subclassing (bug 5) and out-of-bounds indexing
(bug 1). Even then, only the tokenizer would run, on the JS regex engine.
The daemon itself would still need its I/O rewritten.

## Appendix: the local porffor fixes

Fix 1, bounds-checked string indexing in `generateMember`
(`compiler/codegen.js`):

```diff
+  // out-of-range or non-integer indices read undefined, not memory past the string
   const strGet = (ctype, size, strType) => () => {
-    const out = reuse(scope, Alloc(Const(T.i32, 8), strType));
-    stmt(scope, Store('u32', out, 0, Const(T.u32, 1)));
-    const src = Bin('+', T.u32, Bin('+', T.u32, JvPtr(obj), Const(T.u32, 4)),
-      size === 1 ? Convert(T.u32, numValue(prop), 0) : Bin('*', T.u32, Convert(T.u32, numValue(prop), 0), Const(T.u32, size)));
-    stmt(scope, Store(ctype, out, 4, Load(ctype, src, 0)));
-    return valOf(out, strType);
+    const num = reuse(scope, numValue(prop));
+    const idx = reuse(scope, Convert(T.u32, num, 0));
+    const res = tmp(scope, T.jsval);
+    emitIf(scope, Bin('&&', T.i32,
+        Bin('==', T.i32, num, Convert(T.f64, idx, 0)),
+        Bin('<', T.i32, idx, Convert(T.u32, LenGet(JvPtr(obj)), 0))),
+      () => {
+        const out = reuse(scope, Alloc(Const(T.i32, 8), strType));
+        stmt(scope, Store('u32', out, 0, Const(T.u32, 1)));
+        const src = Bin('+', T.u32, Bin('+', T.u32, JvPtr(obj), Const(T.u32, 4)),
+          size === 1 ? idx : Bin('*', T.u32, idx, Const(T.u32, size)));
+        stmt(scope, Store(ctype, out, 4, Load(ctype, src, 0)));
+        assign(scope, res, valOf(out, strType));
+      },
+      () => assign(scope, res, valUndefined()));
+    return res;
   };
```

Fix 2 (`compiler/builtins/regexp.ts`) keeps each class op's 32-byte bitmap
inline but replaces its wide-range list with a u32 offset (`rangesAt`)
into a table appended after the code, once the u16 jump fixups are applied.
Jumps then only span the code, whatever the size of the Unicode classes.
The changes:

- `__Porffor_regex_eClassPayload` records `[field offset, nWide, lo, hi, …]`
  in a new `__Porffor_regex_eWide` array and emits a zero u32 placeholder
  instead of the ranges.
- `__Porffor_regex_compileBlob` initializes that array. After the
  `Regex too large` check (which now covers only the code), it appends
  each range table and patches its placeholder with the table's offset.
- The executor reads `ranges` as `code + loadI32(code + pc, 35)` for
  `class` (op now 39 bytes) and `code + loadI32(code + pc, 40)` for
  `runClass` (op now 44 bytes).

The analysis passes (first-unit bitmap, minimum length, anchoring) walk
the AST, not the bytecode, so they needed no change. A differential test of
Unicode-class regexes against node couldn't run to completion because of
bug 3, but all 404 grammar patterns compiled afterwards.
