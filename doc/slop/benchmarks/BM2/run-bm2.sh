#!/bin/sh
# Model-output: Claude Fable 5
# BM2 runner: end-to-end `git show | tig-syntax-filter` latency, cold vs warm,
# plus a two-pass sequence run (warm daemon: first visit, then cache-hit).
# Usage: run-bm2.sh <tig-repo> <synth-repo> <out-dir>
# Uses the SHIPPED daemon/client from <tig-repo>/tools/tig-syntax-filter on an
# isolated socket.  hyperfine JSON goes to <out-dir>/hyperfine-*.json, the
# sequence pass to <out-dir>/sequence.csv.
set -eu

repo=$1; synth=$2; out=$3
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/bm2.sock
state=/tmp/tigbench/bm2-state
mkdir -p "$out" "$state"
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

kill_daemon() {
	pkill -f 'tig-syntax-filter/(bin/[.][.]/)?src/daemon[.]ts' 2>/dev/null || true
	sleep 0.3
	rm -f "$sock"
}
warm_daemon() {
	: | "$client" > /dev/null
}

run_case() {
	# $1 = case name, $2 = repo dir, $3 = sha, $4 = "cold" | "warm"
	if [ "$4" = cold ]; then
		hyperfine --runs 5 --export-json "$out/hyperfine-cold-$1.json" \
			--prepare "pkill -f 'tig-syntax-filter/(bin/[.][.]/)?src/daemon[.]ts' || true; sleep 0.3; rm -f $sock" \
			"cd $2 && git show $3 | $client > /dev/null"
	else
		warm_daemon
		hyperfine --warmup 2 --runs 10 --export-json "$out/hyperfine-warm-$1.json" \
			"cd $2 && git show $3 | $client > /dev/null"
	fi
}

# --- corpus (keep in sync with ../BM1/bench-corpus.txt) ---
# name repo sha
corpus() {
	cat <<EOF
small-c $repo d14279ea
many-small $repo 494a4085
medium $repo ff8a7c3a
medium-ts $repo 6c8431e2
rename $repo ce03d41d
large $repo 87009cb7
giant $repo 5294f798
synth-top $synth f2cd76d
synth-mid $synth 74d67b9
synth-eof $synth 1e05977
synth-runs $synth 761f2df
EOF
}

# 1. Cold starts (subset: daemon boot dominates; 5 runs each).
for c in "small-c $repo d14279ea" "medium $repo ff8a7c3a" "giant $repo 5294f798" "synth-eof $synth 1e05977"; do
	set -- $c
	kill_daemon
	run_case "$1" "$2" "$3" cold
done

# 2. Warm daemon, per-commit steady state (caches primed by warmup runs).
kill_daemon
warm_daemon
corpus | while read -r name dir sha; do
	run_case "$name" "$dir" "$sha" warm
done

# 3. Sequence: fresh daemon, visit every corpus commit once (first-visit
# latency), then again (cache-hit latency).
kill_daemon
warm_daemon
echo "pass,name,sha,wall_ms" > "$out/sequence.csv"
for pass in first revisit; do
	corpus | while read -r name dir sha; do
		start=$(date +%s%N)
		( cd "$dir" && git show "$sha" | "$client" > /dev/null )
		end=$(date +%s%N)
		echo "$pass,$name,$sha,$(( (end - start) / 1000000 ))" >> "$out/sequence.csv"
	done
done
kill_daemon
cat "$out/sequence.csv"
