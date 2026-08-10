#!/bin/sh
# Model-output: Claude Fable 5
# BM1: generate the deterministic synthetic benchmark repo.
# Usage: gen-synthetic.sh <target-dir>   (target must not exist)
# Commits are deterministic (fixed author/committer/dates), so SHAs recorded
# in bench-corpus.txt stay valid across regenerations.
set -eu

target=$1
[ ! -e "$target" ] || { echo "target exists: $target" >&2; exit 1; }
mkdir -p "$target"
cd "$target"
git init -q
git config user.name bench
git config user.email bench@example.invalid
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'

# big.ts: 100k lines of plausible TypeScript (varied tokens per line).
python3 - <<'EOF'
lines = []
for i in range(100_000):
	k = i % 4
	if k == 0:
		lines.append(f"export function fn_{i}(a: number, b: string): number {{")
	elif k == 1:
		lines.append(f"\tconst x_{i} = a * {i} + b.length; // comment {i}")
	elif k == 2:
		lines.append(f"\treturn x_{i} > {i} ? x_{i} : -{i};")
	else:
		lines.append("}")
with open("big.ts", "w") as f:
	f.write("\n".join(lines) + "\n")
EOF
git add big.ts
git commit -qm 'base: 100k-line TypeScript file'

# One-line edits at three depths, one commit each (BM2/BM3/C5 hunk-position cases).
edit_line() {
	# $1 = 1-based line number, $2 = commit subject
	python3 - "$1" <<'EOF'
import sys
n = int(sys.argv[1])
with open("big.ts") as f:
	lines = f.readlines()
lines[n - 1] = lines[n - 1].rstrip("\n") + " /* edited */\n"
with open("big.ts", "w") as f:
	f.writelines(lines)
EOF
	git add big.ts
	git commit -qm "$2"
}
edit_line 10     'edit at line 10 of big.ts'
edit_line 50000  'edit at line 50000 of big.ts'
edit_line 99998  'edit at line 99998 of big.ts (near EOF)'

# minified.js: single long lines with ~N token-style alternations each
# (BM8 runs-per-line cases).  One commit adding them, then one editing each
# line so a diff shows them as changed lines.
python3 - <<'EOF'
def line(n):
	# each unit is roughly: identifier, punctuation, number, punctuation
	return "var " + ";".join(f"v{i}={i}*2" for i in range(n)) + ";"
with open("minified.js", "w") as f:
	for n in (10, 100, 500, 1000, 4000):
		f.write(line(n) + "\n")
EOF
git add minified.js
git commit -qm 'add minified.js runs-per-line lines'
python3 - <<'EOF'
with open("minified.js") as f:
	lines = f.readlines()
with open("minified.js", "w") as f:
	for l in lines:
		f.write(l.rstrip("\n") + "var edited=1;\n")
EOF
git add minified.js
git commit -qm 'edit every minified.js line'

git log --oneline
