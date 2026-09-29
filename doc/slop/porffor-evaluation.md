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
  supported"). Under `tools/tig-syntax-filter/src/`, the daemon imports:
  - `node:net` for the unix socket;
  - `node:child_process` for `git cat-file --batch-command` (or `--batch`
    before git 2.36), `git check-attr` and `git rev-parse --local-env-vars`;
  - `node:fs/promises`, `node:fs`, `node:util`, `node:crypto`, `node:path`,
    `node:url`, `node:timers/promises` and `node:stream` (types only).

  `@logtape/file` also pulls in `node:fs` and `node:events`. Porffor's
  only I/O is `console`, a fetch/HTTP-server runtime (uWebSockets) and
  inline C (`` Porffor.c`...` ``, which `--safe` rejects). Running the
  daemon would mean rewriting its I/O layer in porffor-specific inline C.
- **No `WebAssembly`.** The daemon deliberately runs shiki on the
  Oniguruma WASM engine for VS Code fidelity
  (`tools/tig-syntax-filter/src/highlight.ts`, `init_highlighter`). Under
  porffor, the only option is shiki's JS regex engine
  (`shiki/engine/javascript`), which translates each Oniguruma pattern into
  a JS `RegExp` via oniguruma-to-es. On the two files tested
  (`tools/tig-syntax-filter/src/highlight.ts` and `src/draw.c`), node gave
  byte-identical SGR output with either engine, so this cost looked
  tolerable. Two files are not proof, though.
- **Grammar loading.** The daemon uses the full `shiki` bundle with
  `langs: []` and loads grammars on demand with `loadLanguage`. The bundle
  reaches its 242 grammars through dynamic `import()`. Porffor would have to
  inline all of them, or the daemon would need a static grammar list.
  Neither was tried.

## What was tested

Everything below is about the part that could in principle work: shiki
core, vscode-textmate and the JS regex engine, with two grammars.

The probe approximates the daemon's tokenization core, minus I/O. It uses
`createHighlighterCoreSync` with the One Monokai theme (including the
`Comment` override), and statically imported `@shikijs/langs/typescript` and
`@shikijs/langs/c`. It runs `codeToTokensBase` in 128-line chunks that carry
`grammarState` across, as `CHUNK_LINES` does, then an SGR emission modeled
on `emit_sgr_lines`. Differences from the daemon: a sync core with static
grammars instead of async `createHighlighter` plus `loadLanguage`; no
`MAX_RUNS_PER_LINE` plain-text fallback; no CR handling (`cr_suffix`). The
sample sources are embedded as a JS module, because porffor has no fs. The
probe runs three ways and the outputs are byte-compared:

1. porffor native binary (JS engine)
2. node, JS engine
3. node, Oniguruma WASM engine (production)

Practical notes:

- Porffor's resolver doesn't follow pnpm's symlinked layout. A package's
  dependencies are looked up from the symlink's path, not its real path.
  Install into a scratch dir with `pnpm install --config.node-linker=hoisted`.
- `node ~/cloned/porffor/runtime/index.js native entry.mjs -o probe`
  compiled the stack with those two grammars in about 5–8 s (72 C units, a
  3.9 MB binary). The daemon's full grammar set would be much bigger.
- Porffor's stdout is fully buffered and lost on SIGSEGV. Run binaries under
  `stdbuf -o0` when bisecting a crash. `-d` keeps porffor's function names
  (it turns off LTO), which is enough for a `gdb` backtrace. There is no
  line info, and the C is still built at `-O3` unless you pass `-O0`.
  `porf c file.mjs -o file.c` shows the generated C.
- To isolate regex problems, dump every Oniguruma pattern the JS engine
  compiles in node (wrap `regexConstructor`), then have a porffor binary
  translate and compile each one. TypeScript plus C use 404 patterns.

## Porffor bugs found

All of these are confirmed on unmodified porffor. Bugs 1 and 2 were fixed
locally (see the appendix), which got every regex compiling. Bugs 5 and 6
are where we stopped.

### 1. Out-of-range string indexing reads past the string

```js
const [s, a] = "(";                    // a === "\u0000", should be undefined
console.log("("[1], "ab"[5]);          // "\u0000" "\u0000"
const f = (s, i) => s[i];
console.log(f("ab", -1));              // "a" (!), should be undefined
console.log("ab"[-1]);                 // SIGSEGV
```

`strGet` in `generateMember` (`compiler/codegen.js`) loads
`ptr + 4 + index × unit size` with no bounds check. Array destructuring
lowers to plain indexing, so `const [s, a] = token` hits it too. Typed-array
reads (`taGet`) look equally unchecked from the code, but that wasn't
tested.

Effect here: oniguruma-parser's tokenizer does `const [s, a] = t` and
branches on `a === "*"`. The out-of-bounds read picked up a stale `*` from
an earlier `(*` token, so a plain `(` went down the named-callout path and
threw `Incomplete or invalid named callout "("` on 4 patterns.

