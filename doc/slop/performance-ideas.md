# Performance ideas for diff syntax highlighting

Model-output: Claude Fable 5

Status: 2026-08-10 — ideas collected, all gating benchmarks (BM1–BM10)
run (raw data in `benchmarks/`, findings in "Measured results" below, the
implementation order at the end is data-ranked), and **A0, A1, A6, and A8
are implemented**: the hang is fixed from both sides.  A0 gives the client
a hard frame deadline (BM9: every fault mode ends in a lossless raw
fallback).  A1/A6/A8 give the daemon a per-section tokenization budget
(chunked via shiki GrammarState, verified token-identical), env-var knobs,
and streaming raw passthrough for oversized sections — measured on the old
worst cases: giant first visit 15.2 s → **318 ms** (its 4.5 MB section
streams raw while the commit's other files still highlight), synth-eof
14.8 s → **629 ms**, budget-failed revisits fail fast at ~43 ms, normal
commits unchanged.  The remaining ideas are not yet implemented.

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

All the BM benchmarks below have now been run — data in `benchmarks/`
(scripts + raw results per BM folder, environment in
`benchmarks/environment.txt`), findings in the "Measured results" section
after the benchmark definitions.  Earlier anecdotal daemon.log numbers
(3–6 ms cached revisits, ~150 ms warm new commits) are superseded by those
measurements.

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

1. **[BOUNDED by A1] Tokenization is synchronous and unbounded in time.**
   (Since fixed: tokenization now runs in 128-line chunks with a
   per-section budget, default 500 ms — still synchronous per chunk, which
   A2/A3 would address, but no longer unbounded.)
   Original analysis:
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
4. **[FIXED by A0] The client's 15 s timeout was not actually a hard
   timeout.**  The `FRAME_TIMEOUT_MS` poll only covered *waiting for
   frames*; writes to the daemon went through blocking `write_all()`, so a
   daemon wedged in tokenization stopped reading, the socket buffer
   filled, and the client blocked *inside `write()`* forever (BM9
   reproduced it: >60 s with zero output).  A0's rewrite makes the socket
   nonblocking with an absolute deadline; BM9 now measures a lossless raw
   fallback at the deadline for every stall mode.
5. **Even when the timeout does fire, fallback is all-or-nothing**: blank
   diff pane for 15 s, then the whole raw diff dumps in.  And if each
   section completes in under 15 s, the timeout never fires and a 50-file
   commit can trickle for minutes with no fallback at all.
6. **[FIXED by A8] A complete file section is buffered before anything
   happens to it.**  (Since fixed: sections over 1 MB flush immediately
   and stream through raw to the next boundary.)  Original analysis:
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

## Measured results (2026-08-10)

All BMs ran on an idle 12600HX (16 threads, 128 GB); raw data and the exact
scripts in `benchmarks/`.  Corpus: `benchmarks/BM1/bench-corpus.txt` —
notably `5294f798` ("giant", the 4.5 MB utf8proc diff) and a synthetic
99k-line TypeScript file with 1-line edits at line 10 / 50k / ~99k
(synth-top/mid/eof).

### End-to-end filter latency (BM2, `git show | tig-syntax-filter`)

| case          | cold (fresh daemon) | first visit (warm daemon) | revisit | steady state |
|---------------|--------------------:|--------------------------:|--------:|-------------:|
| small-c       |              410 ms |                    215 ms |   11 ms |        11 ms |
| medium        |              855 ms |                    597 ms |   13 ms |        12 ms |
| large         |                   — |                    600 ms |   50 ms |        19 ms |
| many-small    |                   — |                   1135 ms |   30 ms |        19 ms |
| giant         |            15530 ms |                  15189 ms |  141 ms |        73 ms |
| synth-top     |                   — |                     89 ms* |  243 ms |        36 ms |
| synth-mid     |                   — |                   7576 ms |   42 ms |        36 ms |
| synth-eof     |            15236 ms |                  14802 ms |   46 ms |        57 ms |

(first visit/revisit from `sequence.csv`; steady state = hyperfine warm
mean; * = BM4's replay — in BM2's sequence synth-top ran while the daemon
was still finishing the giant's abandoned tokenization and took 1905 ms,
the wedge effect live in the data.)

### Where the time goes

- **Tokenization is 95 % of daemon section time** (BM4, 348 sections:
  41.0 s of 43.3 s; textconv 1.29 s ≈ 3 %, blob loads ≈ 1.5 %, validation
  and emission < 0.5 %).  BM5 CPU profile concurs: oniguruma wasm
  dominates all non-idle self time; the largest JS entry (`color_to_rgb`)
  is 0.5 %.
- **The old side is 51 % of tokenization** (BM4: 20.9 s old vs 20.1 s new).
- **Tokenization rate**: big.ts (regular TS lines) ≈ 75 µs/line;
  `utf8proc_data.c` ≈ 440 µs/line.  Cost scales with hunk depth exactly as
  predicted: synth-top 89 ms → synth-mid 7.6 s → synth-eof 14.8 s.
- **Giant first visit = 15.3 s daemon-side** (BM3, no client timeout in the
  measurement path); the C client's 15 s timeout means real tig gets a raw
  dump at ~15.2 s (BM2 cold/first ≈ 15.2–15.5 s).  Warm revisit 141 ms.
- **Layer decomposition (BM10, warm)**: git show alone ≈ echo daemon
  (≤ 31 ms, so client+protocol overhead is negligible); parse+git-I/O-only
  (stub) 41–57 ms; full warm 35–129 ms.
- **First frame streams at ~1 ms** (BM3) and every frame's payload ended in
  `\n` across the corpus — E4's line-alignment assumption holds.

### The hang, confirmed (BM9, BM10-eld)

- Fake daemon that **accepts but never reads**: client blocked in `write()`
  past a 60 s external kill, **zero bytes of output** — tig would sit on a
  blank pane indefinitely.  Same for slow-read (1 B/5 ms) and for a daemon
  that **trickles response bytes** (1 B/s resets the poll clock forever).
  The 15 s timeout works only for frame-level faults: read-never-reply,
  oversized frame declaration, and late replies all fall back losslessly at
  15.05 s; mid-frame disconnect at 0.13 s.
- The daemon's **event loop stalls for 15.0 s** during the giant
  (`monitorEventLoopDelay` max in BM10's eld.log) — it cannot see socket
  closes, new connections, or timers while tokenizing one section.
- Memory: the instrumented daemon ended the corpus replay at **RSS 1.4 GB**
  (BM4 connstats) — the entry-count-bounded caches happily hold multi-MB
  documents' SGR lines.

### Cold start (BM6) — smaller than assumed

node boot 35 ms; `import("shiki")` 66 ms; full import graph 78 ms; launcher
exec → socket accepting ≈ 190 ms; client-observed cold start (spawn +
50 ms-granularity connect retries) ≈ 213 ms; warm client connect+handshake
7 ms.  The whole cold penalty is ~0.2 s — noticeable, not the problem.

### tig's own cost (BM7 pty medians, BM8 perf)

filter off → on, warm daemon and caches: small-c 54 → 45 ms (noise),
medium 47 → 62 ms, many-small 58 → 73 ms, synth-runs 28 → 56 ms,
**giant 98 → 384 ms** (the 29 MB SGR-expanded section).  perf on the giant
shows `diff_common_syntax` at 3.3 % of tig cycles — the rest of the delta
is spread over io/parse/draw of the 6.5× larger input.  On the
runs-per-line synthetic, `argv_size` alone is 3.2 % of cycles at ≤ 3900
runs/line (E5's quadratic path is real, though bounded at current caps).

### What the data changes about the plan

1. **A0 unchanged as #1** — BM9 is the proof, and it also shows the
   trickle case defeats any per-frame timeout, so the absolute deadline
   (not restarted on progress) is mandatory, not optional.
2. **A1's budget has a clear default**: tokenization runs 75–440 µs/line,
   so a 300–500 ms per-section budget admits roughly 1–6k lines of prefix —
   it sacrifices exactly the cases that today end as a 15 s wait for a raw
   dump anyway (giant, synth-mid/eof), and C5 checkpoints later make those
   progressively highlightable on revisit.
3. **C8 (skip/shrink the old side) is worth ~2× on first visits** — 51 %
   of tokenize time, far more than its earlier "verify with BM4" billing.
4. **C1 (textconv batching) demotes**: 3 % overall, ~350 ms of the
   many-small commit's 1.1 s.  Still cheap and worth doing, but it is not
   "the bulk of the warm 150 ms" — first-visit time is tokenization.
5. **C6 (byte-bounded caches) promotes**: RSS 1.4 GB after one corpus
   replay is not a hypothetical.
6. **B-group demotes overall**: the whole cold start is ~0.2 s (B1/B2 can
   shave at most ~100 ms of import); B4 (warm at tig startup) still makes
   sense as it hides all of it, and B5's idle-exit still costs a daily
   cold start.  B3's listen-before-init matters mostly for the
   thundering-herd case.
7. **D prefetch's payoff is quantified**: j/k first visits cost 0.2–1.1 s
   on ordinary commits vs 10–50 ms revisits; prefetch converts the former
   into the latter.  Still gated on interruptible tokenization (the BM2
   sequence recorded the wedge: a synth-top visit behind the giant's
   abandoned work took 21× longer).
8. **E5 confirmed but modest** at current caps (3.2 % of tig cycles on the
   worst synthetic); fix opportunistically, not urgently.  tig's giant-on
   total (384 ms) is acceptable; A7(b) style spans would reclaim most of
   it if it ever matters.

## Ideas

### A. Kill the giant-commit hang (highest priority)

- **A0. Nonblocking client socket with an absolute deadline.
  [IMPLEMENTED 2026-08-10]** — `client/tig-syntax-filter.c` rewritten as
  described below; the deadline is `TIG_SYNTAX_DEADLINE_MS` (default
  15000).  BM9 after: never-read / slow-read / trickle fall back
  losslessly at 15.03–15.05 s (previously blocked past 60 s with zero
  output); oversized-frame and ack-overrun protocol faults fall back in
  0.03 s; happy-path output is byte-identical (verified on five corpus
  commits incl. the giant) and `test/diff/diff-syntax-test` passes.
  Original idea text: fixes hang
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
- **A1. Per-section time budget in the daemon.
  [IMPLEMENTED 2026-08-10]** — via chunked `codeToTokensBase` +
  `GrammarState` continuation (128-line chunks, verified token-identical
  to one-shot in `test/budget.test.ts`) rather than a per-line
  `tokenizeLine` loop; shiki's own per-line `tokenizeTimeLimit` (500 ms)
  still bounds pathological single lines.  Budget-aborted prefixes are
  cached (they serve shallower hunks) and the failure depth is
  remembered for fail-fast (the C10-scoped negative cache).  Original
  idea text: replace
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
- **A6. Configurable knobs. [IMPLEMENTED 2026-08-10]** — as environment
  variables read at daemon start (`src/config.ts`): `TIG_SYNTAX_BUDGET_MS`
  (default 500), `TIG_SYNTAX_MAX_LINES` (bounds the required hunk depth,
  default 100k), `TIG_SYNTAX_MAX_SECTION_BYTES` (A8's threshold, default
  1 MB); documented in the filter README.  A total-ms-per-connection knob
  was deliberately skipped: with per-section budgets each section streams
  its frame promptly, so the client-side deadline (A0) covers liveness.
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
  them through raw. [IMPLEMENTED 2026-08-10]** — `section_splitter` takes a
  byte threshold; a file section crossing it flushes immediately as an
  "oversized" section and streams line-aligned raw chunks (one per feed)
  until the next `diff --git`, with `process_section` passing them through
  untouched.  Fixes hang cause 6.  Original idea text:  Track cheap counters during
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
  `config --get`).  Measured (BM4): ~3.7 ms per first-seen section, 3 % of
  daemon section time overall, ~350 ms of the 94-file commit's 1.1 s —
  real but secondary to tokenization.  Fix: one persistent
  `git check-attr --stdin -z diff` child per repo (same pattern as
  `blob_batcher`), and cache driver-name → has-textconv per *repo* (one
  `config` call per driver, not per path).
- **C2. Fetch both sides in parallel. [IMPLEMENTED 2026-08-10]**
  `highlight_file_section()` now fetches both sides via `Promise.all`
  (loads measured at ~1.5 % of section time, so this is hygiene, not a
  headline win).
- **C3. Overlap stages across sections.**  The per-connection queue
  serializes everything; instead, kick off blob fetch + textconv for *every*
  parsed section as soon as it arrives (they're I/O-bound and cheap to run
  concurrently), and keep only tokenization + emission in input order.
  Frames must still ack input order, so this is a prefetch inside the
  daemon, not a protocol change.  Pairs well with A3.
- **C4. Normalize the repo identity to the toplevel.
  [IMPLEMENTED 2026-08-10]** — `repo_info(cwd)` resolves (once, cached)
  the absolute common git dir, worktree toplevel, and object format via a
  single `rev-parse`.  Batchers and the blob cache key on the common dir
  (worktrees sharing an object store share them), attribute checks run
  from — and cache by — the toplevel (the subdir wrong-path bug was real;
  now unit-tested), `content_matches_oid` hashes only the repo's actual
  algorithm, and the line cache keys on the **full OID echoed by
  cat-file** (never the diff's abbreviated one), making tokenization
  results shared across worktrees, clones, and repositories.  Measured: a
  linked worktree's "first visit" of the medium commit costs 196 ms vs
  597 ms for a true first visit — blobs and tokenization are shared; the
  residual is the per-worktree textconv spawns (C1's territory, and
  correctly per-worktree since attributes can differ).  Original idea
  text: the client sends its
  cwd, and `git.ts`/`highlight.ts` key *everything* on it: batchers, blob
  LRU, and the tokenization cache identity (`content_identity(cwd, oid)`).
  tig run from a subdirectory gets duplicate batchers and cold caches for
  the same repo — and `check-attr` with repo-relative paths from a subdir
  cwd may even answer for the wrong path (verified real).  Resolve cwd →
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
- **C6. Byte-bound (then grow) the caches. [IMPLEMENTED 2026-08-10]** —
  a shared `byte_lru` (approximate sizing, entries over half the budget
  not cached) now backs the line cache and blob cache, budgeted by
  `TIG_SYNTAX_LINE_CACHE_MB` / `TIG_SYNTAX_BLOB_CACHE_MB` (64 MB each by
  default).  Measured: daemon RSS after a double corpus replay is
  **~410 MB** (was 1.4 GB under the entry-count LRUs), with warm revisits
  unregressed (~8 ms).  Original rationale: SGR line arrays for big
  documents dwarf their source (every style run adds a ~20-byte escape
  plus JS string/array overhead), so entry counts let a few giants own
  memory; byte budgets track what matters.
- **C7. Persistent on-disk cache.**  Key `oid | lang | EMIT_VERSION |
  theme-hash` → SGR lines, stored via `node:sqlite` (built into this node)
  in `XDG_CACHE_HOME/tig-syntax/`.  Survives daemon restarts and combines
  with B4/B5 so even a cold daemon serves repeat commits instantly.  Needs an
  eviction story (LRU by mtime, size cap) and the usual concurrent-writer
  care (sqlite gives this cheaply).
- **C8. Load and tokenize only the sides a hunk actually needs.
  [(a) IMPLEMENTED 2026-08-10; (b) still open.]**  The parser now records
  the deepest row each side actually styles (old = last `-` row, new =
  last `+`/context row; 0 = side unused), and `process.ts` skips fetching
  a side entirely at 0 — a pure-addition section never touches the old
  blob.  **Measured honestly: wall-clock on the corpus is neutral to
  slightly better** (small-c 90 → 81 ms first visit; pathological cases
  unchanged because A1's budget already caps them).  The original "~2×
  from the old side's 51 %" billing over-credited (a): in replace-heavy
  diffs the last deleted row ≈ the hunk end anyway, and in addition-heavy
  hunks the old header range was already small.  The remaining
  cross-side savings need (b) — memoize per (line text, entry-state)
  across the two sides with the A1 chunk loop so the ~99 %-identical
  sides tokenize once — but note the pre-A1 51 % figure no longer
  transfers: under the shared A1 budget, the sections dominating that
  aggregate abort the old side before the new side starts, leaving (b)
  nothing to eliminate there.  Ordinary sections measured the old side
  at 42–46 % of tokenization; re-measure on post-A1 traces before
  building.  What (a) does deliver: the section budget reaches deeper on
  mixed content, addition-only sections skip a blob fetch + decode, and
  the side-need accounting (b) requires now exists.
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

## Suggested order (updated with the measured data)

The benchmarks (step 1 of the original order) are done; BM9's never-reads
fake daemon is ready to become the CI regression test for A0.

1. **A0 — DONE (2026-08-10)** — nonblocking client writes with an
   absolute, non-restarting deadline; see the A0 entry for the measured
   before/after.  The daemon can no longer block tig, only delay
   highlighting until the deadline lands the raw fallback.
2. **A1 + A6 + A8 — DONE (2026-08-10)** — per-section budget (500 ms
   default), env knobs, and streaming passthrough.  Measured: giant
   15.2 s → 318 ms, synth-eof 14.8 s → 629 ms, failed-budget revisits
   ~43 ms, sub-second commits untouched; "raw within ~0.5 s" achieved.
3. **C8(a) + C2 — DONE (2026-08-10)** — precise per-side needs (skip
   unused sides, bound old at the last deleted row) and parallel fetches.
   Measured neutral-to-slightly-better wall clock; the 51 %-of-tokenization
   recovery turns out to require C8(b) (cross-side memoization), which
   remains open and gated on a profitability check.
4. **C6 + C4 — DONE (2026-08-10)** — byte-bounded caches (RSS 1.4 GB →
   ~410 MB on the same replay) and canonical identities (common-dir-keyed
   batchers/blobs, full-OID line-cache keys shared across worktrees and
   clones, toplevel-scoped attribute checks fixing a real subdir
   wrong-path bug, single-algorithm hashing).
5. **A2 (or A3) + A9** — interruptible tokenization (the event loop
   measured 15 s deaf) and daemon backpressure.
6. **D0/D1 prefetch** — first visits cost 0.2–1.1 s on ordinary commits vs
   10–50 ms revisits; once tokenization is interruptible, prefetching
   selection±1 makes j/k feel like the revisit numbers.  Measure D0's
   natural reuse first.
7. **C5/C5b + C8(b) — checkpoint/resume, visible-lines-only rendering,
   cross-side memoization** — three extensions of the same A1 chunk loop.
   C5's grammar-state checkpoints turn the linear-in-depth cost (89 ms →
   7.6 s → 14.8 s across synth-top/mid/eof) into resumable work; C5b
   shrinks the cache bytes C6 has to budget; and C8(b) — memoizing
   tokenization per (line text, entry state) across a file's two
   ~99 %-identical sides — is the remaining path to cross-side savings
   (C8(a) measured neutral; see the C8 entry).  Its payoff must be
   re-measured on post-A1 traces before building: the pre-A1 "51 %"
   aggregate was dominated by sections whose old side now exhausts the
   shared budget before the new side even starts (nothing left to
   memoize there); on ordinary non-pathological sections the old side
   measured 42–46 % of tokenization, so think "up to ~1.7×" on sections
   where both sides actually run, not 2× overall.
8. **C1, B4, B5, C10–C12** — textconv batching (3 %), startup warming
   (cold start measured at only ~0.2 s, so the rest of B demotes), negative
   cache, emission slimming, batch-command preflight.
9. **A3 workers / A7 style spans** — only if the above leaves giant
   commits feeling bad; tig's own giant-on cost is 384 ms (BM7), so A7(b)
   is a last-mile improvement, not a necessity.  E5 (`argv_size` at 3.2 %
   of tig cycles on the worst synthetic) rides along with any E-work, not
   urgently.
