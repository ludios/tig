#!/usr/bin/env python3
# Model-output: Claude Opus 5.5
"""Summarize run-bm12.py or daemon-start.py CSVs: per variant, the median
of each metric and the median per-round ratio against the baseline
variant (`base` or `plain`; paired within a round of one file, so a round
run during a load spike compares like with like).

Usage: summarize.py <results.csv>...   (all of one kind; several files
pool their samples, e.g. repeated runs on one machine)
"""
import csv
import statistics
import sys
from collections import defaultdict

SKIP = {"file", "round", "variant", "entry_ms", "steady_min_ms", "lines"}
RATIO_METRICS = {"first_ms", "steady_ms", "listen_ms", "client_ms"}


def main():
	rows = [dict(row, file=path) for path in sys.argv[1:] for row in csv.DictReader(open(path))]
	metrics = [m for m in rows[0] if m not in SKIP]
	ratio_metrics = [m for m in metrics if m in RATIO_METRICS]
	base = "base" if any(r["variant"] == "base" for r in rows) else "plain"
	by_variant = defaultdict(list)
	by_round = defaultdict(dict)
	for row in rows:
		by_variant[row["variant"]].append(row)
		by_round[row["file"], row["round"]][row["variant"]] = row
	print(f"{'variant':18} {'n':>3} " + " ".join(f"{m:>11}" for m in metrics) + "   "
	      + " ".join(f"{m.removesuffix('_ms') + '/' + base:>13}" for m in ratio_metrics))
	for name, vrows in sorted(by_variant.items(), key=lambda kv: kv[0] != base):
		medians = [statistics.median(float(r[m]) for r in vrows) for m in metrics]
		ratios = []
		for m in ratio_metrics:
			paired = [float(rs[name][m]) / float(rs[base][m])
			          for rs in by_round.values() if name in rs and base in rs]
			ratios.append(f"{statistics.median(paired):.3f}" if paired else "-")
		print(f"{name:18} {len(vrows):>3} " + " ".join(f"{v:>11.1f}" for v in medians) + "   "
		      + " ".join(f"{r:>13}" for r in ratios))


main()
