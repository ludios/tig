# graph-v2 on very wide histories (nixpkgs): O(W²) work per row

Model-output: Claude Opus 5.5

**Fixed 2026-09-29** as proposed below; see [Result](#result).  The rest is
the original handoff.

Measured 2026-09-28 on xclank
(32 cores), `~/cloned/nixpkgs` at d095bb9fd847 (1,011,374 commits, 23k refs),
git 2.54.0, tig built from `prime` around 06c6ff7e (`src/graph-v2.c` is
unchanged through d80fbb72).

## Problem

With the default v2 graph, the main view on nixpkgs effectively never
finishes loading: tig pins a core while `git log` sits idle on a full pipe.

| main view load (pty, `TIG_SCRIPT=:quit`) | 20k commits | 30k    | 50k    | all 1M               |
|------------------------------------------|-------------|--------|--------|----------------------|
| graph v2 (default)                       | 6.8 s       | 16.3 s | 45.1 s | >20 min (killed at 11 min, 55% read, RSS 2.3 GB) |
| graph v1                                 |             | 0.53 s |        | 6.7 s                |
| no graph                                 |             |        |        | 6.6 s                |

`git log` alone emits the whole 261 MB in 6.8 s, so everything above v1 is
tig's graph code.  At these widths the result is also useless on screen: by
line ~15000 everything right of the author column is `│` bars and no commit
titles are visible.

## Evidence

`perf` on the running full load: 77% self in `graph_render_parents` (the
symbol helpers are inlined into it), 17% in `shift_left`, ~2% hashing, ~1%
malloc/free.

W = `graph->row.size` (the three rows `prev_row`/`row`/`next_row` always
have the same size), logged every 2000 commits with an instrumented build:

| commits | 2k | 10k | 18k  | 30k  | 38k  | 50k  |
|---------|----|-----|------|------|------|------|
| W       | 72 | 558 | 1016 | 1164 | 1366 | 1236 |

Every column holds an id; there are no empty slots to reclaim.  The true lane
count (distinct pending parents in topo order, from `git log --format='%H %P'`)
over the full history averages 464 and peaks at 912.  nixpkgs's many PRs fork
from older master commits, which stay pending until all their children are
shown.  tig's W runs ~1.7–2× the true lane count because shifted lanes are
represented as duplicated ids.  So a wide W is inherent to the repository; the
cost per unit of W is what's wrong.

## Root cause

`graph_generate_symbols()` loops over all W columns, and most of the helpers
it calls per column scan the row again:

| symbol field            | helper call                           | scan         |
|-------------------------|---------------------------------------|--------------|
| continued_right         | `continued_right(row, pos, c)`        | O(W)         |
| continued_left          | `continued_left(row, pos, c)`         | O(W)         |
| continued_up_left       | `continued_left(prev_row, pos, W)`    | O(W)         |
| next_right              | `continued_right(next_row, pos, 0)`   | O(W)         |
| flanked                 | `flanked(row, pos, c, id)`            | O(W)         |
| new_column              | `new_column(row, prev_row, pos)`      | O(W)         |
| shift_left              | `shift_left(row, prev_row, pos)`      | O(W)         |
| continue_shift          | `shift_left(row, prev_row, pos + 1)`  | O(W)         |
| parent_right            | `parent_right(parents, row, next_row, pos)` | O(P·W) |
| color                   | `get_color()`                         | malloc + strlen + string hash |

(c = `graph->position`, P = `graph->parents.size`, usually 1–2.)  That makes
~10·W² steps per row: ~10⁷ per row at W≈1000.  Everything else per row
(`graph_insert_parents`, `graph_remove_collapsed_columns`,
`graph_commit_next_row`, …) is O(W) or O(P·W), which is fine.

## Proposed fix: O(W) symbol generation, output unchanged

Before the loop, build per-row index arrays in one or two passes each, then
answer every predicate in O(1).  Ids are interned (`intern_string()`), and the
code already compares them by pointer, so pointer equality is exact.  A small
open-addressing table keyed by pointer and sized ~2W, reused across rows,
is enough for the id → index maps.  **NULL is a real key** for `next_R`,
`next_N` and `last_P` below (empty columns match each other), so it can't
double as the table's empty-slot marker; give NULL its own side slot.

Definitions (−1 / W when there's no such index):

- `next_R[pos]`: smallest i > pos with `row[i].id == row[pos].id`.  **NULL
  counts as a value**: `continued_right` treats two empty columns as the
  same id.
- `prev_R[pos]`: largest i < pos with `row[i].id` non-NULL and equal to
  `row[pos].id`.
- `next_N[pos]`: like `next_R`, over `next_row` (NULL counts).
- `prev_P[pos]`: like `prev_R`, over `prev_row`.
- `last_P(x)`: largest i with `prev_row[i].id == x` (x may be NULL).
- `first_c`, `last_c`: smallest/largest i with `row[i].id == graph->id`.
- `M`: largest i with `next_row[i].id` equal to some non-NULL parent and
  `row[i].id != next_row[i].id`.

Rewrites (each should be checked against the current helper line by line):

- continued_right: `next_R[pos] < (pos < c ? c : W)`
- continued_left: `row[pos].id && prev_R[pos] >= (pos < c ? 0 : c)`
- continued_up_left: `prev_row[pos].id && prev_P[pos] >= 0`
- next_right: `next_N[pos] < W`
- flanked: `pos < c ? first_c < pos : last_c > pos`
- new_column: `!prev_row[pos].id || last_P(row[pos].id) < pos`
- shift_left(pos): `row[pos].id && prev_R[pos] >= 0 &&
  !continued_down(prev_row, row, prev_R[pos])`.  The current loop stops at
  the *nearest* matching column on the left, which is exactly `prev_R`.
- parent_right (only evaluated for pos > c): `M > pos`
- parent_down stays as is (O(P)).

A reviewer checked each of these rewrites against the current helpers with
an instrumented build, over this repo's history, 6k nixpkgs commits and 15k
vscode commits (~1.5M column evaluations), and reported no mismatches.

**The symbol bits are state, too.**  `continued_down(row, next_row, pos)`
reads `row->columns[pos].symbol.shift_left`, and at that point the bit is
always 0.  `graph_commit_next_row()` refilled `row` from `next_row`, whose
symbols only ever get `memset` + `boundary` (`graph_insert_column()`).  So
that call is just `row[pos].id == next_row[pos].id`, but only because it runs
before the loop overwrites `symbol->shift_left`.  Either keep that order or
replace the call with the id comparison, perhaps asserting the bit is 0.
The computed bits do matter one row later.  `graph_commit_next_row()` copies
`row`, symbols included, into `prev_row`, where `continued_up`,
`below_shift`, `shift_left`'s `continued_down(prev_row, …)` and
`graph_remove_collapsed_columns()` read `shift_left` back.  So `shift_left`
must still be computed for every column.

Cheap follow-ons in the same file:

- `colors_get_color()` mallocs and strcpy's a key for every lookup, i.e. every
  column of every row.  Look up without allocating, e.g. key the map by the
  interned pointer (NULL maps to the `""` literal today; keep that stable).
- `DEFINE_ALLOCATOR(realloc_graph_symbols, struct graph_symbol, 1)` reallocs
  once per appended symbol.  The canvas size is known up front (W), so
  reserve it once per row.

Expected result: per-row cost O(W), so the 30k case should land near v1's
0.5 s instead of 16 s, and the full load near git's own ~7 s plus a few
seconds.  That's a guess; measure it.

## Result

Implemented as proposed.  `graph_scan_rows()` fills the arrays using an
open-addressing table keyed by the interned pointer, whose slots belong to
the current scan by a generation stamp (so NULL is an ordinary key and
nothing is cleared between scans).  The color map is keyed by pointer, and
each canvas is allocated once per row.

Symbol bits and colors, dumped raw, are identical to the old code on nixpkgs
(50k topo order, 30k date order, 20k default order, 15k `--all`, 8k with 137
`--boundary` commits), vscode (40k `--all`), postgresql and questdb (`--all`),
this repo, 30 generated histories up to 814 lanes wide, and 24k fuzzed inputs
(non-topological orders, duplicate and missing parents, boundary commits).
New tests: `test/graph/21-wide-history-test` (glyphs and colors, verbatim),
`22-wide-history-cksum-test` (~530 lanes, by checksum) and
`23-wide-history-speed-test` (~2000 lanes under an 8 s CPU limit: 1.3 s now,
31 s before); `test/tools/gen-history` generates their inputs.

| main view load (pty, `TIG_SCRIPT=:quit`) | 30k    | 50k    | all 1M                  |
|------------------------------------------|--------|--------|-------------------------|
| graph v2 before                          | 16.3 s | 45.1 s | >20 min                 |
| graph v2 after                           | 1.07 s | 2.08 s | 29.6 s, peak RSS 3.2 GB |
| graph v1                                 | 0.53 s |        | 6.7 s                   |

The guess above was optimistic for the full load: the remaining O(n·W) work,
roughly 800M symbols (most of the 3.2 GB at 4 bytes each), still costs ~23 s
over v1.  About a third of the graph's time is now `get_color()`'s libiberty
hashtable lookup, one per symbol; a pointer-keyed open-addressing color table
would remove most of it.

## Still unsolved after that: memory O(n·W)

Each line keeps W 4-byte `struct graph_symbol`s.  Full nixpkgs ≈ 1M × ~900 ×
4 B ≈ 3.6 GB, consistent with 2.3 GB RSS halfway through (3.2 GB peak for a
full load after the fix).  Bounding this means storing/drawing at most K
lanes per line (with some overflow glyph).  That changes output and needs a UI
decision (cap value, option name, glyph), so **ask the user** before doing it.
Since titles are already invisible at these widths, a cap would also make the
view readable again.

## How to verify

1. `nix-shell -p ncurses --run "script -qec 'make test' /dev/null"`: the
   `test/graph/*` snapshot tests must pass unchanged.
2. Differential run over real history.  `test/tools/test-graph` feeds
   `git log --pretty=raw --parents` through the v2 graph and prints every
   row.  Build it from the old and new code and diff the outputs:

   ```sh
   git -C ~/cloned/nixpkgs log --pretty=raw --parents --topo-order -n 20000 > /tmp/nixpkgs-20k.log
   test/tools/test-graph --ascii < /tmp/nixpkgs-20k.log > old.txt   # old build
   test/tools/test-graph --ascii < /tmp/nixpkgs-20k.log > new.txt   # new build
   cmp old.txt new.txt
   ```

   Glyph output is not enough on its own.  Many flag combinations map to
   the same glyph, and it doesn't show `symbol->color` at all, which the
   `colors_get_color()` follow-on changes.  Add a test-graph flag that dumps
   each symbol's raw bits, color included, and diff that too.  Repeat on
   more histories (this repo, `~/cloned/vscode`, nixpkgs at 50k+ once it's
   fast).
3. Timing: the test-graph run above takes 6.7 s on the 20k log today and
   needs no pty.  End to end (the binary path must be absolute:
   `pty-timer.py` chdirs into the repo before exec, and a failed exec just
   shows up as a ~14 ms run with exit status 256):

   ```sh
   export TIG_SYNTAX_SOCKET=/tmp/graph-bench.sock   # private daemon, not the user's
   python3 doc/slop/benchmarks/BM7/pty-timer.py 3 ~/cloned/nixpkgs - "$PWD/src/tig" --max-count=30000
   doc/slop/benchmarks/kill-sock-daemon.sh "$TIG_SYNTAX_SOCKET"   # stop that daemon afterwards
   ```

   That's 16.3 s today; then run it without `--max-count` for the full
   history.  Check the exit_status column is 0.

## Workaround

`set main-view-commit-title-graph = v1`, which `doc/tigrc.5.adoc` already
recommends for large repositories.  After the fix, v1 is still ~4× faster
than v2 on the full nixpkgs history.

## Out of scope here, found in the same investigation

- First screen on nixpkgs is ~200 ms, of which ~130 ms is
  `main_check_index()` running `git status --porcelain
  --untracked-files=normal` synchronously (143 ms standalone on nixpkgs vs
  13 ms with `--untracked-files=no`).  `set show-untracked = no` brings the
  first screen to 78 ms.
- Each commit switch in the diff view runs `git describe --tags` (12.6 ms
  standalone, 10k tags) *after* `git show` (3.7 ms) finishes, in
  `src/diff.c` near `adding_describe_ref`.  Together that's ~16 of the ~24 ms
  per switch with the syntax filter off.
- mimalloc (in tig and/or git) was measured and gives at most 6.4% on any
  bench (git-side); see `doc/slop/benchmarks/BM11/`.
