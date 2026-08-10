#!/bin/sh
# Model-output: Claude Fable 5
# BM9 runner: exercise the C client against each fake-daemon fault mode.
# Usage: run-bm9.sh <client-binary> <input-diff> <out-csv>
# Records, per mode: wall seconds, client exit code, whether the client was
# killed by the 60 s external timeout, stdout bytes, and whether stdout is
# byte-identical to the input (losslessness; inputs contain no ESC bytes, so
# no unframing is needed for the comparison).
set -eu

client=$1; input=$2; out=$3
here=$(dirname "$0")
sock=/tmp/tigbench/bm9.sock
mkdir -p /tmp/tigbench
in_sha=$(sha256sum "$input" | cut -d' ' -f1)
in_bytes=$(wc -c < "$input")

echo "mode,wall_s,exit_code,timed_out,stdout_bytes,lossless" > "$out"
for mode in never-read slow-read read-never-reply trickle huge-frame midframe-close late-reply ack-overrun; do
	rm -f "$sock"
	node "$here/fake-daemon.mjs" "$sock" "$mode" > /tmp/tigbench/bm9-daemon.log 2>&1 &
	daemon_pid=$!
	ok=no
	for _ in $(seq 100); do
		if [ -S "$sock" ]; then
			ok=yes
			break
		fi
		sleep 0.05
	done
	if [ "$ok" = no ]; then
		echo "fake daemon ($mode) never bound $sock" >&2
		exit 1
	fi

	start=$(date +%s.%N)
	set +e
	TIG_SYNTAX_SOCKET=$sock TIG_SYNTAX_DAEMON=/bin/false \
		timeout 60 "$client" < "$input" > /tmp/tigbench/bm9-out.bin 2>/dev/null
	code=$?
	set -e
	end=$(date +%s.%N)
	wall=$(awk "BEGIN { printf \"%.2f\", $end - $start }")

	timed_out=no
	[ "$code" -eq 124 ] && timed_out=yes
	out_bytes=$(wc -c < /tmp/tigbench/bm9-out.bin)
	lossless=no
	if [ "$(sha256sum /tmp/tigbench/bm9-out.bin | cut -d' ' -f1)" = "$in_sha" ]; then
		lossless=yes
	fi
	echo "$mode,$wall,$code,$timed_out,$out_bytes,$lossless" >> "$out"
	kill "$daemon_pid" 2>/dev/null || true
	wait "$daemon_pid" 2>/dev/null || true
done
echo "# input_bytes=$in_bytes input_sha256=$in_sha" >> "$out"
cat "$out"
