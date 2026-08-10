# Performance ideas for diff syntax highlighting

Model-output: Claude Fable 5

Status: idea collection, 2026-08-10.  Nothing here is implemented; each idea
names the code it would touch.  Benchmark before optimizing — the section
"Benchmarks to run first" defines the measurements that gate the ideas.

Incorporates the strongest findings from the independent review in
`raw-proposals/alt-performance-ideas.md` (notably the empirically-reproduced
client write-stall, the `5294f798` reproducer, streaming raw passthrough,
grammar-state checkpoints, and the C-side fragment-builder hot path); that
document also contains a deeper benchmark/telemetry matrix and acceptance
criteria worth consulting when the implementation work starts.

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

Several compounding causes.  (Causes 4 and 6 and the reproducer commit come
from the independent review in `raw-proposals/alt-performance-ideas.md`,
which verified the write-stall empirically against a fake daemon; the rest
were confirmed directly in the code.)

An in-repo reproducer: commit `5294f798` ("Update utf8proc to v2.10.0") —
a 4.5 MB diff, 31k diff lines, whose ~4.5 MB section for
`compat/utf8proc_data.c` has short lines and both sides under the 100k-line
limit, so every current static guard admits it, and whose final hunk sits
near the end of both ~17k-line sources so nearly all of both files gets
tokenized.  It is also the *last* section of the diff, which triggers cause
6 below.

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
4. **The client's 15 s timeout is not actually a hard timeout.**  The
   `FRAME_TIMEOUT_MS` poll only covers *waiting for frames*; the client's
   writes to the daemon go through blocking `write_all()`
   (`client/tig-syntax-filter.c`, the daemon write in the poll loop).  When
   the daemon's event loop is busy tokenizing it stops reading its socket;
   once the kernel socket buffer fills, the client blocks *inside
   `write()`* and never reaches its timeout.  The alt-review reproduced
   this: against a same-UID fake daemon that accepts but never reads, the
   client was still blocked after 18 s.  This is a correctness-level
   responsiveness bug, not a tuning problem.
5. **Even when the timeout does fire, fallback is all-or-nothing**: blank
   diff pane for 15 s, then the whole raw diff dumps in.  And if each
   section completes in under 15 s, the timeout never fires and a 50-file
   commit can trickle for minutes with no fallback at all.
6. **A complete file section is buffered before anything happens to it.**
   `section_splitter` (`diff_parser.ts`) only releases a section at the next
   `diff --git` boundary or EOF, so the 4.5 MB final section of `5294f798`
   is retained in full — a long silent wait plus a memory spike — before
   `process_section()` even starts.
7. Meanwhile tig busy-polls (`get_input` in `src/display.c` sets `delay = 0`
   while any view has a live pipe), burning a core on top of the daemon's
   tokenizer.  Keys still work, but the machine is pegged and the pane is
   empty — indistinguishable from a hang.

The fix directions are in section A below; the short version is: make the
client's daemon socket **nonblocking with an absolute deadline**, convert
the size limits into a **time budget**, make tokenization **interruptible /
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

This repo already provides three of the corpus points (identified by the
alt-review):

| Revision   | Characteristic                                              |
| ---------- | ----------------------------------------------------------- |
| `494a4085` | 94 small files; exposes per-path and per-process overhead   |
| `ff8a7c3a` | 16 files, ~122 KB; representative medium feature commit     |
| `5294f798` | 4.5 MB generated-C diff, hunks to EOF; the stall reproducer |

### BM2: end-to-end filter latency, cold vs warm

```sh
# cold: kill the daemon between runs.  The launcher execs
# "node .../src/daemon.ts", so the live process has no "tig-syntax-daemon"
# in its argv; match the script path, bracket-escaped so the pattern never
# matches the pkill/hyperfine command lines themselves.
hyperfine --prepare 'pkill -f "[t]ig-syntax-filter/src/daemon\.ts"; sleep 0.2' \
	'git -C <repo> show <sha> | tig-syntax-filter > /dev/null'
# warm: run once to prime, then measure
hyperfine --warmup 2 'git -C <repo> show <sha> | tig-syntax-filter > /dev/null'
```

