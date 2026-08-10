# Performance ideas for diff syntax highlighting

Model-output: Claude Fable 5

Status: idea collection, 2026-08-10.  Nothing here is implemented; each idea
names the code it would touch.  Benchmark before optimizing — the section
"Benchmarks to run first" defines the measurements that gate the ideas.

## Pipeline recap and what we already know

```
git show … ──pipe──> tig-syntax-filter (C client) ──unix socket──> daemon (node + shiki)
                        │  spools all input, emits frames                │  per-section: parse,
                        v                                                v  git cat-file, tokenize
                     tig diff view <──frames (highlighted sections)── frames in input order
```

- tig spawns one `tig-syntax-filter` client per diff/stage view load
  (`diff_init_highlight` in `src/diff.c`); the client connects to (or spawns)
  the long-lived daemon and streams the diff through it.
- The daemon splits the diff into per-file sections (`diff_parser.ts`),
  fetches both blob sides (`git.ts`, persistent `cat-file --batch` per repo +
  LRUs), tokenizes with shiki (`highlight.ts`), validates every hunk line
  against the source, and returns the section with SGR injected
  (`process.ts`).  Sections are processed strictly one at a time, in order
  (`daemon.ts` promise queue).
- tig decodes the SGR into ephemeral styles (`diff_common_syntax` in
  `src/diff.c`, style table in `src/line.c`).

Numbers from `~/.local/state/tig-syntax/daemon.log` (2026-08-07..09, this
machine, the tig repo itself):

- Warm daemon, previously-seen commit (all caches hit): **3–6 ms** for 10
  sections.  The cache works; making more traffic hit it is the theme of
  half the ideas below.
- Warm daemon, new commit: **~140–180 ms** for 10 sections.  This is the
  latency felt on every j/k step through history in a split view.
- Cold daemon: shiki init before the socket even listens, then **~370–510 ms**
  for the first serve.  Plus node boot and the client's 50 ms connect-retry
  granularity in front of that (not yet measured, see B-benchmarks).

## Why giant commits hang

Several compounding causes, all visible in the code:

1. **Tokenization is synchronous and unbounded in time.**
   `highlighter.codeToTokensBase()` (`highlight.ts`) blocks the daemon's
   event loop until the whole document slice is tokenized.  The size limits
   (`MAX_DOC_LINES` 100k, `MAX_LINE_CHARS` 20k, 8 MB blobs) are *size*
   limits, not *time* limits — a 100k-line C++ file is within limits and can
   take tens of seconds under oniguruma.
2. **A hunk near the bottom of a big file pays for the whole file.**
   `highlight_lines` must tokenize from line 1 up to the last touched line
   (grammar state is sequential), so a one-line change at line 90k of a 100k
   line file tokenizes 90k lines — for *each* side of the diff (old and new
   blobs are tokenized separately even though they are ~identical).
3. **Sections are strictly sequential per connection**, so one pathological
   file starves every later (possibly tiny) section in the same commit.
   And because tokenization blocks the event loop, one pathological
   *connection* starves every other tig instance sharing the daemon.
4. **The client waits up to `FRAME_TIMEOUT_MS` (15 s) for a frame**
   (`client/tig-syntax-filter.c`) before falling back to emitting the raw
   diff.  Worst case UX today: blank diff pane for 15 s, then the whole raw
   diff dumps in.  Worse: if each section completes in under 15 s, the
   timeout never fires and a 50-file commit can trickle for minutes with no
   fallback at all.
5. Meanwhile tig busy-polls (`get_input` in `src/display.c` sets `delay = 0`
   while any view has a live pipe), burning a core on top of the daemon's
   tokenizer.  Keys still work, but the machine is pegged and the pane is
   empty — indistinguishable from a hang.

The fix directions are in section A below; the short version is: convert the
size limits into a **time budget**, make tokenization **interruptible /
off-loop**, and make the client's fallback **progressive** instead of
all-or-nothing.

## Benchmarks to run first

Do these before the implementation work; each names the ideas it gates.
Use an isolated socket (`TIG_SYNTAX_SOCKET=/tmp/tig-bench.sock`) so a
benchmark daemon never fights the interactive one, and `set git-colors = no`
plus this repo's tigrc conventions when measuring inside tig.

### BM1: build a corpus of giant and typical commits

