#!/bin/sh
# Model-output: Claude Fable 5
# BM7 runner: tig end-to-end (pty) with the syntax filter off vs on,
# per corpus commit.  `tig show <sha>` + TIG_SCRIPT=:quit measures load
# to completion.  Warm daemon throughout (daemon cold start is BM6's
# measurement, not BM7's).
# Usage: run-bm7.sh <tig-repo> <synth-repo> <out-dir>
set -eu

repo=$1; synth=$2; out=$3
here=$(dirname "$0")
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
tig=$repo/src/tig
sock=/tmp/tigbench/bm7.sock
state=/tmp/tigbench/bm7-state
mkdir -p "$out" "$state"
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

# Two configs; both keep git-colors=no (this machine's gitconfig would
# otherwise override diff colors and change the drawing path).
cat > /tmp/tigbench/bm7-off.tigrc <<EOF
set git-colors = no
EOF
cat > /tmp/tigbench/bm7-on.tigrc <<EOF
set diff-syntax-filter = $client
set truecolor = auto
set git-colors = no
color diff-add	default	rgb:22331f
color diff-del	default	rgb:3b2626
EOF

"$here/../kill-sock-daemon.sh" "$sock"
: | "$client" > /dev/null   # warm the daemon

corpus() {
	cat <<EOF
small-c $repo d14279ea
many-small $repo 494a4085
medium $repo ff8a7c3a
giant $repo 5294f798
synth-eof $synth ada2b4c
synth-runs $synth 7bd8be8
EOF
}

corpus | while read -r name dir sha; do
	# Prime through the frame profiler: it waits for the E frame, so the
	# daemon's caches are verifiably complete before any timed run (the C
	# client's 15 s timeout would otherwise return early on giant first
	# visits and leave residual daemon work running under the timer).
	( cd "$dir" && git show "$sha" > /tmp/tigbench/bm7-prime.diff )
	node "$here/../BM3/frame-profiler.mjs" "$sock" "$dir" /tmp/tigbench/bm7-prime.diff > /dev/null
	for mode in off on; do
		# one unmeasured pty run per mode for page-cache/tty warmup
		python3 "$here/pty-timer.py" 1 "$dir" "/tmp/tigbench/bm7-$mode.tigrc" "$tig" show "$sha" > /dev/null
		python3 "$here/pty-timer.py" 5 "$dir" "/tmp/tigbench/bm7-$mode.tigrc" "$tig" show "$sha" \
			> "$out/tig-$mode-$name.csv"
	done
done
"$here/../kill-sock-daemon.sh" "$sock"
echo BM7 done
