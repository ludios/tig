#!/usr/bin/env python3
# Model-output: Claude Opus 5.5
"""Summarize bench.py CSVs: per {tig, git} combo median/mean/sd/min and the
median's change vs glibc/glibc; for each switch-<mode>-0/-300 pair, also the
per-switch cost (difference of medians / 300).  Usage: summarize.py <csv>..."""

import csv
import os
import statistics as st
import sys

COMBOS = [("glibc", "glibc"), ("mi", "glibc"), ("glibc", "mi"), ("mi", "mi")]

def load(path):
	"""CSV path -> (bench name, {(tig, git): [wall_ms, ...]})."""
	rows = list(csv.DictReader(open(path)))
	assert rows, path
	by = {}
	for r in rows:
		by.setdefault((r["tig"], r["git"]), []).append(float(r["wall_ms"]))
	assert sorted(by) == sorted(COMBOS), (path, sorted(by))
	return rows[0]["bench"], by

def print_bench(name, by):
	"""Print one bench's table.

	name: bench name.  by: {(tig, git): [wall_ms, ...]} as load() returns.
	"""
	base = st.median(by[COMBOS[0]])
	print(f"{name} (n={len(by[COMBOS[0]])} per combo)")
	print(f"  {'tig':6} {'git':6} {'median':>9} {'mean':>9} {'sd':>7} {'min':>9} {'vs base':>8}")
	for key in COMBOS:
		v = by[key]
		med = st.median(v)
		sd = f"{st.stdev(v):7.1f}" if len(v) > 1 else f"{'-':>7}"
		print(f"  {key[0]:6} {key[1]:6} {med:9.1f} {st.mean(v):9.1f} {sd} {min(v):9.1f} {100 * (med / base - 1):+7.1f}%")

def print_per_switch(benches):
	"""Print per-switch costs for each switch-<mode>-0/-300 pair present.

	benches: {bench name: {(tig, git): [wall_ms, ...]}}; the names are the
	ones run-bm11.sh gives its switch benches.
	"""
	for mode in ("on", "off"):
		pair = benches.get(f"switch-{mode}-0"), benches.get(f"switch-{mode}-300")
		if None in pair:
			continue
		per = {c: (st.median(pair[1][c]) - st.median(pair[0][c])) / 300 for c in COMBOS}
		print(f"switch, filter {mode}: per-switch ms (difference of medians / 300)")
		for c in COMBOS:
			print(f"  tig={c[0]:5} git={c[1]:5} {per[c]:6.2f} ms  {100 * (per[c] / per[COMBOS[0]] - 1):+5.1f}%")

def main():
	benches = {}
	for path in sys.argv[1:]:
		name, by = load(path)
		benches[name] = by
		print_bench(name, by)
	print_per_switch(benches)

main()