Rank commits of a few local repos by diff size:

```sh
git -C <repo> rev-list HEAD | head -2000 | while read h; do
	printf '%s %s\n' "$(git -C <repo> show "$h" | wc -c)" "$h"
done | sort -rn | head -20
```

Keep: (a) a typical 5–15 file commit, (b) a giant generated-file commit,
(c) a commit touching the bottom of a very large source file, (d) a rename-
heavy commit, (e) a commit in a language with an expensive grammar (C++,
TypeScript).  Also synthesize a worst case: one commit appending to the end
of a 100k-line TypeScript file.  Record the exact SHAs in a
`doc/slop/bench-corpus.txt` so numbers stay comparable across sessions.

### BM2: end-to-end filter latency, cold vs warm

```sh
# cold: kill the daemon between runs
hyperfine --prepare 'pkill -f tig-syntax-daemon; sleep 0.2' \
	'git -C <repo> show <sha> | tig-syntax-filter > /dev/null'
# warm: run once to prime, then measure
hyperfine --warmup 2 'git -C <repo> show <sha> | tig-syntax-filter > /dev/null'
```

(`hyperfine` via `nix-shell -p hyperfine`, or a plain `time` loop.)  Gates:
everything in sections A–C; this is the headline number.  Beware the pkill
self-match trap noted in the dev-environment memory: match on
`tig-syntax-daemon`, not a broader pattern.

### BM3: time-to-first-frame and per-section latency profile

The 15 s cliff and the trickle behavior are invisible to BM2's totals.
Write a ~40-line node script that speaks the client side of the protocol
(header, stream a recorded diff, timestamp every `O`/`E` frame) and emits a
CSV of (section index, bytes, ms since connect).  Run it against the corpus.
Gates: A1–A5 (budgets, chunking, progressive fallback), and verifies frames
really are line-aligned (E4).

### BM4: daemon-internal stage breakdown + cache hit rates

Add debug-level timers in `process.ts` around: section parse, textconv
check, `load_side` (split fetch vs decode), `highlight_lines` (split cache
hit vs tokenize), validation, emission.  Add hit/miss counters to the three
caches in `git.ts` and the line cache in `highlight.ts`, logged in the
existing per-connection summary line.  Then replay the corpus and read the
log.  Gates: C1 (how much do the two `execFile` git spawns per first-seen
file cost?), C2/C3 (is fetch or tokenize the bottleneck?), C6/C7 (are the
LRUs actually evicting?), C8 (what fraction of time is the old side?).

### BM5: CPU profile of the daemon

`node --cpu-prof --cpu-prof-dir=/tmp/prof src/daemon.ts` plus a BM3 replay,
inspect in speedscope.  Confirms whether oniguruma tokenization dominates
(expected) or whether parsing/Buffer churn/emission matters too.  Gates:
A3 (worker count sizing), C9 (micro-allocations — only bother if visible).

### BM6: cold-start breakdown

Measure separately, since the fixes differ:

```sh
time node -e ''                                  # node boot floor
time node -e 'await import("shiki")'             # module graph cost
# in-daemon: log timestamps at entry, after configure(), after init_highlighter(), at listen
```

Also measure the client's view: `time (: | tig-syntax-filter)` with the
daemon down (includes spawn + 50 ms-granularity connect retries).  Gates:
B1–B6.

### BM7: tig-side end-to-end

Use the pty test harness (`test/tools/libtest.sh`, see `test/API.adoc`) to
script: open tig on the corpus repo, open the diff of a corpus commit, quit
when loaded; wall-clock it with and without `diff-syntax-filter` set.  This
captures the C-side costs BM2 can't (SGR decode, cell building, style table)
and the busy-poll interaction.  Gates: E1–E3, and validates A-fixes actually
reach the user.

### BM8 (only if BM7 shows C-side time): perf on tig

`perf record -g tig …` while loading the giant highlighted diff; look for
`syntax_style_get`, `diff_common_syntax`, `utf8proc` frames.  Gates: E1, E2.

## Ideas

### A. Kill the giant-commit hang (highest priority)

