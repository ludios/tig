# Syntax highlighting for tig diff views — finalized implementation plan

Status: finalized plan, ready to implement. Supersedes `raw-proposals/1.md` and
`raw-proposals/2.md`; decisions below resolve their open questions. All file:line
references were re-verified against this tree (2.6.1-dev, master @ 1b86f070).

## Goals

1. **Correct syntax highlighting** in diff views, matching what a VS Code theme
   (e.g. One Monokai) renders — same grammars, same theme JSON, same engine lineage.
2. **Added/removed lines shown with red/green *background* tint** (VS Code style),
   with token foreground colors preserved — not today's red/green foreground text.
3. **Truecolor (24-bit) support in tig** — exact theme RGB, not xterm-256 quantization.
4. **Fast commit-to-commit navigation** — scrolling through commits in the main view
   with the diff pane updating must stay snappy; revisiting a commit should be instant.

Non-goals for v1: semantic (LSP) tokens, combined merge diffs, blame/blob/tree views,
Windows, word-diff + syntax at the same time.

## Decisions (resolving the raw proposals' open questions)

| Question | Decision |
|---|---|
| Architecture | **Proposal 2's**: external SGR-injecting filter + a general SGR decoder in tig. Not proposal 1's custom binary protocol / layered-style-resolver rewrite — tig's existing filter hook and cell model make that unnecessary. |
| Engine | **shiki** (vscode-textmate + vscode-oniguruma — the same engine VS Code uses), run as a persistent daemon behind a thin pipe client. Loads VS Code theme JSON as-is. |
| Node/Bun dependency | Acceptable. Target platform is Linux/NixOS; package the daemon with an explicit Node/Bun store path. Windows out of scope. |
| Tokenization state | **Full-file tokenization** (fetch pre/post-image blobs via `git cat-file`, map hunk line numbers) — always correct, cacheable by blob OID. Hunk-local state only in the throwaway PoC. |
| Truecolor | **Core requirement, done early** (Step 2), so all later steps render exact RGB. 256-color quantization remains as automatic fallback. |
| Diff line coloring | Token fg from theme + line bg tint from tig's own `diff-add`/`diff-del` colors, expressed through existing tigrc `color` commands once they accept `#rrggbb`. |

## Architecture

