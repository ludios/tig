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
- `src/start.mjs` — the daemon's entry point: turns on node's compile
  cache in `$XDG_CACHE_HOME/tig-syntax/node-compile-cache` so restarts
  listen sooner, then runs `src/daemon.ts`.  The cache is safe to
  delete; installs at a new path (e.g. each Nix upgrade) leave their old
  entries behind.
- `themes/one-monokai.json` — the theme (MIT, see `one-monokai.LICENSE`),
  vendored verbatim so it can be re-imported wholesale. Terminal-readability
  deviations from it (currently: a brighter comment foreground) are applied at
  load time by `TOKEN_COLOR_OVERRIDES` in `src/highlight.ts`.

## Build and install

	pnpm install               # installs the daemon's dependencies
	make -C client             # builds bin/tig-syntax-filter

Re-run both after every update, in this order.  The client bakes in a
hash of the daemon's sources, `package.json` and `pnpm-lock.yaml`, and
uses it to find (or start) a matching daemon, so a stale client keeps
talking to a daemon running the old code.  The hash does not cover
`node_modules`, so if `make -C client` runs before `pnpm install`, the
new client can start a daemon that keeps the old dependencies loaded
for as long as it runs.

Then put `bin/` on PATH (both `tig-syntax-filter` and
`tig-syntax-daemon` live there; the client finds the daemon launcher
next to its own binary, via `$TIG_SYNTAX_DAEMON`, or on PATH) and add
`contrib/tig-syntax.tigrc`'s contents to your tig configuration.

## Environment

- `TIG_SYNTAX_SOCKET` — socket path (default
  `$XDG_RUNTIME_DIR/tig-syntax-<build id>.sock`, where the build id is a
  hash of the daemon's sources taken when the client is built, so an
  upgraded client starts a fresh daemon and the old one idles out).  The
  client passes the path to the daemon it spawns.
- `TIG_SYNTAX_DAEMON` — daemon launcher the client should spawn.
- `TIG_SYNTAX_SPAWN_WAIT_MS` — how long the client waits for a daemon it
  just spawned to start listening before falling back to the raw diff
  (100–600000; default 60000).  Generous on purpose: a cold start on a
  slow or cache-cold machine can take seconds.  A launcher that exits
  with a failure (no node, a crashing daemon) ends the wait immediately,
  so a broken install still degrades fast.  Concurrent clients hitting a
  cold socket take a lock next to it so only one of them spawns.
- `TIG_SYNTAX_DEADLINE_MS` — how long the daemon may go without completing
  a frame while input is outstanding before the client falls back to the
  raw diff (100–600000; default 60000).  The deadline is absolute: partial
  reads, partial writes, or trickled bytes do not extend it — only a
  completed frame does.
- `TIG_SYNTAX_BUDGET_MS` — daemon-side time budget per file section, from
  when the daemon starts on it, for fetching its sources, loading grammars
  and tokenizing both sides (50–600000; default 45000, which leaves room
  under the client's default 60 s frame deadline).  A side not tokenized
  within it renders raw; the grammar states reached stay cached, as far as
  the tokenization cache holds them, and the next request for the same
  document continues from there rather than starting over.  (Loading
  another language can make shiki rebuild a grammar, e.g. markdown's;
  work done under the old grammar then starts over.)
- `TIG_SYNTAX_MAX_LINES` — deepest source line a hunk may require before
  the section is not highlighted (100–1000000; default 1000000).  Each
  line tokenized costs ~80 bytes of grammar state, which stays cached.
- `TIG_SYNTAX_MAX_SECTION_BYTES` — file sections larger than this, or of
  more than twice `TIG_SYNTAX_MAX_LINES` lines, are not highlighted; once
  a section exceeds either limit, its lines stream through raw as they
  arrive (65536–67108864; default 33554432, which is 32 MiB).  Source
  files (blobs or worktree files) over 32 MiB are never highlighted.
- `TIG_SYNTAX_LINE_CACHE_MB` / `TIG_SYNTAX_BLOB_CACHE_MB` — approximate
  byte budgets for the tokenization cache (each document's grammar state
  at every line start, through the deepest line rendered, plus the lines
  rendered so far) and the blob cache (1–4096; defaults 128 and 64).  A
  document whose states exceed half the tokenization cache is
  tokenized again on every visit.

The daemon knobs are read once at daemon startup (restart the daemon after
changing them); the client's `TIG_SYNTAX_SPAWN_WAIT_MS` and
`TIG_SYNTAX_DEADLINE_MS` are read per run.

## Guarantees

Output equals input byte-for-byte after stripping injected SGR and
restoring the `ESC[999m` literal-ESC marker; anything the daemon cannot
highlight provably-correctly (binary, invalid UTF-8, textconv drivers,
combined diffs, source/hunk mismatches) passes through raw.  As in VS
Code, a line of 20000 or more characters is not tokenized: it shows in
the theme's foreground, and the lines after it highlight as if it were
absent.  tig itself never depends on node: no filter, no daemon, or a
dead daemon all render the ordinary diff.