(`hyperfine` via `nix-shell -p hyperfine`, or a plain `time` loop.)  Gates:
everything in sections A–C; this is the headline number.  Verify the prepare
step actually kills the daemon (check the log for a fresh "listening" line);
a cleaner alternative is resolving the PID of whatever owns the bench socket
via `ss -xlp src <socket>` and killing that.

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
`syntax_style_get`, `diff_common_syntax`, `argv_appendn`, `utf8proc` frames.
Gates: E1, E2, E5.  For E5 specifically, add a synthetic case: single lines
with 10 / 100 / 500 / 1000 / 4000 style transitions (the daemon permits up
to `MAX_RUNS_PER_LINE` = 4000).

### BM9: protocol fault injection (regression tests, not just benchmarks)

Small fake daemons that: accept but never read (the reproduced write-stall
case — make this one a CI regression test in `test/`); read one byte every
few ms; read everything but never reply; trickle a partial response forever;
declare an oversized frame; disconnect mid-frame; reply just after the
deadline.  Assert the client emits lossless raw output within its deadline
and exits 0 in every case.  Gates: A0, A4, A5 — this is what makes "stalls
impossible" verifiable rather than hoped.

### BM10: layer decomposition

When comparing before/after, run the corpus through the pipeline in layers
so a win in one layer isn't hidden by another: (1) `git show` alone, (2)
client + a trivial echo daemon, (3) daemon with tokenization stubbed out
(parse + git I/O only), (4) full daemon, (5) full tig via the BM7 pty
harness.  Also record daemon event-loop delay (`perf_hooks.monitorEventLoopDelay`)
during the giant-commit run — the direct measure of "does one section starve
everything else" that A2/A3 must drive to ~zero.

### Acceptance criteria (calibrate exact numbers on this machine)

- No client write or wait can exceed an absolute foreground deadline; a
  pathological section starts rendering *raw* within a few hundred ms (p95).
- Rapid j/j/j navigation cancels stale daemon work promptly (A2/A3), and
  speculative work never increases foreground p95 (D-items).
- Warm small/medium commits don't regress; stripping the injected SGR *and*
  unescaping the literal-ESC marker yields the input bytes exactly (the
  invariant documented in `process.ts` — plain SGR-stripping alone would
  eat the `ESC[999m` markers that stand in for literal ESC bytes).

## Ideas

### A. Kill the giant-commit hang (highest priority)

- **A0. Nonblocking client socket with an absolute deadline.**  Fixes hang
  cause 4, the verified write-stall.  Set the daemon socket `O_NONBLOCK` and
  drive *both* directions through the existing `poll()` loop: request
  `POLLOUT` while spool bytes remain unsent (tracking an offset instead of
  `write_all`), `POLLIN` as today, and compute each poll timeout from an
  **absolute deadline** on the oldest unacknowledged input (no restarting
  the clock on partial progress, which would let a byte-trickling daemon
  stretch a request forever).  On deadline: close, emit `spool[acked..]`
  raw.  Once reliable, the deadline should drop from 15 s toward hundreds
  of milliseconds for foreground use.  Add the missing protocol bounds
  while in there: max declared frame length, max inbox size, max
  unacknowledged bytes — and validate each frame's `consumed` count
  (overflow-safe `consumed <= sent - acked`) so a buggy or version-skewed
  daemon can't push `acked` past the spool and make the fallback silently
  drop input; give BM9 a fault case for exactly that.  This is the single highest-priority change in
  this document — it is a correctness fix that no daemon-side improvement
  can substitute for, and it makes every later budget actually enforceable
  from the client's side.
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
  lines (or a few ms) per event-loop turn and yield with a *macrotask*
  (`setImmediate` / timer — a microtask would drain the next batch before
  node ever returns to libuv, keeping I/O starved), so socket reads, other
  connections, and the idle timer stay live even mid-section.  Cheap once A1 exists; removes the
  one-wedged-daemon-starves-every-tig failure mode without threads.
