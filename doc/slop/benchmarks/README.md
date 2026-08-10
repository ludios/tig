# Benchmark data for doc/slop/performance-ideas.md

Model-output: Claude Fable 5

Raw data collected 2026-08-10; machine and caveats in `environment.txt`.
Benchmark definitions (what gates what) live in `../performance-ideas.md`.
This directory is data + the scripts that produced it; analysis comes later.

- `BM1/` — corpus: `bench-corpus.txt` (the commit list used by every other
  benchmark), `tig-repo-diff-sizes.txt` (2000 tig commits ranked by diff
  bytes), `gen-synthetic.sh` (deterministic synthetic repo generator;
  regenerate with `gen-synthetic.sh /tmp/tigbench/synth`).
- `BM2/` — end-to-end `git show | tig-syntax-filter` latency: `run-bm2.sh`,
  `hyperfine-cold-*.json` (fresh daemon per run), `hyperfine-warm-*.json`
  (steady state), `sequence.csv` (fresh daemon; every corpus commit visited
  twice: first-visit vs revisit).
- `BM3/` — per-frame latency: `frame-profiler.mjs` + `run-bm3.sh`;
  `frames-{first,revisit}-<case>.csv` = one row per protocol frame with ms
  since connect, against the shipped daemon.
- `BM4/` — daemon-internal stage breakdown: `instrumentation.patch` (applied
  to a copy of tools/tig-syntax-filter, at /tmp/tigbench/inst during
  collection), `run-bm4.sh`, `replay.csv` (wall per corpus commit, two
  passes), `sections.log` (per-section JSON: textconv/load/highlight/
  validate/emit ms), `connstats.log` (per-connection cache counters,
  event-loop delay, RSS).
- `BM5/` — CPU profile: `daemon-replay.cpuprofile` (V8 format; load in
  Chrome DevTools or speedscope; covers giant×2 + medium + synth-eof
  replays on the shipped daemon), `top-self-time.txt` (flat self-time
  table extracted from it).
- `BM6/` — cold start: `run-bm6.sh`, `hyperfine-node-boot.json`,
  `hyperfine-import-shiki.json`, `hyperfine-import-graph.json`,
  `daemon-spawn.csv` (launcher exec → socket connectable),
  `daemon-spawn-log.txt` (daemon-side timestamps for those runs),
  `client-cold.csv` (client with daemon down), `hyperfine-client-warm.json`.
- `BM7/` — tig end-to-end under a pty: `pty-timer.py` (TIG_SCRIPT=:quit
  measures load-to-completion), `run-bm7.sh`, `tig-{off,on}-<case>.csv`
  (filter disabled vs enabled, warm daemon, 5 runs each after a priming
  run).
- `BM8/` — perf on tig: `perf-report-{giant-on,giant-off,synth-runs-on}.txt`
  (`perf report --stdio --comms=tig`, call graph, warm daemon+caches),
  `pty-times-*.csv` (wall times of the profiled runs).
- `BM9/` — protocol fault injection: `fake-daemon.mjs` (7 fault modes),
  `run-bm9.sh`, `results.csv` (wall s / exit code / killed-by-60s-timeout /
  output bytes / losslessness per mode, input = the 4.5 MB giant diff).
- `BM10/` — layer decomposition: `echo-daemon.mjs`, `run-bm10.sh`,
  `hyperfine-L{1,2,3,4}-*.json` (git show alone → echo daemon → tokenization
  stubbed → full pipeline), `eld.log` (per-connection event-loop delay from
  the instrumented daemon; L3/L4 phases).
