# BM11: mimalloc for tig and for the git it spawns

Model-output: Claude Opus 5.5

Question: does linking tig against mimalloc, and/or preloading mimalloc into
the git commands tig runs, make tig faster on a huge repo?  Collected
2026-09-28 on xclank (32 cores), `~/cloned/nixpkgs` at d095bb9fd847
(1,011,374 commits, 23k refs), git 2.54.0, mimalloc 3.3.2.  tig was built
from the working tree at 06c6ff7e, which reported `-dirty` because another
session was editing it.  The C files that session committed next
(`src/apps.c`, `src/prefetch.c`, `src/line.c`) are off the measured paths,
and `graph-v2.c`, `main.c`, `diff.c` and `display.c` are unchanged through
d80fbb72.  Config: the user's own `~/.config/tig/config`
(syntax filter and prefetch on, served by the system profile's
tig-syntax-filter through a private daemon; prefetch never fires in script
mode).

Rerun: `run-bm11.sh <tig-repo> <nixpkgs-repo> <work-dir> <out-dir> [rounds]`.
tig-mi is linked with `-Wl,--no-as-needed -lmimalloc` (checked with
`MIMALLOC_VERBOSE=1`).  The git shims in `gitwrap.c` are identical apart from
`LD_PRELOAD`, so the extra exec cancels out.  Every run is a fresh tig under a
pty; the four combinations run in shuffled order per round after one warmup
round.

## Results (medians; full stats in `results/summary.txt`)

| bench | what | glibc/glibc | tig mi | git mi | both |
|-------|------|-------------|--------|--------|------|
| first-screen (n=20) | until the newest commit's subject is drawn | 197.6 ms | −1.3% | −3.0% | −4.7% |
| first-screen, `show-untracked = no` (n=10) | same | 78.1 ms | +0.4% | −6.4% | −3.9% |
| load-nograph (n=5) | all 1M commits, graph off | 6621 ms | −0.2% | −4.3% | −4.3% |
| load-graph-30k (n=5) | `--max-count=30000`, v2 graph | 16352 ms | −1.4% | −0.7% | −1.2% |
| per switch, filter off | `J` in the diff view, 300 switches | 24.2 ms | −0.4% | −2.4% | −0.4% |
| per switch, filter on | same | 51.7 ms | +0.1% | −1.1% | −0.6% |

First-screen sd is 13–20 ms, so its differences are within ~2 standard errors.
The only effect clearly above noise is git-side mimalloc on the graph-off full
load (−285 ms, with sd 20–130 ms).  That's `git log` itself getting faster:
tig keeps up with git there.

## Verdict

Not worth shipping.  tig-side mimalloc does nothing measurable: malloc/free
are ~1% of tig's profile during the graph-on load, the graph-off load is
bound by git, and commit switching mostly is (~16 of 24 ms).  git-side
mimalloc buys 1–5%, mostly in `git log`, `git show` (3.7 → 3.0 ms) and
`git describe` (12.6 → 11.1 ms), and that would mean wrapping every git
invocation.

## Where the time actually goes

- Graph-on load: v2 graph symbol generation is O(W²) per row with W ≈ 1000
  lanes on nixpkgs.  See `../../graph-v2-wide-graphs.md`.
- First screen: `git status --untracked-files=normal` runs synchronously in
  `main_check_index()` and takes 143 ms on nixpkgs.
- Per switch (filter off): `git show` 3.7 ms, then a sequential
  `git describe --tags` 12.6 ms (10k tags), then tig's own parsing and drawing.