### 2. A regex's compiled bytecode is capped at 64 KB, and Unicode classes are inlined into it

Jump targets are u16 offsets (`if (bcTop > 0xFFF0) throw new SyntaxError('Regex too large')`
in `compiler/builtins/regexp.ts`). Class ops store their whole range table
inline (`[nR u16][32B bitmap][lo u32, hi u32]*nR`). oniguruma-to-es turns
`[:alpha:]` into `\p{Alpha}`, which has hundreds of ranges above U+00FF.

10 of the 404 patterns exceed the cap:

- 4 fail when constructed. Each has only 1.1–1.5 KB of Oniguruma source,
  with 10–12 `\p{Alpha}` classes in its translation.
- 6 have translations of 3000+ characters. shiki compiles those lazily
  (`lazyCompileLength: 3e3`, an `EmulatedRegExp` that calls `super("")`),
  so they would fail on first `exec` instead.

### 3. Integer subtraction in typed builtins saturates instead of going negative; regex segfaults

```js
"Ж1".match(/\p{Nd}/v);     // SIGSEGV
"ΔΣ 12".match(/[0-9٠-٩]/); // SIGSEGV
"ΣΣ".match(/[٠-٩]/);       // SIGSEGV
"—1".match(/\p{Nd}/v);     // fine: U+2014 is above \p{Nd}'s first wide range
"ab".match(/[٠-٩]+/);      // fine: Latin-1 input
```

It crashes whenever a UTF-16 input has a code unit above U+00FF but below
the class's lowest wide range. In the TypeScript and C grammars, about 20
of the 404 patterns use `\p{Nd}` outside an Alpha class, so any line with
Greek or Cyrillic text would crash tokenization.

Root cause: the wide-range binary search in `__Porffor_regex_attempt` does
`hi = mid - 1` on `i32` variables. That compiles to

```c
hi = porf_f64_to_i32((f64)((u32)mid - 1u));
```

The subtraction wraps in u32, and `porf_f64_to_i32` saturates, so
`0 - 1` gives `2147483647` instead of `-1`. The loop keeps going with a
huge `mid` and reads out of bounds. The same lowering presumably affects
any i32-typed builtin code that can go below zero.

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
private fields and overridden `exec`/`source`) for 25 of the 404 patterns.
7 of those are there because their translations are 3000+ characters and
shiki compiles them lazily (6 are the too-large ones from bug 2). The other
18 need emulation (hidden or transferred captures, search-start
strategies). shiki's scanner calls `.exec` on all of them.

### 6. `RegExp.prototype.source` returns corrupted strings

For 27 of 401 translated grammar patterns, `new RegExp(pattern, "dgv").source`
comes back with NULs between the characters and the wrong length. For
example, a 242-character pattern starting `^(///)\p{space}*` gives a
245-character source starting `^\0(\0\/\0\/\0\/\0)\0\\\0p\0{`. It looks like
UTF-16 data read as one byte per character. The pattern string itself is
intact. This isn't minimized: literals, `slice`d UTF-16 strings and
`join`ed strings all came out fine. Reproduce it by running oniguruma-to-es's
`toRegExpDetails` (target `ES2024`) over the grammar patterns and comparing
each `.source` with its input.

### Where the probe stopped

The first tokenization threw a value that turned out to be a corrupt
RegExp object. Porffor printed `Uncaught /`. In a `-d` build, a `catch`
calling `String(e)` ran out of memory inside `RegExp.prototype.toString`,
building a string from a garbage source length. Bugs 5 and 6 both fit;
which one caused it wasn't determined.

### Regex translations differ by target, but only slightly

With `target: "auto"`, oniguruma-to-es probes the runtime's RegExp
support. Node gets ES2025 output, which uses pattern modifiers `(?i:…)`,
and porffor's parser rejects those ("invalid group"). Under porffor the
probe picks a lower target by itself. In node, the ES2024 and ES2025
translations differ on only 4 of the 404 patterns. When compared under
porffor, 75 translations differed from node's, but those were artifacts of
bugs 5 and 6 (undefined `flags`, corrupted `source`). Once those are fixed,
pinning `target: "ES2024"` on both sides should make porffor's regexes
match node's.

## Where things are

- `~/cloned/porffor`, branch `local-probe-fixes`: fixes 1 and 2 as
  uncommitted working-tree changes, plus a regenerated
  `compiler/builtins_precompiled.js` (`node compiler/precompile.js`, needed
  after editing any `compiler/builtins/*.ts`). Both diffs are in the
  appendix, in case that checkout is lost.
- `/tmp/porf/hl`: the probe (`entry_js.mjs`, `entry_onig.mjs`, `core.mjs`,
  `gen.mjs`, `dump_patterns.mjs`, `check_patterns.mjs`). It lives in `/tmp`,
  so expect it to vanish; the design above is enough to rebuild it.
