#!/bin/sh
# Model-output: Claude Fable 5
# BM6 runner: cold-start breakdown.
#   node-boot         node -e '' floor
#   import-shiki      module-graph cost of `import("shiki")`
#   import-graph      full daemon import graph (import daemon deps, no listen):
#                     measured via `node --cpu-prof`-free timing of the import
#                     statement set: shiki + logtape + @logtape/file
#   daemon-spawn      launcher exec -> socket connectable (external walltime)
#   daemon-log-gap    "highlighter ready" -> "listening" from the daemon log
#   client-cold       `: | client` with daemon down (spawn + connect retries)
#   client-warm       `: | client` with daemon up (connect + handshake only)
# Usage: run-bm6.sh <tig-repo> <out-dir>
set -eu

repo=$1; out=$2
filter_dir=$repo/tools/tig-syntax-filter
client=$filter_dir/bin/tig-syntax-filter
sock=/tmp/tigbench/bm6.sock
state=/tmp/tigbench/bm6-state
mkdir -p "$out" "$state"
out=$(realpath "$out")   # the import benchmarks cd into the package dir
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

here=$(CDPATH= cd -P "$(dirname "$0")" && pwd)   # absolute: survives the cd below
kill_daemon() {
	"$here/../kill-sock-daemon.sh" "$sock"
}

# 1. node boot floor and import costs (hyperfine, from the package dir so
# module resolution matches the daemon's).
cd "$filter_dir"
hyperfine --warmup 2 --runs 10 --export-json "$out/hyperfine-node-boot.json" \
	"node -e ''"
hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-import-shiki.json" \
	"node --input-type=module -e 'await import(\"shiki\")'"
hyperfine --warmup 1 --runs 5 --export-json "$out/hyperfine-import-graph.json" \
	"node --input-type=module -e 'await Promise.all([import(\"shiki\"), import(\"@logtape/logtape\"), import(\"@logtape/file\")])'"

# 2. daemon spawn -> socket connectable, 5 samples (external wall clock, 1 ms
# polling), plus the daemon's own log timestamps for the same runs.
rm -f "$state/tig-syntax/daemon.log"
echo "sample,spawn_to_socket_ms" > "$out/daemon-spawn.csv"
for i in 1 2 3 4 5; do
	kill_daemon
	start=$(date +%s%N)
	"$filter_dir/bin/tig-syntax-daemon" > /dev/null 2>&1 &
	while [ ! -S "$sock" ]; do
		sleep 0.001
	done
	end=$(date +%s%N)
	echo "$i,$(( (end - start) / 1000000 ))" >> "$out/daemon-spawn.csv"
done
cp "$state/tig-syntax/daemon.log" "$out/daemon-spawn-log.txt"

# 3. client with daemon down vs up.
kill_daemon
echo "sample,client_cold_ms" > "$out/client-cold.csv"
for i in 1 2 3; do
	kill_daemon
	start=$(date +%s%N)
	: | "$client" > /dev/null
	end=$(date +%s%N)
	echo "$i,$(( (end - start) / 1000000 ))" >> "$out/client-cold.csv"
done
: | "$client" > /dev/null
hyperfine --warmup 2 --runs 10 --export-json "$out/hyperfine-client-warm.json" \
	": | $client > /dev/null"
kill_daemon
echo BM6 done
