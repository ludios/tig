#!/bin/sh
# Model-output: Claude Fable 5
# BM3 runner: per-frame latency profile against the SHIPPED daemon.
# For each corpus commit: dump the diff, then profile two passes on one
# fresh daemon — "first" (cold caches) and "revisit" (warm caches).
# Usage: run-bm3.sh <tig-repo> <synth-repo> <out-dir>
set -eu

repo=$1; synth=$2; out=$3
here=$(dirname "$0")
sock=/tmp/tigbench/bm3.sock
state=/tmp/tigbench/bm3-state
mkdir -p "$out" "$state" /tmp/tigbench/diffs
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

"$here/../kill-sock-daemon.sh" "$sock"
: | "$repo/tools/tig-syntax-filter/bin/tig-syntax-filter" > /dev/null

corpus() {
	cat <<EOF
small-c $repo d14279ea
many-small $repo 494a4085
medium $repo ff8a7c3a
medium-ts $repo 6c8431e2
large $repo 87009cb7
giant $repo 5294f798
synth-top $synth 74e60f2
synth-mid $synth 921bbbc
synth-eof $synth ada2b4c
synth-runs $synth 7bd8be8
EOF
}

corpus | while read -r name dir sha; do
	diff_file=/tmp/tigbench/diffs/$name.diff
	( cd "$dir" && git show "$sha" > "$diff_file" )
	for pass in first revisit; do
		node "$here/frame-profiler.mjs" "$sock" "$dir" "$diff_file" \
			> "$out/frames-$pass-$name.csv"
	done
done
"$here/../kill-sock-daemon.sh" "$sock"
echo BM3 done
