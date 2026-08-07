# Environment

Welcome. You're on a NixOS 26.05 machine where many things are already installed, including:

ripgrep, ripgrep-all, node, deno, pnpm, jq, python3, uv, google-chrome, curl-impersonate, gcc, go, rustc, cargo, patchelf, zip, unzip, zstd.

You're in a sandbox and can do whatever you need.

# Avoid consuming tokens in excess

When verifying how something works, use e.g. `rg -B2 -A10` until you need the whole file.

# Working with Node projects

Please use pnpm, not npm/npx to do things.

# There's plenty of time

If more external information is needed, think and keep iterating on web search queries to thoroughly check things. Tips: try site-specific searches e.g. site:github.com, reddit.com, news.ycombinator.com; try combinations of quoted items.

If you can't fetch something, try with headless google-chrome or curl_chrome146 on this machine.

If you need some information from e.g. Twitter or Discord or IRC or web archives which still fail to fetch, stop and ask the user.

# Tracking AI authorship

Files with any LLM-authored code (not counting mechanistic sed-like changes) begin with `// Model-output: <model name>`, one per model that contributed (e.g. "Claude Fable 5", "ChatGPT 5.5 Pro"). Keep existing lines.

# Code conventions

For JavaScript, TypeScript, and Svelte-related code:

- Use tabs, not spaces.
- `snake_case` function names and local variables.
- End statements with semicolons.
- Classes should be used when:
	- You have anything like a state machine, or functions closing over the same state. They help us organize and know which state is shared between related functions.
	- Integrating with an API properly, e.g. making an Error subclass.
  Otherwise, plain functions are generally fine.

When writing _any_ kind of code, including for the above:

- Think about invariants and add asserts or domain-specific errors where they might prevent misbehavior.
- Except where very obvious or redundant, write a docstring describing each argument, and the return value when not void. What do they really represent?
- The "main" function goes at the end and depends on functions above, which depend on functions further above, etc.
- Scan the functions and generalize if that makes a good result; evict any deadbeats: humans with a small context window need to review and maintain this code.
- Abstraction boundaries are important. Comments should reflect the current abstraction and generally avoid talking about other things.

Minutae:

- Use the { } curlies even for one-statement blocks.
- Block contents should not be on the same line that opened the block.
- Put `return`, `continue`, `break`, `throw` statements on their own line so that they're obvious.
- Blank lines inside functions should only be used to separate different ideas or groups of steps.
- Used space-based alignment only where it looks good: on adjacent lines with a very similar structure, add spaces after shorter identifiers (or the syntax to the right of them) to align things.

# TypeScript libraries to use

- `ayy` to assert things when it's okay to raise `AssertionError` instead of a domain-specific error.
- `logtape` for logging. Logs teach us about anomalies and the causes of things; log what a human operator would probably be interested in when observing the system.

For unit tests:

- Use `vitest` for unit tests. Writing more tests is fine.
- Use `fast-check` for property-based testing, i.e. to check a bunch of variations on e.g. a string or number.

# Programming thoughts

The real difficulty with programming is not getting a program that runs, but a coherent, maintainable artifact that humans are happy with.

A program can be:
- shorter.
- easier to read by a human.
- more correct around edge cases.
- faster than another which does the same thing.
- much easier to change when the requirements change.

These are sometimes in conflict.

It can help to do it different ways and see which version is better.

Sometimes a program can e.g. log or assert to generate interesting observations which feed into further development of the program.

# Project map

This repo is `tig`, the ncurses-based text-mode interface for git, written in C (2.6.1-dev fork).
Build: autotools (`configure.ac`, `Makefile`, `config.make.in`); `make` builds `src/tig`, `make test` runs the suite.

## Core flow

`src/tig.c` (main entry, event loop, request dispatch) → views spawn git commands through
`src/io.c` (nonblocking child-process pipes) → each view's `read` callback parses lines into
`struct line`/`struct box` cells → `src/draw.c` renders cells to curses windows.

## src/ by role

- **View framework**: `view.c` (view lifecycle, scrolling, searching glue, `begin_update`),
  `display.c` (curses init, window layout, input loop, status bar), `draw.c` (cell-by-cell line
  drawing, cursor/search styling), `ui.c` (file finder popup).
