#!/bin/sh
# Model-output: Claude Opus 5.5
# BM11 runner: does mimalloc, in tig and/or in the git it spawns, speed tig up
# on nixpkgs?  Builds tig from HEAD with and without mimalloc, two git shims
# (with/without LD_PRELOAD=libmimalloc.so), then times every {tig, git}
# combination.  Uses the user's ~/.config/tig/config (syntax filter included)
# and a private syntax daemon.
# Usage: run-bm11.sh <tig-repo> <nixpkgs-repo> <work-dir> <out-dir> [rounds]
set -eu

repo=$1; nix=$2; work=$3; out=$4; rounds=${5:-5}
here=$(cd "$(dirname "$0")" && pwd)
config=$HOME/.config/tig/config
mi=$(nix-build '<nixpkgs>' -A mimalloc --no-out-link)/lib
git=$(readlink -f "$(command -v git)")
mkdir -p "$work" "$out"
work=$(cd "$work" && pwd)
rm -rf "$work/src"
mkdir -p "$work/src" "$work/git-glibc" "$work/git-mi"

# tig from HEAD, built outside the checkout so its src/tig is left alone.
# $work/src starts empty: git archive stamps files with the commit time, so
# objects left from an earlier run would look newer than the sources.
git -C "$repo" archive HEAD | tar -x -C "$work/src"
build() {
	rm -f "$work/src/src/tig"
	nix-shell -p ncurses --run "make -C '$work/src' src/tig -j8 DIST_VERSION=bm11 $*" > /dev/null
}
build
cp "$work/src/src/tig" "$work/tig-base"
build "TIG_LDLIBS='-L$mi -Wl,--no-as-needed -lmimalloc -Wl,-rpath,$mi'"
cp "$work/src/src/tig" "$work/tig-mi"
MIMALLOC_VERBOSE=1 "$work/tig-mi" --version 2>&1 | grep -q 'mimalloc: process init'

gcc -O2 -DREAL_GIT="\"$git\"" -o "$work/git-glibc/git" "$here/gitwrap.c"
gcc -O2 -DREAL_GIT="\"$git\"" -DPRELOAD="\"$mi/libmimalloc.so\"" -o "$work/git-mi/git" "$here/gitwrap.c"

# config variants on top of the user's own
printf 'source %s\nset main-view-commit-title-graph = no\n' "$config" > "$work/nograph.tigrc"
printf 'source %s\nset show-untracked = no\n' "$config" > "$work/nountracked.tigrc"
grep -v '^set diff-\(syntax-filter\|prefetch\)' "$config" > "$work/filter-off.tigrc"
echo ':quit' > "$work/quit.tigscript"
printf '<Enter>\n:quit\n' > "$work/switch-0.tigscript"
{ echo '<Enter>'; for i in $(seq 300); do echo J; done; echo ':quit'; } > "$work/switch-300.tigscript"

# Private daemon, started with a clean PATH so its long-lived git
# processes are the same for every combination.
sock=$work/bench.sock
export TIG_SYNTAX_SOCKET=$sock
"$here/../kill-sock-daemon.sh" "$sock"
trap '"$here/../kill-sock-daemon.sh" "$sock"' EXIT
: | tig-syntax-filter > /dev/null

marker=$(git -C "$nix" log -1 --format=%s | cut -d' ' -f1)
b() {
	python3 "$here/bench.py" "$work" "$@"
}
# first screen = time until the newest commit's subject is drawn
b first-screen $((rounds * 4)) "$nix" - "first-screen:$marker" > "$out/first-screen.csv"
b first-screen-nountracked $((rounds * 2)) "$nix" "$work/nountracked.tigrc" "first-screen:$marker" \
	> "$out/first-screen-nountracked.csv"
b load-nograph "$rounds" "$nix" "$work/nograph.tigrc" "script:$work/quit.tigscript" > "$out/load-nograph.csv"
# v2 graph is ~O(n^2) on nixpkgs; 30k commits keeps a run near 16 s
b load-graph-30k "$rounds" "$nix" - "script:$work/quit.tigscript" --max-count=30000 > "$out/load-graph-30k.csv"
# per-switch cost = (T(300 switches) - T(0)) / 300
for mode in on off; do
	tigrc=-
	[ "$mode" = off ] && tigrc=$work/filter-off.tigrc
	for k in 0 300; do
		b "switch-$mode-$k" "$rounds" "$nix" "$tigrc" "script:$work/switch-$k.tigscript" --max-count=400 \
			> "$out/switch-$mode-$k.csv"
	done
done
python3 "$here/summarize.py" "$out"/*.csv > "$out/summary.txt"