- **A3. Worker thread(s) for tokenization.**  Move shiki + oniguruma into a
  `worker_threads` worker; the main thread keeps sockets, parsing, blob
  fetching, scheduling, and framing.  Start with **one** long-lived worker:
  that already makes the event loop permanently responsive (same effective
  CPU concurrency as today) without duplicating shiki/wasm/grammar RSS per
  worker; grow to 2 (foreground + speculative) only on measurement.  Two
  properties only workers can provide: a **hard** deadline — the main
  thread can `terminate()` a worker stuck inside a single pathological
  oniguruma call, which no in-thread `Promise.race` or per-line check can
  interrupt — and **cancellation**: when tig kills the client on
  navigation, today the daemon can't even observe the socket close until
  tokenization returns; with a worker (or A2's yielding), disconnect
  cancels queued and in-flight work for that connection instead of
  finishing it invisibly.  Keep the SGR line cache on the main thread
  (workers return token runs; main thread renders + caches).  Do after
  A1/A2 — budgets fix the hang; workers fix responsiveness under load.
- **A4. Progressive client fallback.**  Today the 15 s timeout is
  all-or-nothing.  After A1 the daemon guarantees bounded per-section
  latency, so the client's `FRAME_TIMEOUT_MS` can drop to ~2–3 s and become
  a pure liveness check rather than the thing users wait on.  (Note the
  timeout fallback today *closes* the daemon connection before emitting
  `spool[acked..]` raw; any "go raw but keep the connection for later
  sections" variant would receive `O` frames for input already emitted raw
  and duplicate it in tig — that variant needs explicit frame-discard
  semantics in the protocol, it is not a small tweak.)
- **A5. Heartbeat / progress frames.**  Add a `P` keepalive frame the daemon
  emits between line batches (needs A2) so the client can distinguish
  slow-but-alive from dead and apply a *total* budget (e.g. "if the whole
  diff isn't done in 10 s, go raw for the rest") instead of a per-frame one.
  Important: a heartbeat must **not** carry/advance the consumed-input count
  — `acked` may only advance when the corresponding output bytes have
  actually been emitted, otherwise a later fallback would skip those input
  bytes and truncate the diff.  Small protocol bump; client change is a few
  lines in `drain_frames`.
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
  warm-cache latencies of 3–6 ms may make it unnecessary.  (The alt-review
  argues (b) > (a): a full-view reload risks cursor/scroll/flicker
  complications that line-level style spans avoid — and spans would also
  delete the E5 fragment-building hot path outright, since styles stop
  being escape sequences embedded in text.  A middle step: per-*hunk*
  output frames instead of per-file sections, which improves first paint
  and peak memory without changing tig at all.)
- **A8. Detect oversized sections while they're still arriving, and stream
  them through raw.**  Fixes hang cause 6.  Track cheap counters during
  parsing (section bytes, diff lines, largest source line referenced by a
  hunk headers-so-far); when a threshold trips, don't keep buffering:
  flush the already-buffered prefix as raw output, switch the splitter into
  a passthrough mode that streams chunks unchanged until the next
  `diff --git` boundary, then resume normal parsing.  Passthrough frames
  must stay *line-aligned*: hold back a trailing partial line until its
  newline (or EOF) arrives, or the client hands tig a partial line and
  trips the E4 blocking-read hazard.  Turns the 4.5 MB
  `5294f798` section into a fast raw render with flat memory, instead of a
  silent buffer-up followed by a doomed (or budget-aborted) highlight
  attempt.  Also cache the negative decision keyed by content identity +
  lang + budget version, so reopening the same pathological file doesn't
  re-attempt (see C10).
- **A9. Honor socket backpressure in the daemon.**  `handle_connection`
  ignores `socket.write()`'s boolean; a slow/stalled client lets output
  buffer without bound in the daemon.  Stop dequeuing sections when a write
  returns false, resume on `'drain'`, pause input parsing when queued bytes
  exceed a cap, and bound the per-connection queue by *bytes*, not section
  count (ten 100-byte sections and ten 5 MB sections are not the same
  backlog).

### B. Faster cold start

- **B1. V8 compile cache** (Node ≥ 22; this machine runs 26): caches
  compilation (including the type-stripped TS) across daemon restarts.  It
  must be enabled *before* the module graph loads — a
  `module.enableCompileCache()` call inside `daemon.ts` runs after all its
  static imports (shiki included) are already compiled and caches nothing
  useful.  Either export `NODE_COMPILE_CACHE=<dir>` from
  `bin/tig-syntax-daemon`, or make the entry point a tiny bootstrap that
  enables the cache and then dynamically imports the real daemon.
- **B2. Bundle the daemon / fine-grained shiki imports.**  shiki 4's module
  graph is large; if BM6 shows import time matters, either esbuild-bundle
  daemon + deps into one JS file at build/install time (the nixpkgs patch
  already builds this package; add a bundle step there and in
  `bin/tig-syntax-daemon`), or switch to shiki's documented fine-grained
  core setup (`shiki/core` + only the oniguruma engine, the one theme, and
  lazy per-language grammar imports) so the default bundle's full
  theme/grammar registry never loads.  Composes with B1; measure both
  import-to-listen and first-language latency, since dozens of tiny dynamic
  imports can trade startup for first-use cost.
- **B3. Listen before shiki is ready.**  `main()` currently awaits
  `init_highlighter()` *before* `server.listen()`, so the client's
  connect-retry loop eats the whole init.  Listen immediately, queue
  connections (or just let sections queue on the init promise), and start
  git blob fetches while the highlighter initializes — cold-start work then
  overlaps instead of serializing.  Binding first also closes a thundering-
  herd hole: today several simultaneous cold clients each spawn a daemon
  that fully loads shiki + wasm + theme before all but one lose the
  bind race and exit.
- **B4. Warm the daemon when tig starts.**  A diff view is almost always
  seconds away once tig is open.  When `diff-syntax-filter` is configured,
  tig (or even the shell profile) can fire `: | tig-syntax-filter &` once at
  startup; the client already spawns the daemon and exits cleanly on empty
  input.  C-side placement matters: `app_syntax_filter_load` (`src/apps.c`)
  is only called from `diff_init_highlight`, i.e. when the first diff is
  already opening — too late, and a warm-up client would race the real one.
  Hook the one-shot background spawn right after startup configuration is
  loaded (post-tigrc, in `src/tig.c`), fire-and-forget.
- **B5. Stay alive longer / shed instead of exit.**  `IDLE_EXIT_MS` is 30 min;
  every expiry buys the next user a full cold start.  Either raise it a lot
  and *shrink the caches* on idle (drop blob LRU, keep the small SGR line
  cache), or go the whole way: systemd user socket activation so startup is
  invisible.  The C client needs no changes (it just connects), but the
  *daemon* does: it currently ignores inherited descriptors, calls
  `server.listen(path)`, and treats `EADDRINUSE` as "another daemon is
  live" and exits — under a socket unit that owns the path it would exit
  every activation.  The idea includes `LISTEN_FDS`/fd-3 handling in
  `daemon.ts` plus an example unit in `contrib/`.
- **B6. Grammar preload.**  Persist the recently-used language list in the
  state dir; after listen (B3), load those grammars in the background so the
  first real request doesn't pay `loadLanguage`.  BM4 will show how much
  first-lang loads cost per session.
- **B7. Oniguruma wasm compile.**  Measure it (BM6).  Node has no stable
  cross-run wasm code cache to lean on; if it's big, the only lever is
  keeping the daemon alive (B5).  Note: switching to shiki's JS regex engine
  would help startup but breaks the engine-lineage fidelity goal — rejected.
- **B8. Remove the launcher's retry quantization.**  The client polls
  `connect()` at 50 ms intervals for up to 3 s, so cold start rounds up to
  the next tick.  With B3 (bind before heavy imports) the window shrinks a
  lot on its own; to eliminate it, have `spawn_daemon()` pass a pipe the
  daemon closes once listening (readiness signal), or lean on B5's socket
  activation.  Longer term: tig could hold one persistent daemon connection
  itself, dropping the per-view client process + connect entirely — only
  worth it if BM2's layer numbers show the per-view setup actually costs
  something.

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
  gives cross-worktree/clone cache hits for free.  Caveat for OID-only keys:
  the `index` OIDs in `git show` output are *abbreviated* and unique only
  within one repository — a cross-repo key must use the full OID (echoed by
  `cat-file --batch` in its response header, so it's free to capture) or a
  hash of the fetched content, never the abbreviated prefix.  Applies to
  C7's persistent cache too.  Refinements from the alt-review: the right
  canonical key differs by cache — the common *git object directory* for
  object caches (worktrees sharing one object store then share entries) vs
  the worktree root for worktree-content caches; and detect the repo's hash
  algorithm once per repo so `content_matches_oid` (`process.ts`) stops
  hashing every worktree file under *both* sha1 and sha256.
- **C5. Extend cached tokenizations instead of recomputing.**  The line
  cache requires `cached.length >= last_line` (`highlight.ts`) — revisiting
  the same file with a deeper hunk re-tokenizes from line 1.  With the A1
  per-line loop, store the rule stack alongside the cached lines and resume
  from line N; go further and keep **periodic grammar-state checkpoints**
  (every ~128–256 lines — shiki even exposes this as `GrammarState`), so a
  later hunk resumes from the nearest checkpoint rather than only from the
  exact previous stopping point, and extending line 5,000 → 5,300 scans 300
  lines instead of 5,300.  Same mechanism gives partial-progress reuse
  after a budget abort.  Sizing note: checkpoints trade memory for rescan
  distance; pick the interval from the BM1 synthetic hunk-position cases.
  One honest limit: a *cold* hunk at the end of a big file still needs the
  full prefix scanned once — checkpoints make revisits and extensions
  cheap, they don't replace the A1 budget for first encounters.
- **C5b. Materialize styles only for diff-visible lines.**  Tokenizing the
  prefix is required for grammar state, but *rendering* it isn't: today the
  daemon builds an SGR string for every prefix line, though the diff shows
  only a subset.  With the per-line loop, advance state through
  non-referenced lines and discard their tokens immediately; build style
  runs/SGR only for lines a hunk actually maps.  Cuts allocation and cache
  bytes sharply for the common small-hunk-late-in-big-file case (caveat:
  make the line cache store "state + sparse rendered lines" rather than a
  dense array, or C5/C6 accounting breaks).
- **C6. Grow / re-shape the caches.**  256 cached documents and 128 blobs is
  small for a browsing session.  Don't assume SGR line arrays are small,
  though: every style run adds a ~20-byte escape sequence plus JS
  string/array overhead, so a heavily-tokenized document's cached lines can
  exceed the source blob several-fold.  After BM4 hit-rate data *and* a
  resident-memory measurement: bound both caches by approximate bytes rather
  than entry count, then raise the line-cache byte budget (it's the cache
  that turns 150 ms into 5 ms) to whatever memory target seems fair for a
  long-lived daemon.
- **C7. Persistent on-disk cache.**  Key `oid | lang | EMIT_VERSION |
  theme-hash` → SGR lines, stored via `node:sqlite` (built into this node)
  in `XDG_CACHE_HOME/tig-syntax/`.  Survives daemon restarts and combines
  with B4/B5 so even a cold daemon serves repeat commits instantly.  Needs an
  eviction story (LRU by mtime, size cap) and the usual concurrent-writer
  care (sqlite gives this cheaply).
- **C8. Load and tokenize only the sides a hunk actually needs.**  Both
  sides of a modified file are ~99 % identical, yet each is tokenized fully.
  The precise need (context lines already map to `new_doc` in `process.ts`):
  the old side serves only `-` lines, so (a) set its `last_line` to the last
  *deleted* row, not the end of the last old hunk — and skip fetching the
  old blob entirely for addition-only sections (and the new side for pure
  deletions); (b) with the A1 loop, memoize per (line text, entry-state)
  across the two sides so shared prefixes tokenize once.  Verify with BM4
  how often the old side dominates before doing (b).
- **C9. Memory traffic / micro-allocations.**  Only touch what BM5 shows,
  but the alt-review's inventory is worth keeping: double `split("\n")` of
  the same text (`load_side` and `highlight_lines`) — one newline-offset
  index instead; validation building a per-line body string and `Map` per
  hunk line; per-line `Buffer.from("\n")` allocations and one giant
  `Buffer.concat` per section in emission; quadratic carry growth in
  `diff_parser.ts` when a single *line* spans many chunks with no newline
  (complete lines are consumed per `feed`, so only an unterminated line —
  e.g. a giant minified one — accumulates and gets re-concatenated per
  chunk; cap the carry size);
  `pending.shift()` and `Buffer.subarray` retaining large backing buffers
  in `blob_batcher`; the client never compacting its acknowledged spool
  prefix (the 64 MB cap counts total bytes, not unacknowledged bytes).
- **C10. Negative cache + in-flight coalescing.**  Cache the *decisions*,
  not just the data, so reopening a pathological or unhighlightable file
  doesn't rediscover the failure — but key each verdict by what it actually
  depends on: invalid-UTF-8/binary is content-global (identity alone);
  budget-exceeded depends on the *requested prefix* too (a hunk near EOF
  blowing the budget must not suppress a later cheap hunk near the top of
  the same file — key by identity + last-line bucket + budget version);
  no-grammar depends on language + grammar version; textconv on repo +
  path + config, as already cached.  And keep promise maps for in-flight blob fetches, language
  loads, and document tokenizations so two views (or two tig instances)
  requesting the same thing share one computation instead of both missing
  the cache.  Minor cousin: `ensure_lang` calls
  `getLoadedLanguages().includes()` per section — keep a `Set` plus an
  in-flight map.
- **C11. Precompute and slim the SGR emission.**  `style_sequence()`
  re-parses hex colors and rebuilds the escape string for every token;
  memoize `(color, fontStyle) → sequence` (a handful of distinct values per
  theme).  Then benchmark *differential* emission — emit only what changed
  (using 22/23/24 attribute resets) instead of a full reset + set per run.
  This shortens each escape and its C-side parse but does *not* reduce the
  number of escapes or tig cells: the emitter already writes one sequence
  per style change, and tig makes one cell per inter-escape span.  Cell
  count only drops via run *coalescing* (merging adjacent runs whose
  rendered style is identical, e.g. colors that quantize to the same
  terminal color — which only tig's side of the pipeline can know).  Weigh
  both against decoder complexity.
- **C12. `cat-file --batch-command` preflight.**  Switch the batcher to
  `--batch-command` and issue `info` before `contents`: oversized blobs get
  rejected from the size in the info reply *without* transferring or —
  as the code does today — killing the whole batcher child and failing
  every pending request.  The info reply also supplies the full OID for
  C4's canonical cache keys, and old/new info requests pipeline naturally.

### D. Prefetch the next commit

- **D0. First measure how much comes free from content-addressed caching.**
  One commit's new side is often the next one's old side, so once caches
  are keyed by full OID (C4) and resumable (C5), plain j/k navigation may
  hit warm state for many sections.  But don't over-assume: the daemon
  only ever requests OIDs for *changed* paths, so unchanged files generate
  no requests at all, and consecutive commits touching disjoint paths
  share nothing.  Measure the overlap of *requested* full OIDs between
  consecutive diffs (BM4 counters) before building explicit prefetch; D1
  is only worth its complexity for the residual misses.
- **D1. tig-driven adjacent-commit prefetch.**  The daemon can't guess the
  next commit (it only ever sees diff text), so prefetch must come from tig.
  In the main view, when the selection settles (debounce ~150 ms) and the
  current diff finished loading, spawn in the background:
  `git show <next-sha> --patch-with-stat … | tig-syntax-filter >/dev/null`
  for selection+1 (and −1), mirroring the diff view's argv.  This warms the
  daemon's blob + line caches, so the subsequent j/k lands on the 3–6 ms
  path.  Gate behind an option (`set diff-prefetch = yes`) and kill the
  prefetch child when the selection moves again.  C work: `src/main.c`
  selection hook + a small background-io helper.  Caveat: killing or
  `nice`ing the *client* does not touch the work already queued in the
  long-lived daemon — with today's synchronous tokenizer even the
  socket-close callback can't run mid-section, so prefetching a giant
  commit would delay the foreground diff it was meant to accelerate.
  Sequence D1 *after* A2 (interruptible tokenization: cancel on
  disconnect between batches) or A3 (workers), and consider a protocol
  priority bit so foreground requests preempt prefetch ones.
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
- **E5. The fragment-builder is quadratic in style runs per line** (spotted
  by the alt-review; verified).  In the syntax path `context->skip` is
  true, so *every* style fragment goes through `argv_appendn`
  (`src/diff.c:131`), and `argv_appendn` calls `argv_size` — a linear scan
  to the terminating NULL (`src/argv.c:223`) — plus one `strndup` per
  fragment, then `argv_to_string_alloc` re-joins the lot.  O(R²) pointer
  scanning for R runs, with R allowed up to `MAX_RUNS_PER_LINE` = 4000: a
  token-dense minified line is a credible tig-side stall.  Fix: build the
  stripped text into one growing buffer alongside the cell array (the cell
  lengths already delimit the fragments; the argv detour adds nothing).
  BM8's synthetic runs-per-line case quantifies it.
- **E3. Busy-poll while loading** (`src/display.c` `get_input`, `delay = 0`
  whenever any pipe is live): each iteration is a 500 µs `select` per view
  plus a nonblocking `wgetch`.  During a long daemon stall this spins a core
  doing nothing.  A modest fix: when `update_views()` made no progress,
  raise the wgetch timeout to ~10–20 ms; keystroke latency stays imperceptible
  and the spin disappears.  (Pure UX-during-load; doesn't speed loading.)
- **E4. Blocking-read hazard note** (`io.c` `io_get_line` loops on a
  *blocking* `read` until a full line arrives): safe today because daemon
  frames are line-aligned per section, but a producer stalling mid-line
  would freeze tig's UI, not just the view.  Verify line-alignment with BM3.
  The durable fix is `O_NONBLOCK` view pipes — but note that flipping the
  flag alone is not enough: `io_read` currently retries `EAGAIN` in a tight
  loop, so `io_get_line` would spin instead of block on a partial line.
  The real change is: preserve the partial buffer, return control to the
  event loop on `EAGAIN`, and resume after polling the fd — which is also
  exactly what E3 needs to poll on pipe fds instead of sleeping.

## Suggested order

1. **BM1–BM4 + BM9** (instrumentation, corpus, fault-injection regression
   tests; roughly a day).  BM4's stage breakdown decides most of what
   follows; BM9's never-reads fake daemon is the regression test for the
   next item.
2. **A0** — nonblocking client writes with an absolute deadline.  The
   verified correctness bug; without it every other budget is advisory.
3. **A1 + A6 + A8** — the time budget and streaming raw passthrough.
   Together with A0 this is the hang fix.
4. **C1, C2, C4** — cheap warm-path wins with no architectural risk.
5. **B1, B3, B4** — cheap cold-start wins.
6. **A2 (or A3) + A9, then D0/D1** — interruptible tokenization and daemon
   backpressure, then measure natural cache reuse before deciding whether
   explicit prefetch is still needed; prefetch is likely the biggest *felt*
   improvement for j/k browsing if D0's numbers say it's not already free.
7. **A3, C5/C5b, C6–C12** — workers and the cache/emission deepening, sized
   by the numbers.
8. **A7** — only if giant commits still feel bad after budgets + workers;
   prefer the style-span variant (b), possibly via the per-hunk-frames
   middle step.
9. **E-items** — only with BM7/BM8 evidence (E5 is the one most likely to
   clear that bar).