- **Views** (one per mode): `main.c` (commit list + graph), `diff.c` (diff view; also the
  external diff-highlight filter hook and ANSI-escape–to-cells parsing), `stage.c` (staged/
  unstaged hunks; reuses diff parsing), `status.c`, `log.c`, `reflog.c`, `blame.c`, `blob.c`,
  `tree.c`, `grep.c`, `stash.c`, `refs.c`, `help.c`, `pager.c` (generic pager + line wrapping;
  base for diff-likes).
- **Line typing & color**: `line.c` (maps line prefixes/regexes to `enum line_type`, dynamic
  line rules, curses color-pair allocation) with `include/tig/line.h` (the `LINE_INFO` type
  table). `graph-v1.c`/`graph-v2.c` (commit-graph column layout and coloring).
- **Options & input**: `options.c` (tigrc parsing, `set`/`color`/`bind` commands),
  `prompt.c` (`:` prompt, runs commands, re-inits colors on `:set`), `keys.c` (keymaps),
  `request.c` (request name table).
- **Git plumbing**: `repo.c` (repo discovery/state), `refdb.c` (ref storage), `parse.c`
  (commit/chunk-header parsing helpers), `apps.c` (locating external programs, e.g.
  diff-highlight), `watch.c` (file watchers for auto-refresh).
- **Utilities**: `argv.c` (argv build/quote/expand), `string.c`, `util.c`, `map.c` (string
  hash map), `types.c` (enum name mapping), `search.c`, `io.c`.

`include/tig/*.h` mirrors `src/*.c` one-to-one; shared structs (`struct view`, `struct line`,
`struct box_cell`) live in `include/tig/view.h`.

## Everything else

- `compat/` — portability shims (utf8proc, hashtab, wordexp, …), vendored.
- `test/` — shell-based snapshot tests by view (`test/diff/`, `test/main/`, …); harness in
  `test/tools/libtest.sh`; see `test/API.adoc`. Run one with e.g. `test/diff/diff-test`.
- `doc/` — asciidoc manual + man pages (`tigrc.5.adoc` documents all options);
  `doc/slop/syntax-highlighting-plan.md` is the active plan for VS Code-fidelity syntax
  highlighting in diff views (truecolor + SGR decoder + shiki filter daemon).
- `tigrc` — default configuration; `tools/make-builtin-config.sh` embeds it at build time.
- `contrib/` — example configs and scripts; `tools/` — build/release helper scripts.

## Related checkouts (outside this repo)

- `~/cloned/vscode-one-monokai` — One Monokai VS Code theme (fidelity target for syntax
  highlighting; theme JSON in `themes/`).
- `~/cloned/vscode` — VS Code source snapshot, for TextMate-tokenization parity checks
  (`src/vs/workbench/services/textMate/`, grammars in `extensions/*/syntaxes/`).

# After making changes

Automatically commit your changes with this commit template:

	subsystem: short one-line description; semicolon if multiple changes

	Model-output: model name e.g. Claude Fable 5

	<prompt>

	user prompt, verbatim

	AskUserQuestion question-answers, if any

	</prompt>

	<slop>

	model's response at the end of the dialogue, verbatim, in markdown format

	</slop>

"(mid-turn)" if I added something mid-turn; multiple <prompt></prompt> <slop></slop> ... if the conversation had several real turns.

Commit often; okay to commit more than once per turn!

# Codex code review after each commit

After each commit you make, get it reviewed by Codex (GPT-5.6-Sol at xhigh reasoning):

	codex review --commit <sha> -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh"

Notes:

- A review can take several minutes; run it in the background and continue if you have other work.
- Sol often nitpicks, or cares about bizarre, irrelevant edge cases. Ignore those findings;
  they should not stop you from making progress.
- For oversights that are true and interesting, fix them and make another commit (using the
  usual commit template). If you fixed nothing, say briefly in your reply why the findings
  didn't warrant changes.
- If you made several commits in a row, make sure the reviews cover all of them: either review
  each commit, or run one ranged review of the whole batch with
  `codex review --base <sha before your first commit>` plus the same `-c` options.

# Thank you for your hard work on this project

<3
