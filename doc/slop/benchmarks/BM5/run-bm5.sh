#!/bin/sh
# Model-output: Claude Fable 5
# BM5 runner: CPU-profile the SHIPPED daemon over a replay (giant x2 to get
# both cold-cache and warm-cache samples, plus medium and synth-eof).
# --cpu-prof flushes only on clean exit, so the daemon runs under a wrapper
# that process.exit(0)s after a fixed window.
# Usage: run-bm5.sh <tig-repo> <synth-repo> <out-dir>
set -eu

repo=$1; synth=$2; out=$3
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/bm5.sock
state=/tmp/tigbench/bm5-state
window_ms=90000
mkdir -p "$out" "$state"
out=$(realpath "$out")
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

here=$(dirname "$0")
"$here/../kill-sock-daemon.sh" "$sock"

node --cpu-prof --cpu-prof-dir="$out" --cpu-prof-name=daemon-replay.cpuprofile \
	--input-type=module \
	-e "setTimeout(() => process.exit(0), $window_ms); import('file://$repo/tools/tig-syntax-filter/src/daemon.ts');" &
daemon_pid=$!
ok=no
for _ in $(seq 200); do
	if [ -S "$sock" ]; then
		ok=yes
		break
	fi
	sleep 0.05
done
if [ "$ok" = no ] || ! kill -0 "$daemon_pid" 2>/dev/null; then
	echo "profiled daemon never bound $sock" >&2
	exit 1
fi

( cd "$repo" && git show 5294f798 | "$client" > /dev/null ) || true
( cd "$repo" && git show 5294f798 | "$client" > /dev/null ) || true
( cd "$repo" && git show ff8a7c3a | "$client" > /dev/null ) || true
( cd "$synth" && git show ada2b4c | "$client" > /dev/null ) || true
echo "replays done; waiting up to $((window_ms / 1000))s for profile flush"
wait "$daemon_pid" || true

python3 - "$out/daemon-replay.cpuprofile" > "$out/top-self-time.txt" <<'EOF'
# Self-time table from the .cpuprofile (sum of sample deltas per node).
import json, sys
p = json.load(open(sys.argv[1]))
nodes = {n["id"]: n for n in p["nodes"]}
self_us = {}
for sample, delta in zip(p["samples"], p["timeDeltas"]):
	self_us[sample] = self_us.get(sample, 0) + delta
rows = []
for nid, us in self_us.items():
	cf = nodes[nid]["callFrame"]
	name = cf["functionName"] or "(anonymous)"
	url = cf["url"].split("/")[-1] if cf["url"] else ""
	rows.append((us, f"{name} [{url}:{cf.get('lineNumber', -1)}]"))
rows.sort(reverse=True)
total = sum(us for us, _ in rows)
print(f"total sampled: {total/1e6:.2f}s")
print(f"{'self_ms':>10}  {'pct':>6}  function")
for us, name in rows[:40]:
	print(f"{us/1000:10.1f}  {us/total*100:5.1f}%  {name}")
EOF
echo BM5 done
