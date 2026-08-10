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

pkill -f 'tig-syntax-filter/(bin/[.][.]/)?src/daemon[.]ts' 2>/dev/null || true
sleep 0.3
rm -f "$sock"
: | "$client" > /dev/null   # warm the daemon

corpus() {
	cat <<EOF
small-c $repo d14279ea
many-small $repo 494a4085
medium $repo ff8a7c3a
giant $repo 5294f798
synth-eof $synth 1e05977
synth-runs $synth 761f2df
EOF
}

corpus | while read -r name dir sha; do
	for mode in off on; do
		# one unmeasured priming run so "on" measures warm-cache state
		python3 "$here/pty-timer.py" 1 "$dir" "/tmp/tigbench/bm7-$mode.tigrc" "$tig" show "$sha" > /dev/null
		python3 "$here/pty-timer.py" 5 "$dir" "/tmp/tigbench/bm7-$mode.tigrc" "$tig" show "$sha" \
			> "$out/tig-$mode-$name.csv"
	done
done
pkill -f 'tig-syntax-filter/(bin/[.][.]/)?src/daemon[.]ts' 2>/dev/null || true
echo BM7 done