- **A1. Per-section time budget in the daemon.**  Replace
  `codeToTokensBase()` with a direct per-line tokenization loop against the
  grammar (vscode-textmate's `grammar.tokenizeLine(line, ruleStack,
  timeLimit)` — the same API VS Code uses, including its `timeLimit` /
  `stoppedEarly` support).  Check a deadline (e.g. 300–500 ms per section,
  configurable) between lines; on exceeding it, return null and emit the
  section raw, logging the path and elapsed time.  This converts the size
  limits into the time limit users actually care about, and is the enabler
  for A2, C5, and C8.  Shiki exposes the underlying grammar objects; if its
  public API doesn't, dropping to `vscode-textmate` + `vscode-oniguruma`
  directly is fidelity-neutral (same engine lineage; the plan doc already
  argues this).
- **A2. Yield between line batches.**  With the per-line loop, tokenize N
  lines (or a few ms) per event-loop turn and `await` a microtask/timer
  between batches, so socket reads, other connections, and the idle timer
  stay live even mid-section.  Cheap once A1 exists; removes the
  one-wedged-daemon-starves-every-tig failure mode without threads.
- **A3. Worker-thread pool for tokenization.**  2–4 `worker_threads`, each
  with its own highlighter + grammars; the main thread keeps parsing,
  fetching blobs, and framing.  Gains: parallel sections within a commit,
  parallel connections, and a giant file occupies one worker instead of the
  process.  Costs: per-worker memory (grammar + wasm instance, measure via
  BM5/BM6) and cache duplication unless the SGR line cache stays on the main
  thread (it should: workers return token runs, main thread renders + caches).
  Do after A1/A2 — budgets fix the hang; workers fix throughput.
- **A4. Progressive client fallback.**  Today the 15 s timeout is
  all-or-nothing.  After A1 the daemon guarantees bounded per-section
  latency, so the client's `FRAME_TIMEOUT_MS` can drop to ~2–3 s and become
  a pure liveness check rather than the thing users wait on.  Independent
  smaller change: on timeout, keep the connection and emit only the
  *unacknowledged* spool raw (it already does exactly this) — verify with
  BM3 that partial emission composes with tig's incremental rendering.
- **A5. Heartbeat / progress frames.**  Add a `P <consumed> 0` no-op frame
  the daemon emits between line batches (needs A2) so the client can
  distinguish slow-but-alive from dead and apply a *total* budget (e.g.
  "if the whole diff isn't done in 10 s, go raw for the rest") instead of a
  per-frame one.  Small protocol bump; client change is a few lines in
  `drain_frames`.
- **A6. Configurable knobs.**  Expose the budgets (per-section ms, total ms,
  max last-line to tokenize) via environment or a tiny config file in
  `XDG_CONFIG_HOME/tig-syntax/`, with defaults chosen from BM1 data.  A
  lower `MAX_DOC_LINES`-style default (e.g. 30k) is a blunt but zero-risk
  stopgap that could ship before A1.
- **A7. (Big) Show raw immediately, restyle asynchronously.**  The deep fix
  the user hinted at: tig renders the unfiltered diff instantly and styles
  arrive later.  Two shapes:
  (a) *Two-pass reload*: load the diff with no filter; when loaded, rerun
  through the filter in the background (daemon now has warm caches) and swap
  buffers, restoring position via the existing `diff_save_line`/`OPEN_REFRESH`
  machinery.  Mostly reuses existing view plumbing.
  (b) *Style overlay protocol*: filter emits (line number → style runs)
  instead of full text; tig applies styles to already-loaded lines and
  redraws.  Cleanest UX (no flicker, no double git cost) but the view
  framework has no restyle-after-load mechanism today — real C work in
  `view.c`/`diff.c`.
  Only reach for A7 if A1–A5 still feel bad on the corpus; budgets plus
  warm-cache latencies of 3–6 ms may make it unnecessary.

### B. Faster cold start

- **B1. `module.enableCompileCache()`** first thing in `daemon.ts` (Node ≥ 22;
  this machine runs 26).  One line; caches V8 compilation (including the
  type-stripped TS) across daemon restarts.
- **B2. Bundle the daemon.**  shiki 4's module graph is large; if BM6 shows
  import time matters, esbuild-bundle daemon + deps into one JS file at
  build/install time (the nixpkgs patch already builds this package; add a
  bundle step there and in `bin/tig-syntax-daemon`).  Composes with B1.
- **B3. Listen before shiki is ready.**  `main()` currently awaits
  `init_highlighter()` *before* `server.listen()`, so the client's
  connect-retry loop eats the whole init.  Listen immediately, queue
  connections (or just let sections queue on the init promise), and start
  git blob fetches while the highlighter initializes — cold-start work then
  overlaps instead of serializing.
- **B4. Warm the daemon when tig starts.**  A diff view is almost always
  seconds away once tig is open.  When `diff-syntax-filter` is configured,
  tig (or even the shell profile) can fire `: | tig-syntax-filter &` once at
  startup; the client already spawns the daemon and exits cleanly on empty
  input.  C-side: a one-shot background `io_exec` when the option is first
  resolved in `app_syntax_filter_load` (`src/apps.c`).
- **B5. Stay alive longer / shed instead of exit.**  `IDLE_EXIT_MS` is 30 min;
  every expiry buys the next user a full cold start.  Either raise it a lot
  and *shrink the caches* on idle (drop blob LRU, keep the small SGR line
  cache), or go the whole way: a systemd user socket unit so activation is
  instant and invisible.  The C client needs no changes for socket
  activation (it just connects); ship an example unit in `contrib/`.
- **B6. Grammar preload.**  Persist the recently-used language list in the
  state dir; after listen (B3), load those grammars in the background so the
  first real request doesn't pay `loadLanguage`.  BM4 will show how much
  first-lang loads cost per session.
- **B7. Oniguruma wasm compile.**  Measure it (BM6).  Node has no stable
  cross-run wasm code cache to lean on; if it's big, the only lever is
  keeping the daemon alive (B5).  Note: switching to shiki's JS regex engine
  would help startup but breaks the engine-lineage fidelity goal — rejected.

### C. Warm-path latency (the ~150 ms per new commit)

- **C1. Batch the textconv attribute checks.**  `has_textconv()` (`git.ts`)
  spawns up to two git processes per first-seen path (`check-attr` +
  `config --get`).  A 10-file commit can spawn ~20 processes — plausibly the
  bulk of the 150 ms (BM4 will confirm).  Fix: one persistent
  `git check-attr --stdin -z diff` child per repo (same pattern as
  `blob_batcher`), and cache driver-name → has-textconv per *repo* (one
  `config` call per driver, not per path).
- **C2. Fetch both sides in parallel.**  `highlight_file_section()`
  (`process.ts`) awaits `load_side(old)` then `load_side(new)` sequentially;
  make it `Promise.all`.  Two-line change.
- **C3. Overlap stages across sections.**  The per-connection queue
  serializes everything; instead, kick off blob fetch + textconv for *every*
  parsed section as soon as it arrives (they're I/O-bound and cheap to run
  concurrently), and keep only tokenization + emission in input order.
  Frames must still ack input order, so this is a prefetch inside the
  daemon, not a protocol change.  Pairs well with A3.
- **C4. Normalize the repo identity to the toplevel.**  The client sends its
  cwd, and `git.ts`/`highlight.ts` key *everything* on it: batchers, blob
  LRU, and the tokenization cache identity (`content_identity(cwd, oid)`).
  tig run from a subdirectory gets duplicate batchers and cold caches for
  the same repo — and `check-attr` with repo-relative paths from a subdir
  cwd may even answer for the wrong path (verify!).  Resolve cwd →
  `--show-toplevel` once per connection and use that everywhere; better
  still, key the tokenization cache on the *OID alone* (blobs are
  content-addressed; the repo is irrelevant to tokenization), which also
  gives cross-worktree/clone cache hits for free.
- **C5. Extend cached tokenizations instead of recomputing.**  The line
  cache requires `cached.length >= last_line` (`highlight.ts`) — revisiting
  the same file with a deeper hunk re-tokenizes from line 1.  With the A1
  per-line loop, store the rule stack alongside the cached lines and resume
  from line N.  Same mechanism gives partial-progress reuse after a budget
  abort (a later revisit continues instead of starting over).
- **C6. Grow / re-shape the caches.**  256 cached documents and 128 blobs is
  small for a browsing session; SGR line arrays are much smaller than blobs.
  After BM4 hit-rate data: bound caches by approximate bytes rather than
  entries, and raise the line-cache bound substantially (it's the one that
  turns 150 ms into 5 ms).
- **C7. Persistent on-disk cache.**  Key `oid | lang | EMIT_VERSION |
  theme-hash` → SGR lines, stored via `node:sqlite` (built into this node)
  in `XDG_CACHE_HOME/tig-syntax/`.  Survives daemon restarts and combines
  with B4/B5 so even a cold daemon serves repeat commits instantly.  Needs an
  eviction story (LRU by mtime, size cap) and the usual concurrent-writer
  care (sqlite gives this cheaply).
- **C8. Stop tokenizing the old side twice.**  Both sides of a modified file
  are ~99 % identical, yet each is tokenized fully.  Options, increasing in
  ambition: (a) only tokenize the old side up to its last *deleted* line
  (context lines already map to the new side — check `process.ts` mapping:
  context uses `new_doc`, so the old side is needed only for `-` lines; its
  `last_line` may already be much smaller — verify with BM4 how often old
  side dominates); (b) with the A1 loop, memoize per (line text, entry-state)
  across the two sides so shared prefixes tokenize once.
- **C9. Micro-allocations.**  Double `split("\n")` of the same text
  (`load_side` and `highlight_lines`), per-line Buffer churn in emission,
  latin1 round-trips.  Only touch what BM5 shows; these are likely noise
  next to oniguruma.

### D. Prefetch the next commit

- **D1. tig-driven adjacent-commit prefetch.**  The daemon can't guess the
  next commit (it only ever sees diff text), so prefetch must come from tig.
  In the main view, when the selection settles (debounce ~150 ms) and the
  current diff finished loading, spawn in the background:
  `git show <next-sha> --patch-with-stat … | tig-syntax-filter >/dev/null`
  for selection+1 (and −1), mirroring the diff view's argv.  This warms the
  daemon's blob + line caches, so the subsequent j/k lands on the 3–6 ms
  path.  Gate behind an option (`set diff-prefetch = yes`), kill the
  prefetch child when the selection moves again, and `nice` it.  C work:
  `src/main.c` selection hook + a small background-io helper; no protocol or
  daemon changes at all.
- **D2. Deeper readahead.**  Same mechanism, N commits ahead, budgeted (stop
  when the daemon is busy — trivially observable once A5 heartbeats exist).
  Only if D1 measurably helps and the CPU cost is acceptable; note laptops.

### E. tig C side (expect minor; gated on BM7/BM8)

- **E1. `syntax_style_get` linear scan** (`src/line.c:480`): O(styles) per
  style *run* during parsing, styles capped at 1024.  Fine in theory; hash
  it (there's `map.c`) only if BM8 shows it.
- **E2. `diff_common_syntax` cell building**: per-line box/cell allocation
  and double `strchr(data, 0x1b)` scans (`src/diff.c:524,606`).  Same
  gating.
- **E3. Busy-poll while loading** (`src/display.c` `get_input`, `delay = 0`
  whenever any pipe is live): each iteration is a 500 µs `select` per view
  plus a nonblocking `wgetch`.  During a long daemon stall this spins a core
  doing nothing.  A modest fix: when `update_views()` made no progress,
  raise the wgetch timeout to ~10–20 ms; keystroke latency stays imperceptible
  and the spin disappears.  (Pure UX-during-load; doesn't speed loading.)
- **E4. Blocking-read hazard note** (`io.c` `io_get_line` loops on a
  *blocking* `read` until a full line arrives): safe today because daemon
  frames are line-aligned per section, but a producer stalling mid-line
  would freeze tig's UI, not just the view.  Verify line-alignment with BM3;
  the durable fix is `O_NONBLOCK` view pipes, which would also let E3 poll
  on the pipe fd instead of sleeping.

## Suggested order

1. **BM1–BM4** (instrumentation + corpus; roughly an afternoon).  BM4's
   stage breakdown decides most of what follows.
2. **A1 + A6** — the time budget.  This is the hang fix; ship it first.
3. **C1, C2, C4** — cheap warm-path wins with no architectural risk.
4. **B1, B3, B4** — cheap cold-start wins.
5. **D1** — prefetch; likely the biggest *felt* improvement for j/k browsing
   once warm-path hits are cheap.
6. **A2/A3, C5–C7** — chunking/workers and the cache deepening, sized by the
   numbers.
7. **A7** — only if giant commits still feel bad after budgets + workers.
8. **E-items** — only with BM7/BM8 evidence.
