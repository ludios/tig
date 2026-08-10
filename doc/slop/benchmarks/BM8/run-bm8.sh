#!/bin/sh
# Model-output: Claude Fable 5
# BM8 runner: perf call-graph profiles of tig itself (via the BM7 pty
# harness) for the giant commit (filter on and off) and the runs-per-line
# synthetic (filter on), with a warm daemon and primed caches so the
# profile shows tig's own work, not daemon waits.
# Usage: run-bm8.sh <tig-repo> <synth-repo> <out-dir>
set -eu

repo=$1; synth=$2; out=$3
here=$(dirname "$0")
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/bm8.sock
state=/tmp/tigbench/bm8-state
mkdir -p "$out" "$state"
out=$(realpath "$out")
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

cat > /tmp/tigbench/bm8-off.tigrc <<EOF
set git-colors = no
EOF
cat > /tmp/tigbench/bm8-on.tigrc <<EOF
set diff-syntax-filter = $client
set truecolor = auto
set git-colors = no
color diff-add	default	rgb:22331f
color diff-del	default	rgb:3b2626
EOF

"$here/../kill-sock-daemon.sh" "$sock"
: | "$client" > /dev/null
( cd "$repo" && git show 5294f798 > /tmp/tigbench/bm8-prime.diff )
node "$here/../BM3/frame-profiler.mjs" "$sock" "$repo" /tmp/tigbench/bm8-prime.diff > /dev/null
( cd "$synth" && git show 7bd8be8 > /tmp/tigbench/bm8-prime.diff )
node "$here/../BM3/frame-profiler.mjs" "$sock" "$synth" /tmp/tigbench/bm8-prime.diff > /dev/null

run_perf() { # $1 = case name, $2 = cwd, $3 = tigrc, $4 = sha
	perf record -g --output="/tmp/tigbench/perf-$1.data" -- \
		python3 "$here/../BM7/pty-timer.py" 3 "$2" "$3" "$repo/src/tig" show "$4" \
		> "$out/pty-times-$1.csv" 2>/dev/null
	perf report --input="/tmp/tigbench/perf-$1.data" --stdio --comms=tig \
		--percent-limit=0.3 2>/dev/null | head -80 > "$out/perf-report-$1.txt"
}
run_perf giant-on "$repo" /tmp/tigbench/bm8-on.tigrc 5294f798
run_perf giant-off "$repo" /tmp/tigbench/bm8-off.tigrc 5294f798
run_perf synth-runs-on "$synth" /tmp/tigbench/bm8-on.tigrc 7bd8be8

"$here/../kill-sock-daemon.sh" "$sock"
echo BM8 done
