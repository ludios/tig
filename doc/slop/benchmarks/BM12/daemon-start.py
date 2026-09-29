#!/usr/bin/env python3
# Model-output: Claude Opus 5.5
"""BM12 cold start: the real daemon with and without node's compile cache.

Usage: daemon-start.py <out.csv> <rounds> <repo> <sha>

Variants: plain; NODE_COMPILE_CACHE set in the environment; a bootstrap
entry that enables the cache and flushes it once listening.  Per round, in
shuffled order, for each variant:
  listen_ms  -- spawn `node src/daemon.ts` until its socket accepts;
  client_ms  -- with no daemon running, `git show <sha> | tig-syntax-filter`
                end to end (the client spawns the daemon through a launcher
                carrying the variant's environment).
Daemons run on a private socket and are killed by PID; never touches an
interactive session's daemon.
"""
import csv
import os
import random
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = os.path.normpath(os.path.join(HERE, "../../../../tools/tig-syntax-filter"))
WORK = "/tmp/tig-nodeflags"
SOCK = os.path.join(WORK, "start.sock")

BOOT = os.path.join(WORK, "boot.mjs")
DAEMON = os.path.join(FILTER, "src/daemon.ts")

# name -> (node entry script, extra environment)
VARIANTS = {
	"plain":         (DAEMON, {}),
	"compile-cache": (DAEMON, {"NODE_COMPILE_CACHE": os.path.join(WORK, "compile-cache")}),
	"boot-flush":    (BOOT, {}),
}


def base_env(extra):
	return dict(os.environ, TIG_SYNTAX_SOCKET=SOCK, XDG_STATE_HOME=os.path.join(WORK, "state"), **extra)


def connectable():
	s = socket.socket(socket.AF_UNIX)
	try:
		s.connect(SOCK)
		return True
	except OSError:
		return False
	finally:
		s.close()


def socket_pids():
	"""PIDs listening on SOCK, from ss."""
	out = subprocess.run(["ss", "-xlpH"], capture_output=True, text=True).stdout
	pids = set()
	for line in out.splitlines():
		if SOCK in line:
			for part in line.split("pid=")[1:]:
				pids.add(int(part.split(",")[0]))
	return pids


def stop_daemons():
	for pid in socket_pids():
		os.kill(pid, 15)
	deadline = time.monotonic() + 5
	while socket_pids() and time.monotonic() < deadline:
		time.sleep(0.01)
	if os.path.exists(SOCK):
		os.unlink(SOCK)


def write_boot():
	"""A bootstrap that enables the compile cache before the daemon's
	module graph loads and flushes it once the daemon is listening (the
	daemon's top-level await resolves then); node otherwise writes the
	cache only at a clean exit, which a SIGTERMed daemon never reaches."""
	with open(BOOT, "w") as f:
		f.write(f"""import module from "node:module";
module.enableCompileCache({os.path.join(WORK, "compile-cache-boot")!r});
await import({DAEMON!r});
module.flushCompileCache();
""")


def listen_ms(entry, extra):
	"""Milliseconds from spawning the daemon until its socket accepts."""
	start = time.perf_counter()
	proc = subprocess.Popen(["node", entry], env=base_env(extra),
	                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
	while not connectable():
		if proc.poll() is not None:
			sys.exit(f"daemon exited with {proc.returncode}")
		time.sleep(0.001)
	elapsed = (time.perf_counter() - start) * 1000
	proc.terminate()
	proc.wait()
	stop_daemons()
	return elapsed


def launcher(name, entry, extra):
	"""Write a daemon launcher script for variant `name`; return its path."""
	path = os.path.join(WORK, f"launch-{name}")
	env = "".join(f"{k}={v} " for k, v in extra.items())
	with open(path, "w") as f:
		f.write(f"#!/bin/sh\n{env}exec node {entry}\n")
	os.chmod(path, 0o755)
	return path


def client_ms(name, entry, extra, repo, sha):
	"""Milliseconds for a cold-daemon `git show sha | client` in `repo`."""
	env = base_env({"TIG_SYNTAX_DAEMON": launcher(name, entry, extra)})
	client = os.path.join(FILTER, "bin/tig-syntax-filter")
	start = time.perf_counter()
	subprocess.run(f"git show {sha} | {client} > /dev/null", shell=True, cwd=repo, env=env, check=True)
	elapsed = (time.perf_counter() - start) * 1000
	stop_daemons()
	return elapsed


def main():
	out_path, rounds, repo, sha = sys.argv[1:]
	os.makedirs(WORK, exist_ok=True)
	stop_daemons()
	write_boot()
	# Prime the caches (the env-var one only gets what a SIGTERMed daemon
	# writes, as in real use).
	for name in ("compile-cache", "boot-flush"):
		listen_ms(*VARIANTS[name])
	with open(out_path, "w", newline="") as f:
		writer = csv.writer(f)
		writer.writerow(["round", "variant", "listen_ms", "client_ms"])
		for r in range(int(rounds)):
			order = list(VARIANTS)
			random.shuffle(order)
			for name in order:
				entry, extra = VARIANTS[name]
				row = [r, name, round(listen_ms(entry, extra), 1),
				       round(client_ms(name, entry, extra, repo, sha), 1)]
				writer.writerow(row)
				f.flush()


main()
