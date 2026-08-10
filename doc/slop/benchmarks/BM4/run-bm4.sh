#!/bin/sh
# Model-output: Claude Fable 5
# BM4 runner: replay the corpus through the INSTRUMENTED daemon (see
# instrumentation.patch; built by copying tools/tig-syntax-filter and
# applying the patch) and collect per-section stage timings ("SECTION"
# lines) plus per-connection cache/eld stats ("CONNSTATS" lines).
# Two passes on one fresh daemon: first visit, then revisit.
# Usage: run-bm4.sh <tig-repo> <synth-repo> <inst-dir> <out-dir>
set -eu

repo=$1; synth=$2; inst=$3; out=$4
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/bm4.sock
state=/tmp/tigbench/bm4-state
mkdir -p "$out" "$state"
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

pkill -f 'inst/src/daemon[.]ts --bm4' 2>/dev/null || true
sleep 0.3
rm -f "$sock" "$state/tig-syntax/daemon.log"
node "$inst/src/daemon.ts" --bm4 > /dev/null 2>&1 &
for _ in $(seq 200); do
	[ -S "$sock" ] && break
	sleep 0.05
done

corpus() {
	cat <<EOF
small-c $repo d14279ea
many-small $repo 494a4085
medium $repo ff8a7c3a
medium-ts $repo 6c8431e2
rename $repo ce03d41d
large $repo 87009cb7
giant $repo 5294f798
synth-top $synth 74e60f2
synth-mid $synth 921bbbc
synth-eof $synth ada2b4c
synth-runs $synth 7bd8be8
EOF
}

echo "pass,name,sha,wall_ms" > "$out/replay.csv"
for pass in first revisit; do
	corpus | while read -r name dir sha; do
		start=$(date +%s%N)
		( cd "$dir" && git show "$sha" | "$client" > /dev/null )
		end=$(date +%s%N)
		echo "$pass,$name,$sha,$(( (end - start) / 1000000 ))" >> "$out/replay.csv"
	done
done
sleep 0.5
pkill -f 'inst/src/daemon[.]ts --bm4' 2>/dev/null || true

grep "SECTION '" "$state/tig-syntax/daemon.log" > "$out/sections.log"
grep "CONNSTATS" "$state/tig-syntax/daemon.log" > "$out/connstats.log"
echo "BM4 done: $(wc -l < "$out/sections.log") section lines, $(wc -l < "$out/connstats.log") connections"
