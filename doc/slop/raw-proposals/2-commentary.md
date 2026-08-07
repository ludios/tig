> I would really like `tig` to syntax-highlight code in the diffs it renders. could you please come up with a good implementation plan to colorize code just like vscode does? (don't implement yet, just verify feasibility)
> 
> I don't really care how it gets done, whether it's porting code to do it, a bridge to some other library, interacting with a running vscode, etc; it should probably be reasonably fast, though.

All the load-bearing claims are verified against the three source trees. Writing up the plan now.

Good evening. Verdict: **feasible**, and tig turns out to already contain most of the machinery. The plan above has file:line evidence for every claim; the short version:

**What tig already has** (verified in your uploaded tree, 2.6.1-dev): per-token colored line segments via `struct box`/`box_cell` drawn cell-by-cell (`include/tig/view.h:28-37`, `src/draw.c:588-607`); an external-filter hook that pipes the whole `git show --no-color` stream through an arbitrary program (`src/diff.c:46-73`, and the tigrc docs confirm the option value is used as the program path when not `true`); an ANSI-escape-to-cells parser with clean-text storage for search — except it recognizes exactly two codes, `\x1b[7m`/`\x1b[27m` (`src/diff.c:288-302`); and dynamic line-rule + color-pair allocation (`src/line.c:103-218`). The stage view rides the same path free (`src/stage.c:782,818`).

**What's missing**: a real SGR decoder in tig (~400–700 LOC of C, extends the existing skeleton in place), and a filter that injects ANSI into diff line bodies without touching the structure — tig classifies lines by literal prefix on the raw bytes, so column 0 must stay clean, which is also why delta can't be dropped in as-is.

**Fidelity**: exact VS Code colors means the same engine — VS Code is `vscode-textmate` ^9.3.2 + `vscode-oniguruma` WASM (`package.json:161-163`, `tokenizeLine2` at `textMateTokenizationSupport.ts:54`). Shiki is that same lineage, loads your One Monokai JSON as-is, and exposes an asynchronous `codeToANSI` function converting code to ANSI escape codes for terminal output. Its grammar bundle covers all your languages including elixir and nix (VS Code itself doesn't bundle elixir). Run it as a persistent daemon behind a thin pipe client to kill Node startup cost.

**Only real gap**: tig has no truecolor — colors are `color0..255` (`src/options.c:383-394`), and 24-bit support has been an open request since 2014 (jonas/tig#227). Non-blocking: One Monokai uses only 13 distinct foregrounds, which quantize to xterm-256 with barely visible error and need ~50 ncurses pairs total. Semantic (LSP) token colors are the other fidelity ceiling — no terminal pipeline gets those without running language servers.

The trickiest correctness item is tokenization state for mid-file hunks; the plan's recommended fix is having the filter tokenize full pre/post-image blobs via `git cat-file` and map hunk line numbers, which is always exact and cacheable by blob SHA.

Three open questions at the end need your call before implementing — mainly whether a Node/Bun dependency is acceptable on Windows, and hunk-state vs full-file tokenization for v1.
