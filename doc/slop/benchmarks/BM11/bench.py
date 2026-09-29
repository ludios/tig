#!/usr/bin/env python3
# Model-output: Claude Opus 5.5
"""Time tig under a pty for every {tig, git} x {glibc, mimalloc} combination.

Usage: bench.py <work> <name> <runs> <cwd> <tigrc|-> <mode> [tig args...]

<work> holds the binaries run-bm11.sh builds: tig-base, tig-mi, and the git
shims git-glibc/git and git-mi/git.

<mode> is either "first-screen:<marker>" (time until <marker> appears in the
pty output, then kill tig) or "script:<file>" (TIG_SCRIPT=<file>; time until
tig exits, which for a script ending in :quit covers every view load the
script waits for).  "-" for tigrc keeps the user's own config.

Combinations run in a freshly shuffled order each round after one unmeasured
warmup round, so drift (thermal, page cache) spreads evenly over them.
Output: CSV "bench,tig,git,run,wall_ms" on stdout.
"""

import os
import pty
import random
import select
import signal
import sys
import time

# Longest any single run may take: the slowest bench is ~16 s, so anything
# past this is a hang (e.g. a first-screen marker that never gets drawn).
RUN_TIMEOUT_S = 90

def run_once(cwd, tigrc, mode, tig, git_dir, argv):
	"""One timed tig run.

	cwd: repository to run in.  tigrc: TIGRC_USER path or "-".
	mode: ("first-screen", marker bytes) or ("script", script path).
	tig: tig binary.  git_dir: directory holding the git shim to put first
	on PATH.  argv: extra tig arguments.
	Returns wall milliseconds from fork to the mode's end condition.
	"""
	kind, arg = mode
	start = time.monotonic()
	pid, master = pty.fork()
	if pid == 0:
		os.chdir(cwd)
		os.environ["PATH"] = git_dir + ":" + os.environ["PATH"]
		os.environ["TERM"] = "xterm-direct"
		os.environ["LINES"] = "50"
		os.environ["COLUMNS"] = "160"
		if kind == "script":
			os.environ["TIG_SCRIPT"] = arg
		if tigrc != "-":
			os.environ["TIGRC_USER"] = tigrc
		os.execv(tig, [tig] + argv)
	seen = b""
	status = None
	while True:
		if time.monotonic() - start > RUN_TIMEOUT_S:
			os.kill(pid, signal.SIGKILL)
			os.waitpid(pid, 0)
			sys.exit(f"{tig} {' '.join(argv)}: no result after {RUN_TIMEOUT_S} s ({kind} mode)")
		r, _, _ = select.select([master], [], [], 0.05)
		if master in r:
			try:
				data = os.read(master, 65536)
			except OSError:
				data = b""
			if kind == "first-screen":
				# keep a tail long enough that a marker split across
				# reads is still found
				seen = seen[-len(arg):] + data
				if arg in seen:
					ms = (time.monotonic() - start) * 1000
					os.kill(pid, signal.SIGKILL)
					os.waitpid(pid, 0)
					os.close(master)
					# let the orphaned git log hit EPIPE and exit
					time.sleep(0.3)
					return ms
			if data == b"":
				break
		done, status = os.waitpid(pid, os.WNOHANG)
		if done == pid:
			break
		status = None
	if status is None:
		_, status = os.waitpid(pid, 0)
	ms = (time.monotonic() - start) * 1000
	os.close(master)
	if kind == "first-screen":
		sys.exit(f"tig exited before showing the marker: status {status}")
	if status != 0:
		sys.exit(f"tig exited with status {status}")
	return ms

def parse_mode(spec):
	"""'first-screen:<marker>' or 'script:<file>' -> (kind, arg)."""
	kind, _, arg = spec.partition(":")
	if kind == "first-screen":
		assert arg, "empty marker"
		return (kind, arg.encode())
	if kind == "script":
		assert os.path.isfile(arg), arg
		return (kind, os.path.abspath(arg))
	sys.exit(f"unknown mode {spec!r}")

def main():
	if len(sys.argv) < 7:
		sys.exit(__doc__)
	work, name, runs, cwd, tigrc, mode = sys.argv[1:7]
	mode = parse_mode(mode)
	if tigrc != "-":
		assert os.path.isfile(tigrc), tigrc
		tigrc = os.path.abspath(tigrc)
	argv = sys.argv[7:]
	work = os.path.abspath(work)
	tigs = {"glibc": f"{work}/tig-base", "mi": f"{work}/tig-mi"}
	gits = {"glibc": f"{work}/git-glibc", "mi": f"{work}/git-mi"}
	for path in list(tigs.values()) + [f"{d}/git" for d in gits.values()]:
		assert os.access(path, os.X_OK), path
	combos = [(t, g) for t in tigs for g in gits]
	for t, g in combos:
		run_once(cwd, tigrc, mode, tigs[t], gits[g], argv)
	print("bench,tig,git,run,wall_ms", flush=True)
	for i in range(int(runs)):
		random.shuffle(combos)
		for t, g in combos:
			ms = run_once(cwd, tigrc, mode, tigs[t], gits[g], argv)
			print(f"{name},{t},{g},{i + 1},{ms:.1f}", flush=True)

main()
