# tig-syntax-filter

Syntax highlighting for tig's diff views with VS Code fidelity: the same
TextMate grammars and Oniguruma engine lineage VS Code uses (via
[shiki](https://shiki.style/)), with the One Monokai theme, rendered
through tig's `diff-syntax-filter` option as 24-bit SGR.

Design and correctness contracts: `doc/slop/syntax-highlighting-plan.md`
in the repository root.

## Parts

- `client/tig-syntax-filter.c` — the program tig runs (`set
  diff-syntax-filter = tig-syntax-filter`). Streams the diff to the
  daemon, spawning it on first use; spools unacknowledged input so a
  missing, crashed, or stalled daemon degrades to the plain diff.
- `src/daemon.ts` — persistent unix-socket daemon (node >= 23.6 runs the
  TypeScript directly). Parses diff sections byte-exactly, fetches full
  pre/post-image sources (`git cat-file --batch` per repo + caches),
  tokenizes with shiki, validates every hunk line against the source,
  and injects per-token foreground SGR. Logs to
  `$XDG_STATE_HOME/tig-syntax/daemon.log`.
- `themes/one-monokai.json` — the theme (MIT, see `one-monokai.LICENSE`),
  vendored verbatim so it can be re-imported wholesale. Terminal-readability
  deviations from it (currently: a brighter comment foreground) are applied at
  load time by `TOKEN_COLOR_OVERRIDES` in `src/highlight.ts`.

## Build and install

	pnpm install               # once, for the daemon's dependencies
	make -C client             # builds bin/tig-syntax-filter

Then put `bin/` on PATH (both `tig-syntax-filter` and
`tig-syntax-daemon` live there; the client finds the daemon launcher
next to its own binary, via `$TIG_SYNTAX_DAEMON`, or on PATH) and add
`contrib/tig-syntax.tigrc`'s contents to your tig configuration.

## Environment

- `TIG_SYNTAX_SOCKET` — socket path (default
  `$XDG_RUNTIME_DIR/tig-syntax.sock`).
- `TIG_SYNTAX_DAEMON` — daemon launcher the client should spawn.
- `TIG_SYNTAX_DEADLINE_MS` — how long the daemon may go without completing
  a frame while input is outstanding before the client falls back to the
  raw diff (100–600000; default 15000).  The deadline is absolute: partial
  reads, partial writes, or trickled bytes do not extend it — only a
  completed frame does.
- `TIG_SYNTAX_BUDGET_MS` — daemon-side tokenization budget per file
  section, shared by the old and new side (50–600000; default 500).  A
  section that exceeds it renders raw; the lines tokenized within budget
  stay cached for shallower hunks and revisits.
- `TIG_SYNTAX_MAX_LINES` — deepest source line a hunk may require before
  the section is not highlighted (100–1000000; default 100000).
- `TIG_SYNTAX_MAX_SECTION_BYTES` — file sections larger than this are not
  buffered or highlighted at all; they stream through raw as they arrive
  (65536–67108864; default 1048576).

The daemon knobs are read once at daemon startup (restart the daemon after
changing them); the client's `TIG_SYNTAX_DEADLINE_MS` is read per run.

## Guarantees

Output equals input byte-for-byte after stripping injected SGR and
restoring the `ESC[999m` literal-ESC marker; anything the daemon cannot
highlight provably-correctly (binary, invalid UTF-8, textconv drivers,
combined diffs, overlong lines, source/hunk mismatches) passes through
raw. tig itself never depends on node: no filter, no daemon, or a dead
daemon all render the ordinary diff.
