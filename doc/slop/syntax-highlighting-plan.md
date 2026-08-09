# Syntax highlighting for tig diff views — finalized implementation plan

Status: finalized plan, ready to implement. Supersedes `raw-proposals/1.md` and
`raw-proposals/2.md`; revised after two rounds of external review (2026-08) — all
findings verified against this tree and incorporated below. All file:line
references were re-verified against this tree (2.6.1-dev fork).

## Goals

1. **Correct syntax highlighting** in diff views, matching VS Code's **TextMate
   lexical highlighting** (semantic/LSP tokens excluded) for **pinned grammar and
   theme versions** — same engine lineage, same theme JSON (e.g. One Monokai).
2. **Added/removed lines shown with red/green *background* tint**, with token
   foreground colors preserved — not today's red/green foreground text. (This is
   deliberate tig styling, not a claim of VS Code diff-color fidelity — see Step 4.)
3. **Truecolor (24-bit) support in tig** — exact theme RGB, not xterm-256 quantization.
4. **Fast commit-to-commit navigation** — scrolling through commits in the main view
   with the diff pane updating must stay snappy; revisiting a commit should be instant.

Non-goals for v1: semantic (LSP) tokens, combined merge diffs, blame/blob/tree views,
Windows, word-diff + syntax at the same time, **`wrap-lines` + syntax at the same
time** (see Step 4), **intraline diff highlighting + syntax at the same time** (the
`diff-highlight` 7/27 protocol is absent in syntax mode and the filter has no notion
of changed spans; supporting both later needs another marker in the wire protocol),
token background colors from the theme (One Monokai has 2 such rules; we emit
foregrounds + attrs only).

## Decisions (resolving the raw proposals' open questions)

