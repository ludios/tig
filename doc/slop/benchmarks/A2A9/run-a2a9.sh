#!/bin/sh
# Model-output: Claude Fable 5
# A2/A9 acceptance runner.  Prints the two metrics for the CURRENT daemon
# code; run before and after a change to compare.
#   concurrent: latency of a warm small request issued 120 ms into another
#               connection's synth-eof budget burn (5 samples, fresh daemon
#               each: the burn only happens with cold caches)
#   backpressure: input accepted by the daemon from a never-reading client
# Usage: run-a2a9.sh <tig-repo> <synth-repo>
set -eu

repo=$1; synth=$2
here=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
client=$repo/tools/tig-syntax-filter/bin/tig-syntax-filter
sock=/tmp/tigbench/a2a9.sock
state=/tmp/tigbench/a2a9-state
mkdir -p /tmp/tigbench "$state"
export TIG_SYNTAX_SOCKET=$sock XDG_STATE_HOME=$state

( cd "$synth" && git show ada2b4c > /tmp/tigbench/a2a9-eof.diff )
( cd "$repo" && git show d14279ea > /tmp/tigbench/a2a9-small.diff )

echo "== concurrent latency (A2): small warm request during a budget burn"
for i in 1 2 3 4 5; do
	"$here/../kill-sock-daemon.sh" "$sock"
	: | "$client" > /dev/null
	# prime B (small) so its revisit is cache-warm
	( cd "$repo" && git show d14279ea | "$client" > /dev/null )
	node "$here/concurrent-latency.mjs" "$sock" "$synth" /tmp/tigbench/a2a9-eof.diff \
		"$repo" /tmp/tigbench/a2a9-small.diff
done

echo "== backpressure (A9): never-reading client pushing 32 MB"
"$here/../kill-sock-daemon.sh" "$sock"
: | "$client" > /dev/null
node "$here/backpressure.mjs" "$sock" "$repo" 32
"$here/../kill-sock-daemon.sh" "$sock"
