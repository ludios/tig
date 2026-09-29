# BM11: mimalloc for tig and for the git it spawns

Model-output: Claude Opus 5.5

Question: does linking tig against mimalloc, and/or preloading mimalloc into
the git commands tig runs, make tig faster on a huge repo?  Collected
2026-09-28 on xclank (32 cores), `~/cloned/nixpkgs` at d095bb9fd847
(1,011,374 commits, 23k refs), git 2.54.0, mimalloc 3.3.2.  Config: the
user's own `~/.config/tig/config` (syntax filter and prefetch on, served by
the system profile's tig-syntax-filter through a private daemon; prefetch
never fires in script mode).

Provenance of `results/`: they came from an earlier copy of this harness
(the same measurement code, with `/tmp` paths hard-coded), using tig binaries
built from the working tree at 06c6ff7e.  That tree reported `-dirty`
because another session was editing it.  The C files it committed next
touch the measured paths only through the syntax-filter lookup cache
(`app_syntax_filter_load()` in `src/apps.c`, microseconds per diff open) and
through prefetch, which doesn't run in script mode; `graph-v2.c`, `main.c`,
`diff.c` and `display.c` are unchanged through d80fbb72.  `run-bm11.sh`
builds from `git archive HEAD` instead.  A one-round smoke run of it
reproduced every glibc/glibc median within 3% (except switch-off-0, whose
single ~350 ms sample came out 10% slower), and the per-switch costs
within 1%.

Rerun: `run-bm11.sh <tig-repo> <nixpkgs-repo> <work-dir> <out-dir> [rounds]`.
tig-mi is linked with `-Wl,--no-as-needed -lmimalloc` (checked with
`MIMALLOC_VERBOSE=1`).  The git shims in `gitwrap.c` are identical apart from
`LD_PRELOAD`, so the extra exec cancels out.  Every run is a fresh tig under a
pty; the four combinations run in shuffled order per round after one warmup
round.  Script-mode runs (every bench except first-screen) skip the input
loop's `doupdate()`, so their times leave out terminal output.  The
filter-on switches revisit the same 300 commits that the warmup already
sent through the daemon, so they measure its warm (cached) path.

## Results (medians; full stats in `results/summary.txt`)

| bench | what | glibc/glibc | tig mi | git mi | both |
|-------|------|-------------|--------|--------|------|
| first-screen (n=20) | until the newest commit's subject is drawn | 197.6 ms | −1.3% | −3.0% | −4.7% |
| first-screen, `show-untracked = no` (n=10) | same | 78.1 ms | +0.4% | −6.4% | −3.9% |
| load-nograph (n=5) | all 1M commits, graph off | 6621 ms | −0.2% | −4.3% | −4.3% |
| load-graph-30k (n=5) | `--max-count=30000`, v2 graph | 16352 ms | −1.4% | −0.7% | −1.2% |
| per switch, filter off | `J` in the diff view, 300 switches | 24.2 ms | −0.4% | −2.4% | −0.4% |
| per switch, filter on | same | 51.7 ms | +0.1% | −1.1% | −0.6% |

Same-round pairs sort signal from noise.  Clear effects: git-side on the
graph-off load (−302 ± 29 ms, faster in 10/10 pairs; that's `git log` itself,
since tig keeps up with git there) and tig-side on the graph-on load
(−113 ± 33 ms, 9/10 pairs, about the ~1% malloc share of tig's profile
there).  git-side on switch-on-0 (−14 ± 7 ms) and both sides on the first
screen (about −5 ± 4 ms) sit at ~1–2 standard errors.  Everything else is
noise.

## Verdict

Not worth shipping.  tig-side mimalloc is worth at most ~1%: malloc/free
are ~1% of tig's profile during the graph-on load, the graph-off load is
bound by git, and commit switching mostly is (~16 of 24 ms).  git-side
mimalloc buys up to 6.4% (median, first screen without untracked scan),
mostly in `git log`, `git show` (3.7 → 3.0 ms) and `git describe`
(12.6 → 11.1 ms), and it would mean wrapping every git invocation.

## Where the time actually goes

- Graph-on load: v2 graph symbol generation is O(W²) per row with W ≈ 1000
  lanes on nixpkgs.  See `../../graph-v2-wide-graphs.md`.
- First screen: `git status --untracked-files=normal` runs synchronously in
  `main_check_index()` and takes 143 ms on nixpkgs.
- Per switch (filter off): `git show` 3.7 ms, then a sequential
  `git describe --tags` 12.6 ms (10k tags), then tig's own parsing and screen
  building (terminal output isn't included; see above).