| Question | Decision |
|---|---|
| Architecture | **Proposal 2's**: external SGR-injecting filter + a general SGR decoder in tig. Not proposal 1's custom binary protocol / layered-style-resolver rewrite — tig's existing filter hook and cell model make that unnecessary. |
| Wire format | SGR, plus a **tiny reversible framing rule** so literal ESC bytes in file content survive losslessly (see "Wire protocol" below). Raw SGR alone is not lossless. |
| Engine | **shiki** (vscode-textmate + vscode-oniguruma — the same engine VS Code uses), run as a persistent daemon behind a thin pipe client. Loads VS Code theme JSON as-is. Grammar versions **pinned**: shiki redistributes grammars rather than defining them, so parity means pinning the same grammar definitions/injections as the VS Code snapshot we compare against (`~/cloned/vscode`, `extensions/*/syntaxes/`). |
| Node/Bun dependency | Acceptable. Target platform is Linux/NixOS; package the daemon with an explicit Node/Bun store path. Windows out of scope. |
| Tokenization state | **Full-source tokenization** (fetch pre/post-image content, thread grammar state from line 1) — always correct, cacheable. Only tokenize **up to the last line the diff needs**, not the whole file (vscode-textmate's `tokenizeLine` takes prior state + a time budget, so state can be cached incrementally). Hunk-local state only in the throwaway PoC. |
| Truecolor | **Core requirement, done early** (Step 2), so all later steps render exact RGB. 256-color quantization is the automatic fallback; palette reprogramming is explicit opt-in, never part of `auto`. |
| Diff line coloring | Token fg from theme + line bg tint from tig's own `diff-add`/`diff-del` colors, expressed through existing tigrc `color` commands once they accept RGB values. |
| RGB spelling in tigrc | **`rgb:RRGGBB`**, not `#rrggbb`: tigrc's option reader truncates every line at the first `#` *before* argument/quote parsing (`read_option`, `src/options.c:1079-1087`), so `#`-prefixed colors cannot survive the existing grammar. `rgb:` needs only a `set_color` change, no lexer surgery. |

### Why the daemon is TypeScript (not C or Rust)

The language is dictated by the fidelity goal, not preference. "Matches VS Code" means
running VS Code's actual tokenizer: `vscode-textmate` (the grammar interpreter) and
`vscode-oniguruma` (the Oniguruma regex engine compiled to WASM), both JavaScript/npm
packages — shiki is a thin wrapper around exactly these. Every non-JS route gives up
something essential:

- **Rust**: the mature option is syntect (what bat/delta use), but it interprets
  *Sublime* syntax definitions, not VS Code's grammar files, and needs themes converted
  out of VS Code JSON — token boundaries and colors drift from what VS Code shows.
  There is no maintained Rust port of vscode-textmate.
- **C**: would mean hand-porting the TextMate grammar engine + embedding Oniguruma and
  a JSON grammar loader — months of work to reimplement, then permanently chase, a
  well-maintained upstream. Rejected on maintenance cost.
- **Embedding a JS runtime in a C/Rust daemon** (quickjs/deno_core) just re-creates
  Node with extra steps, and quickjs can't run the WASM Oniguruma build well.

The performance-sensitive parts are already native: Oniguruma runs as WASM, and the
daemon amortizes Node startup + grammar compilation across its lifetime. TypeScript is
only orchestration glue (~a few hundred lines). tig itself gains no runtime dependency —
it only ever sees an external filter command, and the protocol boundary means the daemon
could later be swapped for a native syntect-based one at reduced fidelity if the Node
dependency ever becomes a problem.

## Architecture

```
git show --no-color ──► tig-syntax-filter (thin client) ──► tig
                              │ unix socket                   │ general SGR decoder
                              ▼                               ▼
                        highlight daemon                box cells (fg,attr) × base-bg
                        shiki + One Monokai JSON        → ephemeral style table
                        git -C <repo> cat-file          → ncurses extended pairs
                        cache keyed by repo+blob OID       (truecolor) or 256 fallback
```

Two independently testable components:

- **Filter + daemon** (TypeScript, no tig changes): reads a unified diff on stdin,
  writes the same diff with SGR sequences injected *inside* line bodies. Column 0 and
  all diff structure stay byte-identical — tig classifies lines by literal prefix on
  raw bytes (`include/tig/line.h:24-42`, via `get_line_type` at `src/line.c:29-48`),
  so the filter is an injector, never a reformatter (this is why delta can't be
  dropped in).
- **tig patch** (C): truecolor plumbing + a real SGR decoder generalizing the
  existing two-code scanner.

### Wire protocol: SGR + lossless ESC framing

Raw SGR alone cannot represent file content that itself contains ESC bytes: tig
routes any highlighted line containing ESC into the escape parser
(`src/diff.c:386-387`) and strips escape bytes from stored text, so a literal
`ESC [ 3 1 m` inside a source file would be indistinguishable from filter-injected
markup — silently corrupting the stored text and breaking search. The fix is a
minimal framing rule, not a binary protocol:

- The filter replaces each **literal ESC byte in content** with a reserved private
  sequence (exact byte form chosen in Step 1 — e.g. a private-parameter SGR like
  `ESC[<n>m` that no real tokenizer output uses).
- tig's decoder converts that sequence back to a literal ESC byte in stored text;
  every other `ESC[…m` is control and is stripped.
- The byte-identity CI invariant becomes: *strip injected SGR, apply the unescape
  rule, and the result is byte-identical to the input diff*.

Content that is invalid UTF-8 is passed through unhighlighted per file (pushing
arbitrary Git bytes through JS strings would otherwise break byte preservation).

## What tig already has (verified)

- **Per-token colored line segments**: `struct box` / `box_cell`
  (`include/tig/view.h:28-37`), drawn cell-by-cell in `src/draw.c:588-607`. Cell
  budget 8192/line (`src/diff.c:89`). Arbitrary per-token coloring is already the
  rendering model.
- **External filter hook**: `diff_init_highlight` swaps `view->io` for a filter pipe
  over the whole `git show --no-color` stream (`src/diff.c:46-72`); input is
  guaranteed colorless (`src/diff.c:32`). The stage view rides the same path
  (`src/stage.c:782,818`), so staged/unstaged diffs get highlighting for free.
  Caveat: when the configured filter binary is missing, today's behavior is an
  **empty diff view**, not passthrough (regression test
  `test/diff/diff-highlight-test:86` expects a blank screen) — Step 3 must add real
  fallback, not "mirror" this.
- **ANSI-to-cells parsing skeleton**: `diff_common_highlight` (`src/diff.c:288-303`)
  recognizes exactly `\x1b[7m`/`\x1b[27m`; its `skip` mechanism strips escape bytes
  from stored text (`src/diff.c:101-102`) so search/regex/export see clean text.
  Note these two codes are not "reverse video": they are the protocol by which git's
  diff-highlight selects tig's *configurable* `LINE_DIFF_{ADD,DEL}_HIGHLIGHT` line
  types. The general decoder must preserve those semantics in legacy mode.
- **Dynamic line rules + deduplicated color pairs**: `init_line_info`/`add_line_rule`
  grow the rule table at runtime (`src/line.c:102-180`); pairs are deduplicated by
  (fg,bg) and allocated on demand (`src/line.c:197-218`). Colors re-init on `:set`
  (`src/prompt.c:1121`) — dynamic paths must be idempotent. Caveat: this registry is
  global config-visible state — `get_line_type` scans it (`src/line.c:35-45`) and
  `:save-options` serializes every rule (`src/options.c:1418`), so syntax styles
  must NOT be ordinary line rules (see Step 3).
- **Wrapping bypass**: highlighted lines return through `diff_common_highlight` and
  never reach `pager_common_read`/`pager_wrap_line` (`src/diff.c:386-389`,
  `src/pager.c:110-118`) — so escape-carrying lines do not wrap at all today. With a
  syntax filter, nearly every code line carries escapes; style-aware wrapping would
  mean splitting styled cells at display-width boundaries (tabs, wide chars). v1
  excludes it (see Step 4).
- **The gaps**: colors are `color0..color255` ints (`src/options.c:384-394`); pair
  setup is classic `init_pair`/`COLOR_PAIR` (`src/line.c:217`,
  `include/tig/line.h:143-157`, `src/draw.c:42-53`) — no truecolor (open upstream
  request jonas/tig#227). Selected rows suppress per-cell styling (`src/draw.c:45`)
  and search overwrites attrs via `mvwchgat` (`src/draw.c:650`) — both acceptable
  v1 behaviors to keep.

---

## Step 1 — Filter proof-of-concept (no tig changes)

Build `tools/tig-syntax-filter/` (TypeScript, single package):

- shiki with One Monokai theme JSON, grammar set pinned by version; the Oniguruma
  WASM engine instantiated **explicitly** (shiki supports multiple regex engines;
  the JS engine would break the "VS Code engine lineage" fidelity contract).
- **Per-side language detection**: old path + old content → old grammar; new path
  + new content → new grammar (a rename can change extension). Deleted files have
  no new side, new files no old side; shebang sniffing uses the corresponding
  side's content. Removed lines use the old grammar, added lines the new grammar,
  context lines advance both.
- **Diff parsing must handle real Git output**, not just `+++ b/<path>`: quoted
  pathnames, `--no-prefix` / custom prefixes, `/dev/null`, rename/copy headers,
  all-zero and arbitrary-width object IDs in `index` lines.
- v0 tokenization: hunk-local, two parallel grammar-state chains per file — and
  **context lines advance both chains** (they exist in both documents), with
  new-side colors chosen for display. Since inter-hunk lines are unavailable,
  **reset both states at each hunk**, not per file (carrying state across a gap
  would be wrong; the full-source design in Step 5 removes this limitation).
- Emit fg-color SGR only (`38;2;r;g;b`), plus bold/italic/underline; never emit
  bg codes or touch column 0 / hunk headers / file headers. Implement the ESC
  framing rule (see "Wire protocol"); pass invalid-UTF-8 files through untouched.
- Flush output per file (tig streams the filter's stdout through its async io layer;
  a fully buffering filter would stall first paint).

Also assemble a **golden corpus**: real commits from this and other repos covering C,
TS/JS, Rust, Python, Nix, Elixir, Markdown, HTML+embedded CSS/JS, multiline
comments/strings starting before a hunk, UTF-8/emoji, quoted/renamed paths, a file
containing literal ESC bytes, invalid UTF-8, very long lines.

**Exit criteria**
- `git show --no-color <rev> | tig-syntax-filter | less -R` looks right in a
  truecolor terminal; colors visually match a VS Code window with One Monokai
  (TextMate layer; spot-check tokens against `~/cloned/vscode`'s inspector).
- Losslessness: strip injected SGR + apply the ESC unescape rule ⇒ byte-identical
  to input, verified across the corpus including the literal-ESC file.
- Warm per-file latency measured and recorded (target: <50 ms for typical files).

## Step 2 — Truecolor support in tig core

Independent, upstreamable on its own (closes jonas/tig#227). No syntax code yet.

- Accept `rgb:RRGGBB` in `set_color` (`src/options.c:384`); represent as packed RGB
  in the existing `int fg, bg` of `struct line_info` (`include/tig/line.h:115-120`)
  with a flag bit distinguishing RGB from indexed. (`#rrggbb` is impossible without
  changing tigrc's comment grammar — `read_option` truncates at the first `#`
  before any argument parsing, `src/options.c:1079-1087` — so we don't.)
- Rendering tiers, resolved at pair-init time in `init_line_info_color_pair`
  (`src/line.c:197-218`):
  1. **Direct color** (in `auto`): terminal exposes direct RGB → `init_extended_pair`
     with packed RGB. Detection: prefer ncurses' reported `COLORS >= 0x1000000`
     together with the `RGB` terminfo capability, but do not assume a universal
     channel bit layout — follow ncurses' documented interpretation of `RGB`.
  2. **Palette reprogramming** (explicit opt-in, NOT in `auto`): `can_change_color()`
     → `init_color` on palette slots. `init_color` redefines every existing use of
     that index, so only indices provably unused by the user's tigrc colors may be
     taken; if too few exist, fall back to quantization. Restoration on exit is
     terminal-dependent (needs `orig_colors`/`orig_pair` capabilities) — document
     that the session palette may stay modified. `:set`-triggered re-init must
     deliberately replay every allocated `init_color` slot (`start_color()` resets
     color tables).
  3. **Quantization** (in `auto` as fallback): nearest xterm-256 entry (One Monokai
     quantizes with barely visible error).
- Extended-pair draw path: replace `COLOR_PAIR(id)`-based attr composition
  (`include/tig/line.h:146-157`) and `set_view_attr`'s `wattrset`/`wchgat`
  (`src/draw.c:42-53`) and the search `mvwchgat` (`src/draw.c:650`) with
  `wattr_set`/`wchgat` passing the pair via the `opts` int pointer (ncurses
  extension for pairs >32767, part of the wide-character API under ABI 6).
  The configure check must exercise the **complete path actually used** —
  `init_extended_pair` + wide-attr functions with the `opts` extension under
  ncursesw ABI 6 — not merely symbol existence. Non-ncurses or old-ncurses builds
  compile to tier-3 behavior.
- `set truecolor = auto | palette | no` tigrc option (`auto` = direct-else-quantize;
  `palette` additionally enables tier 2).

**Exit criteria**
- `color diff-add rgb:abb2bf rgb:2d3d2d` renders exact RGB under
  `TERM=xterm-direct`; under `xterm-256color` it quantizes by default and renders
  exactly with `set truecolor = palette`.
- All existing tests pass; `:set`-triggered `init_colors()` re-runs are idempotent
  (no pair/slot leaks, palette slots replayed).

## Step 3 — General SGR decoder + `diff-syntax-filter` option in tig

- New option `set diff-syntax-filter = <path>` reusing the `diff_init_highlight`
  io-swap plumbing (`src/diff.c:46-72`). The value is an executable name/path
  (resolved via PATH like `diff-highlight` is, `src/apps.c:58`), **not** a shell
  command with arguments — that's what makes the pre-exec stat below well-defined.
  Mutually exclusive with `diff-highlight` and `word-diff` for v1 (same pattern
  as `src/diff.c:49`).
- **Two decoder modes**, selected by which option is active:
  - *Legacy mode* (`diff-highlight`): exactly today's semantics — `ESC[7m`/`ESC[27m`
    switch to/from the configured `LINE_DIFF_{ADD,DEL}_HIGHLIGHT` line types.
    Existing behavior and tests unchanged.
  - *Syntax mode* (`diff-syntax-filter`): decode 0 (reset), 1/3/4
    (bold/italic/underline), 22/23/24 (off), 38;2;r;g;b, 38;5;n, 39 (default fg),
    plus the ESC-framing unescape from the wire protocol. Ignore all other codes.
  Both keep the `skip` semantics — stored text stays escape-free (and, in syntax
  mode, literal-ESC-restored) so search keeps working.
- **Ephemeral style table, separate from line rules, structurally distinct in
  `box_cell`**: map each distinct resolved (fg, attr) × *base line type's bg* to
  an entry in a new syntax-style table. Rationale for a separate table: line rules
  are global config-visible state — `get_line_type` scans them and `:save-options`
  serializes them (`src/options.c:1418`) — so hundreds of anonymous styles must
  not live there. Rationale for structural distinction rather than a tag bit
  smuggled inside `enum line_type`: `box_cell.type` values flow into
  `get_line_info`, which asserts they index the line-rule table
  (`src/line.c:90`); a sometimes-invalid line type is an invariant every future
  caller would have to remember. Instead give `box_cell` an explicit style
  reference (e.g. a `style_ref` int with line-type vs syntax-style encoding
  behind accessor functions), so a wrong call fails to compile or is obvious at
  the call site. Style entries are recyclable (e.g. on `:set` / theme change);
  color pairs still come from the Step-2 allocator.
- **Two independent capacity limits**, not one: (a) a memory/DoS cap on distinct
  syntax styles (~512–1024) — attrs are free, so many styles share pairs; (b) the
  ncurses pair budget, checked after (fg,bg) deduplication (the existing allocator
  dedups on exactly that, `src/line.c:205-210`) against runtime `COLOR_PAIRS`
  minus pairs tig already uses. Overflow of either ⇒ fallback-to-base-type.
- **Fallback when the filter can't run** (new behavior, not today's empty view):
  resolve/stat the filter command before the io swap; if unavailable, skip the
  swap, render the plain diff, and `report()` once. (Daemon absence is handled by
  the thin client's passthrough — a different layer; both must work.)
- Italic only when the terminal supports `A_ITALIC`; otherwise drop the attr,
  keep the color.

**Exit criteria**
- Canned SGR diff fixtures through `diff_common_read` produce expected cell runs,
  including a literal-ESC content fixture round-tripping through the framing rule
  (new test in the style of `test/diff/diff-highlight-test`).
- Search matches text with escapes stripped; cursor row renders as today; all
  existing diff-highlight tests pass **unmodified** (legacy mode untouched).
- Missing filter binary ⇒ plain diff + one status message; `:save-options` output
  contains no syntax-generated entries; `:set` re-init is leak-free.

## Step 4 — Background-tint diff styling (red/green rows)

- Because the decoder keys on the base line type's bg, this is mostly
  configuration + defaults: token fg comes from SGR, bg comes from tig's
  `diff-add` / `diff-del` line colors.
- **These row tints are deliberate tig styling, not theme fidelity.** One Monokai
  defines only `diffEditor.insertedTextBackground: #00809B33` (an *intraline*
  changed-text overlay, not a whole-row background; composites to ≈`#203d49` over
  the `#282c34` editor bg) and no removed-side color at all. VS Code additionally
  distinguishes `insertedLineBackground`/`removedLineBackground` (whole-row) from
  the `*TextBackground` (intraline) colors. We want classic red/green rows, so we
  pick our own values, tuned visually in this step:
  ```
  set diff-syntax-filter = tig-syntax-filter
  set truecolor = auto
  color diff-add default rgb:2d3d2d   # whole-row tints: our styling choice
  color diff-del default rgb:3d2d2d
  ```
  (`default` fg means "keep token color"). Note `diff-add-highlight` /
  `diff-del-highlight` are deliberately absent: those types are selected only by
  the legacy 7/27 protocol, which syntax mode doesn't speak — configuring them
  would be dead configuration (intraline+syntax is a v1 non-goal). A One
  Monokai-faithful alternative snippet (teal inserted-text tint, no removed tint)
  goes in the docs for purists.
- **Comments are lifted off theme fidelity too.** One Monokai's comment
  foreground (`#676f7d`) is tuned for its own `#282c34` editor background; over
  the row tints above it reads as barely-there, so the filter brightens it to
  `#828c9c` (`TOKEN_COLOR_OVERRIDES` in `src/highlight.ts`). The vendored theme
  JSON itself stays a verbatim upstream copy.
- **Wrapping is excluded from v1**: highlighted lines bypass the pager wrap path
  entirely (see "What tig already has"), so `wrap-lines yes` + syntax filter means
  lines render unwrapped (truncated/scrollable) exactly like diff-highlight lines
  do today. Document this; style-aware wrapping (splitting styled cells at
  display-width boundaries with tabs and wide chars) is future work.
- Check interaction with `diff-indicator` (prefix hiding, `src/diff.c:382-384`).

**Exit criteria**
- Side-by-side eyeball test vs VS Code showing the same commit: token colors match
  (TextMate layer, pinned grammars); add/del rows read as green/red background
  tints with theme-colored code on top.

## Step 5 — Daemonize, full-source tokenization, caching (correctness + speed)

Upgrade the filter for production:

- **Daemon**: shiki instance listening on `$XDG_RUNTIME_DIR/tig-syntax.sock`,
  lazily spawned by the thin client on first use; grammars/theme + the Oniguruma
  WASM engine (pinned, explicitly instantiated) loaded once.
- **Transactional client, not a dumb pipe**: once bytes are fed to a dying daemon
  they can't be re-read from stdin, so "daemon crash ⇒ passthrough" needs
  buffering. The per-file flush boundary is the transaction: the client tees each
  diff-file section, sends it to the daemon, and emits the highlighted response
  only when it arrives complete; on any failure it emits the buffered raw section
  and degrades to passthrough for the rest of the stream. Sections too large to
  hold in RAM spool to disk (or are passed through unhighlighted — they'd exceed
  tokenizer limits anyway). This makes the `kill -9` exit criterion guaranteed
  rather than aspirational.
- **Repo context travels with every request.** The daemon's cwd is whatever repo
  first spawned it and is meaningless afterwards; only the *client* runs in
  `view->dir` (`src/diff.c:64`). Each request carries the absolute repo path
  (client sends its cwd); the daemon runs `git -C <repo> cat-file blob <oid>` and
  reads worktree files by absolute path.
- **Full-source tokenization**: parse `index <old>..<new>` and `@@` headers; fetch
  old/new content (object database for committed/staged sides; **direct worktree
  reads for the unstaged side** — that content is in no odb); tokenize each
  document from line 1 **only through the last line the diff references**, caching
  per-line grammar states incrementally (vscode-textmate's `tokenizeLine` takes
  prior state + a per-line time budget) — a tiny diff in a huge file stays cheap.
  Map diff rows: `-` → old doc, `+`/context → new doc. Mid-file hunks (block
  comments, template literals, heredocs) become always correct.
- **Cache** tokenized line-run tables + line-state checkpoints keyed by
  (repo identity, blob OID, grammar id + version, theme hash, tokenizer version);
  LRU-bounded. Worktree-side identity is a **content hash** (correctness-bearing;
  two contents can share mtime+size); (repo identity, absolute path, mtime+size)
  is only a rehash-skipping hint, trusted only under git's racily-clean rule —
  the file's mtime must be strictly older than the cache entry's creation time,
  since a rewrite can preserve both size and mtime; otherwise rehash. Residual
  staleness is still caught by correspondence validation below (mismatch ⇒
  passthrough, never wrong colors).
- **Hunk/source correspondence validation**: before injecting colors into a file's
  hunks, verify the diff's context and old/new lines byte-match the reconstructed
  sources at the mapped line numbers; on mismatch, pass that file through
  unhighlighted. This is the safety net for clean/smudge filters, CRLF
  conversion, staleness races, and transformations we failed to anticipate.
  It is *not* sufficient for textconv (below): it checks only displayed lines,
  and a transform that alters just unshown prefix lines still poisons the
  grammar state those lines carry.
- **Limits**: per-line time budget and max line length (mirror VS Code's 20k-char
  cap); oversized/pathological input passes through unhighlighted. If tokenization
  of line N stops early (time budget), grammar state from that point is tainted —
  pass through the **remainder of that side's document**, not just line N, since
  later lexical state depends on it. Daemon absence, crash, or timeout ⇒ client
  falls back to passthrough; tig is unaffected.
- Skip binary files, submodules, invalid-UTF-8 files, and **files whose diff
  driver configures textconv** (detected via `git check-attr diff` + config
  lookup, cached per path): tig's stage-view diffs pass `--textconv`
  (`include/tig/git.h:33-36`), so git may display transformed rather than
  literal blob content, and correspondence validation cannot prove the unshown
  transformed prefix matches the raw source we would tokenize.

**Exit criteria**
- A hunk starting inside a multiline construct highlights correctly (corpus test).
- Two tigs in different repos sharing one daemon get correct, non-aliased results.
- Navigating j/k through commits in the main view with the diff pane open feels
  instant; revisiting a commit re-serves from cache (measure: warm re-open of a
  medium commit < ~30 ms filter latency end-to-end).
- A small diff against a huge source file highlights without tokenizing past the
  last hunk (measure it).
- `kill -9` the daemon mid-scroll: tig keeps working, plain diffs render.

## Step 6 — Tests, docs, packaging, upstream split

- **Tests**: extend the `test/diff/` harness — SGR fixture tests per decoder mode
  (legacy 7/27 semantics locked in; syntax-mode SGR set; ESC framing round-trip),
  losslessness over the corpus (filter), `rgb:` color parsing, truecolor tier
  selection under faked terminfo, `:set` re-init, `:save-options` purity, search
  over syntax spans, missing-filter fallback, daemon-crash mid-file fallback
  (transaction boundary), correspondence-validation passthrough (textconv/CRLF),
  cross-repo daemon requests.
- **Docs**: `doc/tigrc.5.adoc` entries for `diff-syntax-filter`, `truecolor`,
  `rgb:RRGGBB` colors; a manual section with the recommended snippet from Step 4
  and the wrap-lines / intraline-highlight limitations.
- **Packaging**: Nix derivation for the daemon with an explicit node/bun store
  dependency (no `/usr/bin/env node`); filter+daemon shippable separately from
  tig; grammar/theme versions pinned in the lockfile.
- **Upstream**: split PRs — (i) truecolor support (standalone value, jonas/tig#227),
  (ii) general SGR decoder + `diff-syntax-filter` option (generalizes an existing
  feature), (iii) docs pointing at the external filter. The daemon itself stays
  out-of-tree or in `contrib/`.

---

## Risks

| Area | Risk | Mitigation |
|---|---|---|
| Extended-pair draw path (`wattr_set`/opts) | Medium — touches every draw call; older-ncurses variance | configure test exercises the full ABI-6 path; tier-3 fallback compiles everywhere; own step with full test pass |
| Wire losslessness (literal ESC in content) | Medium | framing rule + round-trip CI test over corpus incl. adversarial fixture |
| Regressing legacy diff-highlight | Medium | separate decoder mode; existing tests must pass unmodified |
| Dynamic style/pair growth under `:set` re-init | Medium | separate ephemeral style table + runtime `COLOR_PAIRS` cap + idempotency test |
| Daemon lifecycle & multi-repo state (stale socket, cwd, cache aliasing) | Medium | per-request repo context; repo identity in cache keys; handshake version; transactional per-file buffering in the client, passthrough on any error |
| Palette reprogramming surprises users | Low (opt-in) | never in `auto`; only provably-unused indices; documented restoration caveat |
| Perf on huge diffs / huge files | Low–medium | streaming per-file flush; tokenize only to last needed line; caps; per-file passthrough fallback |

## Assets in place

- `~/cloned/vscode-one-monokai/themes/OneMonokai-color-theme.json` — the fidelity
  target theme (imported; copy into `tools/tig-syntax-filter/themes/` in Step 1).
- `~/cloned/vscode` — VS Code source snapshot for TextMate parity spot-checks
  (token inspector, `extensions/*/syntaxes/` grammar versions to pin against).
- Still welcome: representative code samples for the golden corpus (Elixir, Nix, etc.).
