# BM12: node/V8 flags for the daemon (2026-09-29)

Model-output: Claude Opus 5.5

Question: can any node or V8 command-line flag make the syntax daemon
faster?  Answer: not tokenization; V8's defaults are the best of 14 flag
sets on two CPUs.  The one runtime lever that pays is node's compile cache
at daemon startup, and only in a form that flushes the cache once the
daemon listens (node writes it on clean exit otherwise, which a daemon
killed by signal or logout never reaches).

## Files

- `corpus.txt` — 17 files, 32,501 lines: tig C, the daemon's TS, VS Code
  TS, nixpkgs Nix/shell/Python, this repo's Markdown (checkout revisions in
  its header).
- `tokenize-bench.ts` — imports the daemon's own `highlight.ts`, times
  import, `init_highlighter()`, a first pass over the corpus (grammar loads
  + cold JIT) and further passes (fresh identities, so no line-cache hits).
- `run-bm12.py` — runs it once per flag set per round, shuffled within each
  round; variants are defined in the script.
- `daemon-start.py` — the real daemon: spawn → socket accepting
  (`listen_ms`), and a cold-daemon `git show d14279ea | tig-syntax-filter`
  (`client_ms`), for no cache / `NODE_COMPILE_CACHE` in the environment /
  a bootstrap entry that enables the cache and flushes it after listening.
- `summarize.py` — medians plus paired per-round ratios against the
  baseline variant.
- `results/` — `explore.csv` (xclank) and `zclank-explore.csv` from
  `run-bm12.py ... 4 6`; `daemon-start.csv` (xclank, 15 rounds) and
  `zclank-daemon-start.csv` (12 rounds).

## Machines

- xclank: AMD Ryzen 9 9950X3D (16C/32T), `powersave` governor, node
  26.10.0 (V8 14.6.202.34-node.34).  Load ~3 during the runs (a large rustc
  build had just finished; another session's daemon benchmark was running).
- zclank: Intel i5-12600HX (4P+8E), idle, same node.  `run-bm12.py` pinned
  to the P-cores (`taskset -c 0-7`); `daemon-start.py` unpinned, hence its
  bimodal spread (P- vs E-core scheduling).

## Tokenization (`summarize.py results/explore.csv`)

A CPU profile of the benchmark: 74 % Oniguruma WASM, 20 % shiki JS
(vscode-textmate + the onig glue), 2 % `highlight.ts`, 1.3 % GC.  Median
per-round ratio against no flags (steady = passes 2–6, first = pass 1):

| variant | flags | steady xclank | steady zclank | first xclank |
|---|---|---|---|---|
| semi32 / semi64 | `--max-semi-space-size=32` / `=64` | 1.000 / 1.006 | 1.003 / 1.000 | 1.003 / 0.997 |
| wasm-inline-more | `--wasm-inlining-budget=20000 --wasm-inlining-max-size=2000 --wasm-inlining-factor=6` | 1.011 | 0.998 | 0.996 |
| tier-budget-1m | `--wasm-tiering-budget=1000000` | 1.005 | 1.006 | 1.004 |
| no-lazy-feedback | `--no-lazy-feedback-allocation` | 1.001 | 0.999 | 0.995 |
| always-sparkplug | `--always-sparkplug` | 1.007 | 1.002 | 1.000 |
| no-maglev | `--no-maglev` | 1.001 | 1.003 | 1.015 |
| turbolev | `--turbolev` | 1.028 | 1.011 | 1.016 |
| minor-ms | `--minor-ms` | 1.051 | 1.045 | 1.021 |
| single-gc | `--single-threaded-gc` | 1.115 | — | 1.025 |
| no-wasm-inline | `--no-wasm-inlining` | 1.108 | — | 1.094 |
| no-dyn-tiering | `--no-wasm-dynamic-tiering` | 1.113 | — | 1.098 |
| no-liftoff | `--no-liftoff` | 1.116 | — | 1.259 |
| compile-cache | `NODE_COMPILE_CACHE=dir` | 0.994 | 0.997 | 1.001 |

`--no-wasm-lazy-compilation` does not start at all: shiki's WASM
instantiation never settles and node exits 13 ("unsettled top-level
await").  `--use-largepages` is no longer supported by node 26.

The compile cache is the only variant that moves anything: `import_ms`
26.9 → 16.7 (xclank), 40.6 → 26.1 (zclank).  It also lowered the
benchmark's peak RSS on both machines (378 → 352 MB, 383 → 343 MB);
not investigated.

## Cold start (`summarize.py results/*daemon-start.csv`)

Medians, ms (paired ratio against plain):

| variant | listen xclank | listen zclank | client xclank | client zclank |
|---|---|---|---|---|
| plain | 102.0 | 161.7 | 253.4 | 390.6 |
| `NODE_COMPILE_CACHE` in env | 93.4 (0.915) | 149.4 (0.936) | 205.5 (0.810) | 394.3 (1.008) |
| bootstrap: enable, import, flush | 72.3 (0.711) | 146.8 (0.774) | 200.9 (0.798) | 349.8 (0.894) |

The env-var row is optimistic: its cache was primed by `tokenize-bench.ts`
runs (which exit cleanly), so shiki was cached, while the daemon's own
modules never were, as in real use.  The bootstrap caches the whole
graph.

`client_ms` is quantized by the client's 50 ms `connect()` retry
(`CONNECT_WAIT_MS`): on xclank plain lands on the ~250 ms tick, both cache
variants on ~200 ms, so the end-to-end gain there is the tick, not the
30 ms.  The retry interval costs every cold start ~25 ms on average.
