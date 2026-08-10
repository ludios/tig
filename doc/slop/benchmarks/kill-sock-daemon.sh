#!/bin/sh
# Model-output: Claude Fable 5
# Kill the process(es) listening on unix socket path $1, and remove the
# socket file.  Scoped: never touches daemons on other sockets (e.g. an
# interactive tig session's daemon on the default socket).
set -eu

sock=$1
pids=$(ss -xlp 2>/dev/null | grep -F "$sock" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
if [ -n "$pids" ]; then
	kill $pids 2>/dev/null || true
	sleep 0.3
fi
rm -f "$sock"
