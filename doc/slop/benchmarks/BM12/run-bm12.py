#!/usr/bin/env python3
# Model-output: Claude Opus 5.5
"""BM12 runner: tokenize-bench.ts under each node flag set, interleaved.

Usage: run-bm12.py <out.csv> <rounds> <passes> <variant>...

Each round runs every named variant once, in a fresh shuffled order, so
load drift on a shared machine spreads across variants instead of biasing
one.  Rows are appended to <out.csv> as they finish.  Variants are defined
in VARIANTS below: node argv flags plus extra environment.
"""
import csv
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = "/tmp/tig-nodeflags/compile-cache"

# name -> (node flags, extra environment)
VARIANTS = {
	"base":             ([], {}),
	"semi32":           (["--max-semi-space-size=32"], {}),
	"semi64":           (["--max-semi-space-size=64"], {}),
	"minor-ms":         (["--minor-ms"], {}),
	"single-gc":        (["--single-threaded-gc"], {}),
	"no-liftoff":       (["--no-liftoff"], {}),
	"tier-budget-1m":   (["--wasm-tiering-budget=1000000"], {}),
	"no-dyn-tiering":   (["--no-wasm-dynamic-tiering"], {}),
	"wasm-inline-more": (["--wasm-inlining-budget=20000", "--wasm-inlining-max-size=2000",
	                      "--wasm-inlining-factor=6"], {}),
	"no-wasm-inline":   (["--no-wasm-inlining"], {}),
	"no-lazy-feedback": (["--no-lazy-feedback-allocation"], {}),
	"turbolev":         (["--turbolev"], {}),
	"no-maglev":        (["--no-maglev"], {}),
	"always-sparkplug": (["--always-sparkplug"], {}),
	"compile-cache":    ([], {"NODE_COMPILE_CACHE": CACHE_DIR}),
}

FIELDS = ["round", "variant", "entry_ms", "import_ms", "init_ms", "first_ms",
          "steady_ms", "steady_min_ms", "lines", "max_rss_mb"]


def run_variant(name, passes):
	"""Run the benchmark once under variant `name` with `passes` passes;
	return its parsed JSON result."""
	flags, extra_env = VARIANTS[name]
	env = dict(os.environ, **extra_env)
	cmd = ["node", *flags, os.path.join(HERE, "tokenize-bench.ts"),
	       os.path.join(HERE, "corpus.txt"), str(passes)]
	out = subprocess.run(cmd, env=env, check=True, capture_output=True, text=True).stdout
	return json.loads(out.strip().splitlines()[-1])


def main():
	out_path, rounds, passes, *names = sys.argv[1:]
	rounds, passes = int(rounds), int(passes)
	unknown = [n for n in names if n not in VARIANTS]
	if unknown or not names:
		sys.exit(f"unknown or no variants: {unknown}; known: {' '.join(VARIANTS)}")
	# Prime the compile cache so the variant measures a warm cache.
	if "compile-cache" in names:
		run_variant("compile-cache", 2)
	fresh = not os.path.exists(out_path)
	with open(out_path, "a", newline="") as f:
		writer = csv.DictWriter(f, fieldnames=FIELDS)
		if fresh:
			writer.writeheader()
		for r in range(rounds):
			order = names[:]
			random.shuffle(order)
			for name in order:
				result = run_variant(name, passes)
				writer.writerow({"round": r, "variant": name, **result})
				f.flush()
			print(f"round {r + 1}/{rounds} done", file=sys.stderr)


main()
