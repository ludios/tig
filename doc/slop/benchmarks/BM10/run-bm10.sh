#!/bin/sh
# Model-output: Claude Fable 5
# BM10 runner: layer decomposition over selected corpus commits.
#   L1 git-show      git show alone
#   L2 echo          client + protocol-conformant echo daemon (no work)
#   L3 stub          instrumented daemon with TIG_SYNTAX_STUB_TOKENIZE=1
#                    (parse + git I/O + decode, no tokenization)
#   L4 full          instrumented daemon, full pipeline
# Event-loop delay per connection comes from the instrumented daemon's
# CONNSTATS lines; this script snapshots them into eld.log.
# Usage: run-bm10.sh <tig-repo> <synth-repo> <inst-dir> <out-dir>
set -eu

repo=$1; synth=$2; inst=$3; out=$4
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/bm10.sock
state=/tmp/tigbench/bm10-state
here=$(dirname "$0")
mkdir -p "$out" "$state"
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

kill_daemons() {
	pkill -f 'bm10-daemon-tag' 2>/dev/null || true
	pkill -f "echo-daemon[.]mjs $sock" 2>/dev/null || true
	sleep 0.3
	rm -f "$sock"
}
wait_sock() {
	for _ in $(seq 200); do
		[ -S "$sock" ] && return 0
		sleep 0.05
	done
	echo "daemon did not come up" >&2
	exit 1
}
start_inst() {
	# $1 = extra env assignment or empty; tag argv for targeted pkill
	env $1 node "$inst/src/daemon.ts" --bm10-daemon-tag > /dev/null 2>&1 &
	wait_sock
}

corpus() {
	cat <<EOF
medium $repo ff8a7c3a
giant $repo 5294f798
synth-eof $synth 1e05977
EOF
}

# L1: git show alone.
corpus | while read -r name dir sha; do
	hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-L1-gitshow-$name.json" \
		"cd $dir && git show $sha > /dev/null"
done

# L2: echo daemon.
kill_daemons
node "$here/echo-daemon.mjs" "$sock" > /dev/null 2>&1 &
wait_sock
corpus | while read -r name dir sha; do
	hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-L2-echo-$name.json" \
		"cd $dir && git show $sha | $client > /dev/null"
done

# L3: stubbed tokenization.
kill_daemons
rm -f "$state/tig-syntax/daemon.log"
start_inst "TIG_SYNTAX_STUB_TOKENIZE=1"
corpus | while read -r name dir sha; do
	hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-L3-stub-$name.json" \
		"cd $dir && git show $sha | $client > /dev/null"
done

# L4: full pipeline (same daemon build, tokenization on).
kill_daemons
start_inst ""
corpus | while read -r name dir sha; do
	hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-L4-full-$name.json" \
		"cd $dir && git show $sha | $client > /dev/null"
done
kill_daemons

grep 'CONNSTATS' "$state/tig-syntax/daemon.log" > "$out/eld.log" || true
echo "BM10 done; CONNSTATS lines: $(wc -l < "$out/eld.log")"