- `/tmp/porf/porffor-orig`: an unmodified porffor worktree, for checking
  whether a bug predates the local fixes.

Upstream reports: bugs 1, 3 and 5 have short repros above, and bug 2 has a
fix. Porffor's `AI_POLICY.md` requires disclosing all AI use and fully
understanding any change you submit. PR descriptions and comments must not
be LLM-generated (for issues, the same rule is "less strictly enforced").
So the fixes below, which are LLM-written, would need a human who
understands them to submit them and write the text.

## Worth rechecking when

Upstream fixes bugs 1, 2, 3, 5 and 6; each of them blocks tokenization on
its own. Even then, only the tokenizer would run, on the JS regex engine,
and with a static grammar list. The daemon itself would still need its I/O
rewritten.

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
The analysis passes (first-unit bitmap, minimum length, anchoring) walk the
AST, not the bytecode, so they needed no change. All 404 grammar patterns
compiled afterwards. A differential test of Unicode-class regexes against
node couldn't run to completion because of bug 3.

```diff
@@ bytecode ops comment @@
-//   0x05 class [nR u16][32B bitmap][lo u32, hi u32]*nR
+//   0x05 class [nR u16][32B bitmap][rangesAt u32]
 //        cp < 256: bitmap, else bsearch ranges (all >255), negation baked in
 //   0x06 any1                           - consume one unit/cp unconditionally
 //   0x07 runChar [backward u8][min u16][max u16][unit u16]
 //   0x08 runBitmap [backward u8][min u16][max u16][32B]
 //   0x09 runClass [backward u8][min u16][max u16][class payload]
+//   wide ranges ([lo u32, hi u32]*nR) live in a table after the code, at rangesAt,
+//   so big unicode classes don't count against the u16 jump range
@@ globals @@
 let __Porffor_regex_bufBc: any = 0;
+// [payload ranges field at, nR, lo, hi, ...] per class, appended after the code
+let __Porffor_regex_eWide: any = 0;
 let __Porffor_regex_capBc: i32 = 0;
@@ __Porffor_regex_eClassPayload @@
-// [nR u16][32B bitmap][lo u32, hi u32]*, wide ranges only
+// [nR u16][32B bitmap][rangesAt u32], wide ranges only, into the side table
 export const __Porffor_regex_eClassPayload = (start: i32, count: i32): void => {
   ...
   __Porffor_regex_bcTop += 32;
+  const wide: any[] = __Porffor_regex_eWide;
+  Porffor.array.fastPush(wide, __Porffor_regex_bcTop);
+  Porffor.array.fastPush(wide, nWide);
+  __Porffor_regex_e32(0);
   for (let i: i32 = start; i < start + count; i++) {
   ...
     if (hi > 255) {
       const wLo: i32 = lo > 256 ? lo : 256;
-      __Porffor_regex_e32(wLo);
-      __Porffor_regex_e32(hi);
+      Porffor.array.fastPush(wide, wLo);
+      Porffor.array.fastPush(wide, hi);
     }
@@ __Porffor_regex_attempt, class (0x05) @@
               // bsearch the wide ranges
               ok = false;
-              const ranges: i32 = code + pc + 35;
+              const ranges: i32 = code + Porffor.IR.loadI32(code + pc, 35);
   ...
-            pc += op == 0x05 ? 35 + Porffor.IR.loadU16(code + pc, 1) * 8 : 1;
+            pc += op == 0x05 ? 39 : 1;
@@ __Porffor_regex_attempt, runClass (0x09) @@
         const bitmap: i32 = code + pc + 8;
-        const ranges: i32 = code + pc + 40;
-        const afterPc: i32 = pc + (isClass ? 40 + rangeCount * 8 : 6);
+        const ranges: i32 = isClass ? code + Porffor.IR.loadI32(code + pc, 40) : 0;
+        const afterPc: i32 = pc + (isClass ? 44 : 6);
@@ __Porffor_regex_compileBlob @@
   __Porffor_regex_eFixups = Porffor.array.new(16);
+  __Porffor_regex_eWide = Porffor.array.new(16);
 
   __Porffor_regex_emitNode(root, 0);
   ...
   if (__Porffor_regex_bcTop > 0xFFF0) throw new SyntaxError('Regex too large');
 
+  // wide range tables after the code
+  const wide: any[] = __Porffor_regex_eWide;
+  for (let i: i32 = 0; i < wide.length;) {
+    const at: i32 = wide[i];
+    const n: i32 = wide[i + 1];
+    Porffor.IR.storeI32(Porffor.IR.ptr(__Porffor_regex_bufBc) + at, 0, __Porffor_regex_bcTop);
+    for (let j: i32 = 0; j < n * 2; j++) __Porffor_regex_e32(wide[i + 2 + j]);
+    i += 2 + n * 2;
+  }
+
   // analysis
```