```
git show --no-color ──► tig-syntax-filter (thin client) ──► tig
                              │ unix socket                   │ general SGR decoder
                              ▼                               ▼
                        highlight daemon                box cells (fg,attr) × base-bg
                        shiki + One Monokai JSON        → dynamic line rules
                        git cat-file for full blobs     → ncurses extended pairs
                        cache keyed by blob OID            (truecolor) or 256 fallback
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

## What tig already has (verified)

- **Per-token colored line segments**: `struct box` / `box_cell`
  (`include/tig/view.h:28-37`), drawn cell-by-cell in `src/draw.c:588-607`. Cell
  budget 8192/line (`src/diff.c:89`). Arbitrary per-token coloring is already the
  rendering model.
- **External filter hook**: `diff_init_highlight` swaps `view->io` for a filter pipe
  over the whole `git show --no-color` stream (`src/diff.c:46-72`); input is
  guaranteed colorless (`src/diff.c:32`). The stage view rides the same path
  (`src/stage.c:782,818`), so staged/unstaged diffs get highlighting for free.
- **ANSI-to-cells parsing skeleton**: `diff_common_highlight` (`src/diff.c:288-303`)
  recognizes exactly `\x1b[7m`/`\x1b[27m`; its `skip` mechanism strips escape bytes
  from stored text (`src/diff.c:101-102`) so search/regex/export see clean text.
  This is the skeleton the general decoder replaces.
- **Dynamic line rules + deduplicated color pairs**: `init_line_info`/`add_line_rule`
  grow the rule table at runtime (`src/line.c:102-180`); pairs are deduplicated by
  (fg,bg) and allocated on demand (`src/line.c:197-218`). Colors re-init on `:set`
  (`src/prompt.c:1121`) — dynamic paths must be idempotent.
- **The gaps**: colors are `color0..color255` ints (`src/options.c:384-394`); pair
  setup is classic `init_pair`/`COLOR_PAIR` (`src/line.c:217`,
  `include/tig/line.h:143-157`, `src/draw.c:42-53`) — no truecolor (open upstream
  request jonas/tig#227). Selected rows suppress per-cell styling (`src/draw.c:45`)
  and search overwrites attrs via `mvwchgat` (`src/draw.c:650`) — both acceptable
  v1 behaviors to keep.

---

## Step 1 — Filter proof-of-concept (no tig changes)

Build `tools/tig-syntax-filter/` (TypeScript, single package):

- shiki with One Monokai theme JSON; language detection from `+++ b/<path>`
  extension plus shebang sniffing; grammar state reset at each `diff --git` header.
- v0 tokenization: hunk-local, two parallel grammar-state chains per file
  (`-` lines continue the old-file state; `+`/context lines the new-file state).
- Emit fg-color SGR only (`38;2;r;g;b`), plus bold/italic/underline; never emit
  bg codes or touch column 0 / hunk headers / file headers.
- Sanitize any pre-existing ESC bytes in diff content before injecting.
- Flush output per file (tig streams the filter's stdout through its async io layer;
  a fully buffering filter would stall first paint).

Also assemble a **golden corpus**: real commits from this and other repos covering C,
TS/JS, Rust, Python, Nix, Elixir, Markdown, HTML+embedded CSS/JS, multiline
comments/strings starting before a hunk, UTF-8/emoji, very long lines.

**Exit criteria**
- `git show --no-color <rev> | tig-syntax-filter | less -R` looks right in a
  truecolor terminal; colors visually match a VS Code window with One Monokai.
- Structure preservation: output is byte-identical to input after
  `sed 's/\x1b\[[0-9;]*m//g'`, verified across the corpus.
- Warm per-file latency measured and recorded (target: <50 ms for typical files).

## Step 2 — Truecolor support in tig core

Independent, upstreamable on its own (closes jonas/tig#227). No syntax code yet.

- Accept `#rrggbb` in `set_color` (`src/options.c:384`); represent as packed RGB in
  the existing `int fg, bg` of `struct line_info` (`include/tig/line.h:115-120`)
  with a flag bit distinguishing RGB from indexed.
- Three rendering tiers, resolved at pair-init time in `init_line_info_color_pair`
  (`src/line.c:197-218`):
  1. **Direct color**: terminfo reports RGB (`COLORS >= 0x1000000`, e.g.
     `xterm-direct`/`tmux-direct`) → `init_extended_pair` with packed RGB.
  2. **Palette reprogramming**: `can_change_color()` → allocate slots ≥16 via
     `init_color` for each distinct RGB (One Monokai needs ~14 fg + ~4 bg ≈ 20
     slots). Gives exact colors on ordinary `xterm-256color` terminals. On by
     default with an opt-out, since it mutates the session palette.
  3. **Quantization**: nearest xterm-256 entry (One Monokai quantizes with barely
     visible error).
- Extended-pair draw path: replace `COLOR_PAIR(id)`-based attr composition
  (`include/tig/line.h:146-157`) and `set_view_attr`'s `wattrset`/`wchgat`
  (`src/draw.c:42-53`) and the search `mvwchgat` (`src/draw.c:650`) with
  `wattr_set`/`wchgat` passing the pair via the `opts` int pointer (ncurses
  extension for pairs >32767). configure check for `init_extended_pair`
  (`NCURSES_EXT_COLORS`); non-ncurses or old-ncurses builds compile to tier-3
  behavior.
- `set truecolor = auto | no` tigrc option; `auto` picks the best tier.

**Exit criteria**
- `color diff-add-highlight #ffffff #345634` renders exact RGB under
  `TERM=xterm-direct`, and via palette reprogramming under `xterm-256color`.
- All existing tests pass; `:set`-triggered `init_colors()` re-runs are idempotent
  (no pair/slot leaks).

## Step 3 — General SGR decoder + `diff-syntax-filter` option in tig

- New option `set diff-syntax-filter = <cmd>` reusing the `diff_init_highlight`
  io-swap plumbing verbatim (`src/diff.c:46-72`). Mutually exclusive with
  `diff-highlight` and `word-diff` for v1 (same pattern as `src/diff.c:49`).
  Graceful fallback when the command is missing, mirroring existing behavior.
- Replace the two-code scanner (`src/diff.c:288-303`) with a real SGR parser:
  `ESC[…m` with params 0 (reset), 1/3/4 (bold/italic/underline), 22/23/24 (off),
  38;2;r;g;b, 38;5;n, 39 (default fg). Ignore all other codes. Keep the `skip`
  semantics — stored text stays escape-free so search keeps working.
- Map each distinct resolved (fg, attr) × *base line type's bg* to a dynamically
  created line rule via the existing growth path (`src/line.c:102-180`), memoized
  in a small hash; pairs fall out of the Step-2 allocator. Cap dynamic rules
  (e.g. 512) with fallback-to-base-type on overflow.
- Italic only when the terminal supports `A_ITALIC`; otherwise drop the attr,
  keep the color.

**Exit criteria**
- Canned SGR diff fixtures through `diff_common_read` produce expected cell runs
  (new test in the style of `test/diff/diff-highlight-test`).
- Search matches text with escapes stripped; cursor row renders as today;
  existing diff-highlight tests still pass; `:set` re-init is leak-free.

## Step 4 — Background-tint diff styling (the VS Code look)

- Because the decoder keys on the base line type's bg, this is mostly
  configuration + defaults: token fg comes from SGR, bg comes from tig's
  `diff-add` / `diff-del` line colors.
- Ship a documented tigrc snippet with One Monokai-derived defaults, alpha
  precomposited against editor bg `#282c34` (VS Code diffEditor
  inserted/removedTextBackground over the theme bg), e.g.:
  ```
  set diff-syntax-filter = tig-syntax-filter
  set truecolor = auto
  color diff-add           default #2d3d2d
  color diff-del           default #3d2d2d
  color diff-add-highlight default #345634    # intraline, brighter
  color diff-del-highlight default #563434
  ```
  (exact values tuned visually in this step; `default` fg means "keep token color").
- Verify wrapped lines (`src/pager.c:72-105`) — continuation fragments inherit the
  line type, so tinting extends across wraps; add a test. Check interaction with
  `diff-indicator` (prefix hiding, `src/diff.c:382-384`).

**Exit criteria**
- Side-by-side eyeball test vs VS Code's diff view of the same commit: token colors
  match; add/del rows read as green/red background tints with colored code on top.

## Step 5 — Daemonize, full-file tokenization, caching (correctness + speed)

Upgrade the filter for production:

- **Daemon**: shiki instance listening on `$XDG_RUNTIME_DIR/tig-syntax.sock`,
  lazily spawned by the thin client on first use; grammars/theme loaded once.
  Client is a dumb pipe (small C program or compiled single binary) so per-diff
  spawn cost is negligible.
- **Full-file tokenization**: parse `index <old>..<new>` and `@@` headers; fetch
  blobs with `git cat-file blob <oid>` (the filter inherits the repo cwd — tig
  spawns it in `view->dir`, `src/diff.c:64`); tokenize old and new documents
  completely; map diff rows: `-` → old doc, `+`/context → new doc. This makes
  mid-file hunks (block comments, template literals, heredocs) always correct.
- **Cache** tokenized line-run tables keyed by (blob OID, grammar id, theme hash,
  tokenizer version), LRU-bounded in the daemon. Worktree-side content (unstaged)
  keyed by path+mtime+size, or content hash.
- **Limits**: per-line time budget and max line length (mirror VS Code's 20k-char
  cap); oversized/pathological input passes through unhighlighted. Daemon absence,
  crash, or timeout ⇒ client falls back to passthrough; tig is unaffected.
- Skip binary files, submodules, and files transformed by textconv.

**Exit criteria**
- A hunk starting inside a multiline construct highlights correctly (corpus test).
- Navigating j/k through commits in the main view with the diff pane open feels
  instant; revisiting a commit re-serves from cache (measure: warm re-open of a
  medium commit < ~30 ms filter latency end-to-end).
- `kill -9` the daemon mid-scroll: tig keeps working, plain diffs render.

## Step 6 — Tests, docs, packaging, upstream split

- **Tests**: extend the `test/diff/` harness — SGR fixture tests (decoder),
  structure preservation over the corpus (filter), truecolor tier selection under
  faked terminfo, `:set` re-init, wrapped lines, search over syntax spans,
  filter-missing fallback, daemon-crash fallback.
- **Docs**: `doc/tigrc.5.adoc` entries for `diff-syntax-filter`, `truecolor`,
  `#rrggbb` colors; a manual section with the recommended snippet from Step 4.
- **Packaging**: Nix derivation for the daemon with an explicit node/bun store
  dependency (no `/usr/bin/env node`); filter+daemon shippable separately from tig.
- **Upstream**: split PRs — (i) truecolor support (standalone value, jonas/tig#227),
  (ii) general SGR decoder + `diff-syntax-filter` option (generalizes an existing
  feature), (iii) docs pointing at the external filter. The daemon itself stays
  out-of-tree or in `contrib/`.

---

## Risks

| Area | Risk | Mitigation |
|---|---|---|
| Extended-pair draw path (`wattr_set`/opts) | Medium — touches every draw call; older-ncurses variance | configure-gated; tier-3 fallback compiles everywhere; own step with full test pass |
| Filter must never break diff structure | Medium | byte-identity check after SGR strip is a hard CI test |
| Dynamic rule/pair growth under `:set` re-init | Medium | dedupe + cap + idempotency test |
| Daemon lifecycle (stale socket, version skew) | Low–medium | handshake version; client falls back to passthrough on any error |
| Palette reprogramming surprises users | Low | opt-out; ncurses restores the palette on exit where the terminal supports it |
| Perf on huge diffs | Low–medium | streaming per-file flush; caps; per-file passthrough fallback |

## Assets to import into this repo (ask Ivan)

- `azemoh/vscode-one-monokai` — `themes/OneMonokai-color-theme.json` (the fidelity
  target; needed from Step 1) → `tools/tig-syntax-filter/themes/`.
- A VS Code source snapshot is *not* needed (shiki ships the engine); only useful
  for optional parity spot-checks with the token inspector.
- Optional: representative code samples for the golden corpus (Elixir, Nix, etc.).
