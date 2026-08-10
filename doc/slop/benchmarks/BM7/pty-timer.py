#!/usr/bin/env python3
# Model-output: Claude Fable 5
# BM7: run tig under a pty and time spawn -> exit.
#
# tig runs with TIG_SCRIPT pointing at a script whose only command is :quit.
# Script commands are consumed only once no view is loading (get_input reads
# the script only when delay != 0), so the measured wall time covers the full
# view load including the syntax filter pipeline.
#
# Usage: pty-timer.py <runs> <cwd> <tigrc|-> <tig-binary> [tig args...]
# Output: CSV "run,wall_ms,exit_status" on stdout; drains and discards pty
# output.  "-" for tigrc means no TIGRC_USER override.

import os
import pty
import select
import sys
import tempfile
import time

def run_once(cwd, tigrc, argv):
	"""One timed tig run; returns (wall_ms, exit_status)."""
	script = tempfile.NamedTemporaryFile("w", suffix=".tigscript", delete=False)
	script.write(":quit\n")
	script.close()
	start = time.monotonic()
	pid, master = pty.fork()
	if pid == 0:
		os.chdir(cwd)
		os.environ["TERM"] = "xterm-direct"
		os.environ["TIG_SCRIPT"] = script.name
		os.environ["LINES"] = "50"
		os.environ["COLUMNS"] = "160"
		if tigrc != "-":
			os.environ["TIGRC_USER"] = tigrc
		os.execv(argv[0], argv)
	# Drain output until the child exits; the pty must be read or tig
	# blocks on writes to a full pty buffer.
	while True:
		r, _, _ = select.select([master], [], [], 0.05)
		if master in r:
			try:
				data = os.read(master, 65536)
			except OSError:
				data = b""
			if data == b"":
				break
		done, status = os.waitpid(pid, os.WNOHANG)
		if done == pid:
			# read any final output so the measurement includes it
			while True:
				r, _, _ = select.select([master], [], [], 0.02)
				if master not in r:
					break
				try:
					if os.read(master, 65536) == b"":
						break
				except OSError:
					break
			os.close(master)
			os.unlink(script.name)
			return (time.monotonic() - start) * 1000, status
	done, status = os.waitpid(pid, 0)
	os.close(master)
	os.unlink(script.name)
	return (time.monotonic() - start) * 1000, status

def main():
	if len(sys.argv) < 5:
		print(__doc__, file=sys.stderr)
		sys.exit(2)
	runs = int(sys.argv[1])
	cwd, tigrc, tig = sys.argv[2], sys.argv[3], sys.argv[4]
	argv = [tig] + sys.argv[5:]
	print("run,wall_ms,exit_status")
	for i in range(runs):
		ms, status = run_once(cwd, tigrc, argv)
		print(f"{i + 1},{ms:.1f},{status}")

main()
