Good evening. I reviewed the current `prime` tree and the syntax-highlighting commits. I did not modify the repository.

## Main conclusion

The highest-priority problem is not Node startup or cache size. It is that the pipeline has **no reliable upper bound on how long pathological highlighting can block progress**.

There are three interacting causes:

1. **The C client can block indefinitely while writing to the daemon.**
2. **Tokenization runs synchronously on the daemon’s only JavaScript thread.**
3. **A complete file section is buffered before it can be highlighted or passed through.**

More caching and preloading will improve the good cases, but they will not fix the giant-commit stall. I would implement responsiveness controls first, then reduce repeated work and memory traffic, then consider speculative preloading.

## Concrete evidence

### The 15-second timeout is not a hard timeout

The client’s timeout applies while polling for response frames in `tools/tig-syntax-filter/client/tig-syntax-filter.c:383-397`. Writes use the blocking `write_all()` at lines `69-85`, including the daemon write around line `425`.

I recompiled that client and connected it to a same-UID fake Unix-socket daemon that accepted a 10 MiB request but never read from the socket. The client was still blocked after 18 seconds and had to be killed by an external timeout.

That is directly analogous to the real daemon being occupied by synchronous tokenization: while JavaScript is tokenizing, the event loop cannot read more socket data. Once the kernel socket buffer fills, the client can block inside `write()` and never reach its 15-second timeout.

This is a correctness-level responsiveness bug, not merely an optimization opportunity.

### The repository contains an excellent pathological benchmark

Commit `5294f798`, “Update utf8proc to v2.10.0”, produces:

| Measurement               |                         Value |
| ------------------------- | ----------------------------: |
| Complete diff             |               4,520,852 bytes |
| Diff lines                |                        31,818 |
| Largest file section      |               4,503,738 bytes |
| Largest section lines     |                        31,452 |
| Insertions plus deletions |                        30,816 |
| Context rows              |                           591 |
| Old source                | 2,236,840 bytes, 16,960 lines |
| New source                | 2,347,972 bytes, 17,106 lines |

The large section is `compat/utf8proc_data.c`. Its lines are short, and both documents are well below the current 100,000-line limit, so all current static guards allow it. The final hunk reaches close to the end of both files, causing nearly the entire old and new sources to be tokenized.

It is also the final file section, so `diff_parser.ts` retains it until EOF before `process_section()` starts. This is almost exactly the worst case for the present architecture.

### One expensive section blocks the daemon globally

Each connection has a promise queue in `daemon.ts:41-52`, but `process_section()` eventually invokes synchronous Shiki tokenization in `process.ts:140-143`. Although the API is wrapped in promises, the CPU work remains on the sole event-loop thread.

Consequently, one expensive file blocks:

* Later files from that client.
* Socket reads and writes.
* Detection that the client was killed because the user moved to another commit.
* Other Tig instances using the same daemon.
* Cancellation and timeout callbacks.

Node’s worker-thread documentation specifically positions workers for CPU-intensive JavaScript such as this. ([Node.js][1])

---

# Priority 0: make stalls impossible

## 1. Make the C daemon connection nonblocking

Set the daemon socket to nonblocking mode and replace `write_all()` with a single state machine that drives both outbound and inbound progress through `poll()`:

* Request `POLLOUT` while a frame remains to be written.
* Request `POLLIN` while responses may be available.
* Track offsets into the outgoing frame.
* Use an **absolute deadline** based on the oldest uncommitted section.
* Compute each `poll()` timeout as `deadline - now`.
* Do not restart the deadline after partial progress.
* On timeout, close the daemon socket and emit the retained raw section.

This fixes both indefinite writes and a daemon that prolongs a request indefinitely by trickling occasional bytes.

The deadline should apply from the moment a section becomes ready for dispatch, not from the moment the client finally finishes writing it.

The current 15-second limit is much too large for foreground UI work even after it becomes reliable. Benchmark the exact value, but the intended order of magnitude should be hundreds of milliseconds before raw fallback, not many seconds. A separate longer background budget can be used for speculative cache population.

Also add:

* A maximum declared response-frame length.
* A maximum receive-buffer size.
* A maximum unacknowledged-byte count.
* Protocol sequence numbers if they are not already sufficient to distinguish committed output from merely transmitted requests.

## 2. Move tokenization into a worker

The daemon’s main thread should own only:

* Socket handling.
* Frame parsing.
* Request scheduling.
* Deadlines.
* Cancellation.
* Output ordering.
* Cheap preflight decisions.

A worker should own:

* Shiki and Oniguruma.
* Loaded grammars.
* Grammar-state and token caches.
* Actual tokenization.
* SGR or style-span construction.

Start with **one long-lived worker**. That preserves the current effective CPU concurrency while making the socket server responsive. It also avoids immediately duplicating Shiki, WASM, grammars, and caches in memory.

Once measured, consider two workers:

* One foreground worker.
* One speculative or next-file worker.

A generic pool with several workers is liable to increase RSS sharply, reduce cache locality, and create CPU contention. The worker count should therefore be benchmarked rather than derived from core count.

The main thread can enforce a true hard deadline by terminating and replacing a worker. A `Promise.race()` inside the present thread cannot interrupt synchronous regex or WASM execution.

Maintain a small warm replacement worker only if measurements show that worker reinitialization following a timeout is itself disruptive.

## 3. Add explicit cancellation and generations

Every view request should carry a generation ID assigned by Tig or the C client.

When navigation kills the old filter process:

* Drop its queued sections immediately.
* Remove pending output.
* Cancel its Git work where practical.
* If its active worker task is still tokenizing, terminate that worker after a very small grace period.
* Never allow stale speculative work to delay the new foreground generation.

At present, Tig kills its view process when navigation changes, but a synchronously occupied daemon cannot observe the socket closure until tokenization returns. This is why rapid navigation can leave apparently inexplicable work running.

Use separate queues:

* Foreground current-view work.
* Bounded next-file prefetch.
* Lowest-priority adjacent-commit prefetch.

Foreground work should always preempt or cancel speculative work.

## 4. Honor socket backpressure

`socket.write()` in `daemon.ts` has a boolean return value, but the code does not currently stop when it returns false.

The daemon should:

* Stop dequeuing output after `write()` returns false.
* Resume on `drain`.
* Pause input parsing when queued work or queued bytes exceeds a limit.
* Close or reject a client that exceeds protocol limits.
* Bound queues by bytes as well as task count.

A queue of ten 100-byte files and a queue of ten 5-MiB files must not be treated equivalently.

## 5. Detect excessive work while the section is still arriving

The current limits in `highlight.ts` are mainly:

* Maximum characters per line.
* Maximum document lines.
* Maximum style runs per line.

Those do not protect against tens of thousands of ordinary short lines.

Track these inexpensive quantities while parsing:

* Raw section bytes.
* Diff line count.
* Added, deleted, and context rows.
* Largest old and new source line referenced by a hunk.
* Number of hunks.
* Longest input line.
* Approximate source prefixes required.
* Known blob sizes once object metadata is available.
* Estimated output amplification.
* Historical cost for the detected language.

When a section exceeds a budget, mark it as raw immediately.

Most importantly, `diff_parser.ts` should not continue retaining the entire oversized section. It should:

1. Flush the already-buffered raw prefix.
2. Enter a raw-pass-through mode.
3. Stream subsequent chunks unchanged until the next `diff --git` boundary.
4. Resume normal parsing for the next file.

That turns a 4.5-MB generated file into a quick raw rendering instead of a long silent wait followed by a large memory spike.

Threshold values need benchmarks, but the mechanism does not.

## 6. Use two levels of time budget

A useful model is:

* **Per-line tokenizer budget:** checked between TextMate lines.
* **Per-section outer deadline:** enforced by the main thread by terminating the worker.

The per-line mechanism catches cumulative expense and allows a clean stateful abort. The outer deadline catches a single pathological regex call that never returns promptly.

Cache the negative result for the remainder of the daemon session, keyed by source identity, language, grammar version, and budget version. Reopening the same pathological file should not repeat the failed attempt.

---

# Priority 1: substantially reduce ordinary work

## 7. Implement real incremental grammar-state caching

The existing token cache helps only when the cached result already reaches the requested final line. Extending a cached document currently tokenizes again from line 1 in `highlight.ts:205-230`.

Shiki exposes `GrammarState` specifically so tokenization can continue from an intermediate state. ([Shiki][2])

For each immutable source, cache:

* The last scanned line.
* Its ending grammar state.
* Periodic grammar-state checkpoints, perhaps every 128 or 256 lines.
* Compact style runs only for source lines that were actually requested by a diff.
* Cost statistics.

Then:

* A later hunk resumes from the nearest preceding checkpoint.
* Extending from line 5,000 to 5,300 scans only 300 new lines.
* Revisiting a nearby commit can reuse the same object’s states.
* A request for a previously rendered line returns compact runs immediately.

The checkpoint interval requires measurement. Small intervals consume memory; large intervals increase rescanning.

One unavoidable fact remains: exact TextMate highlighting of a cold line near the end of a file requires processing the preceding lexical state unless a checkpoint already exists. Caching is therefore excellent for revisits and extensions, but it cannot replace the hard raw-fallback budget for the first cold encounter.

## 8. Materialize styles only for diff-visible source lines

TextMate still has to advance through preceding lines to obtain lexical state. It does **not** have to construct final SGR strings for every preceding source line.

The current path tokenizes a complete prefix and builds styled strings for every line in that prefix, even though the diff may use only a small subset.

Instead:

* Build a set or ordered iterator of source line numbers needed by the diff.
* Tokenize every preceding line only to advance state.
* Discard token arrays immediately for nonrequested lines.
* Convert tokens to compact style runs only for requested lines.
* Serialize only while rebuilding the diff.

For `5294f798`, the diff genuinely displays many changed lines, but this is still a major gain for the much more common case of a small hunk late in a large file.

## 9. Determine the exact source sides that are needed

Use:

* Deleted rows from the old source.
* Added rows from the new source.
* Context rows from the new source.

Do not use the complete old hunk range merely because context lines have old coordinates.

This permits:

* Skipping the old source entirely for addition-only modifications.
* Skipping the new source for pure deletions.
* Setting the old prefix limit to the last deleted row rather than the end of the last old hunk.
* Reducing old-side tokenization for ordinary mixed hunks.

Source correspondence validation still needs to remain conservative, especially for worktree diffs, but validation and highlighting need not allocate or tokenize identical structures.

## 10. Remove repeated whole-document copies

A large section can currently exist in several forms at once:

* Raw Git or socket buffers.
* Decoded JavaScript strings.
* `split("\n")` arrays.
* Sliced and rejoined prefixes.
* Shiki token arrays.
* Per-line SGR strings.
* Output-buffer arrays.
* A concatenated response.
* The C client’s input spool.

The following changes are individually straightforward and collectively important:

* Build one newline-offset index instead of repeatedly calling `split()`.
* Decode only the required prefix where strict UTF-8 validation permits.
* Validate diff text against source bytes without constructing a `Map<number, string>`.
* Avoid `slice().join("\n")` before tokenization.
* Stream output into bounded chunks rather than retaining every part for one final `Buffer.concat()`.
* Preserve incoming raw chunks directly in fallback mode.
* Reuse a newline constant instead of allocating one per line.
* Parallelize old/new blob I/O after the Git batcher can safely pipeline them.
* Release old-side structures before constructing new-side output where possible.

Pay attention to `Buffer.subarray()` ownership. A tiny retained subarray can keep a large backing allocation alive.

## 11. Replace entry-count LRUs with byte-weighted caches

Current limits include approximately:

* 128 blob-cache entries, each permitted to approach 8 MiB.
* 256 token-cache entries, with no meaningful byte bound.

The theoretical blob retention alone can approach 1 GiB, before token strings, line arrays, WASM, queues, and client spools.

Every cache should have:

* A total byte budget.
* A per-entry maximum.
* A count limit as a secondary safeguard.
* Explicit accounting for strings, buffers, arrays, and style runs.
* Hit, miss, insertion, rejection, and eviction metrics.

Use a segmented policy:

* Foreground entries enter a protected segment after reuse.
* Speculative entries begin in a probationary segment.
* Prefetch must not evict recently used foreground data.

### Recommended cache layers

**Exact-response cache**

Keyed by the input section hash, source identities, language/theme version, and relevant options. This gives the fastest possible exact reopen. Keep it small because ANSI responses are inflated.

**Blob cache**

Keyed by canonical object-store identity, object format, and full object ID—not raw current working directory.

**Grammar-state cache**

Keyed by full object identity, language, grammar-engine version, and grammar version. Theme changes generally need not invalidate lexical state.

**Styled-run cache**

Keyed additionally by theme/version. Store compact numeric runs rather than SGR strings.

**Worktree cache**

Keyed by canonical path plus a stat fingerprint, with content revalidation before trusting it.

**Negative cache**

Records oversize, timeout, unsupported, invalid UTF-8, and pathological-language decisions so they are not repeatedly rediscovered.

**Optional persistent cache**

Compact grammar checkpoints and style runs could eventually be persisted across daemon restarts. This is worthwhile only after the in-memory representation, versioning, eviction, and correctness keys are settled.

## 12. Coalesce identical in-flight work

Use promise maps for:

* Blob fetches.
* Language loads.
* Source tokenization.
* Exact section rendering.

Two Tig processes requesting the same blob should share one computation rather than independently missing the cache.

`ensure_lang()` should maintain both:

* An explicit loaded-language `Set`.
* An in-flight `Map<language, Promise>`.

Do not repeatedly construct and scan the complete loaded-language array.

## 13. Optimize style generation

`style_sequence()` repeatedly parses colors and constructs SGR strings for token styles that recur constantly.

Precompute:

* Theme-color to terminal-color conversions.
* `(foreground, font_style)` to encoded sequence.
* Frequently used reset and transition sequences.
* Stable numeric style IDs.

Then benchmark differential SGR output:

* Emit only changed foreground or attributes.
* Use attribute resets such as 22, 23, and 24 where understood.
* Avoid complete reset/reapply sequences between adjacent tokens.

This can reduce:

* JavaScript allocation.
* Protocol bytes.
* Socket writes.
* C-side SGR parsing.
* Number of Tig syntax cells.

It should be benchmarked because extra state-machine complexity can offset savings on simple diffs.

## 14. Fix the C-side token-fragment hot path

There is a separate pathological cost after Node has completed.

In `src/diff.c:123-137`, every styled text fragment calls `argv_appendn()`. In `src/argv.c:223-241`, every append calls `argv_size()`, which linearly searches for the terminating null pointer.

For a line with `R` style fragments, this gives approximately quadratic pointer scanning, plus:

* One allocation per fragment.
* A later full join in `argv_to_string_alloc()`.
* Another copy into the line structure.

The highlighter permits up to 4,000 runs per line, making token-dense generated or minified lines a credible Tig-side stall.

Replace that representation with one of:

* A dynamically growing contiguous text buffer plus a separate span array.
* A builder that tracks its own length and capacity.
* Direct construction of the final line storage.

Also replace `syntax_style_get()`’s linear scan through up to 1,024 styles in `src/line.c:468-520` with a hash table from style attributes to style ID.

This deserves a synthetic benchmark with 10, 100, 500, 1,000, and 4,000 style transitions on one line.

## 15. Fix smaller data-structure pathologies

These are unlikely to dominate ordinary workloads individually, but they should be cleaned up during adjacent work:

* Replace `pending.shift()` in the Git batcher with a deque or head index.
* Respect backpressure on `git cat-file` stdin.
* Copy or release a tiny parser tail instead of retaining the last large backing buffer.
* Replace repeated `Buffer.concat()` carry growth in `diff_parser.ts`; a single giant no-newline line can otherwise produce quadratic copying.
* Place an explicit upper limit on carry size.
* Avoid repeated temporary `Map` and body-string creation during hunk validation.
* Reclaim or compact the C client’s acknowledged spool prefix.
* Apply the 64-MiB client limit to unacknowledged bytes, not total bytes seen since process start.

---

# Git-process improvements

The recent commits already made the most important change by retaining `git cat-file --batch`. The next gains are in metadata and request aggregation.

## 16. Batch textconv attribute checks

`has_textconv()` currently spawns `git check-attr` for new paths and may then spawn `git config` for the driver.

Git supports persistent, NUL-delimited `check-attr --stdin -z`, which is suitable for a long-lived subprocess. ([Git][3])

Use one process per canonical repository and:

* Send many paths through it.
* Cache `path -> driver`.
* Cache `driver -> has configured textconv`.
* Load configured textconv drivers once per repository where practical.
* Bound the path cache by bytes/count.

Simply disabling textconv is not a safe default optimization because it can change the content produced by Git and break correspondence with the displayed diff. Git documents textconv as enabled by default for `git show` output. ([Git][4])

## 17. Preflight objects before receiving their complete contents

`git cat-file --batch-command` supports separate `info` and `contents` operations. That allows the daemon to obtain type, full object ID, and size before requesting the payload. ([Git][5])

That would let it:

* Reject an oversized blob without reading it.
* Avoid killing the complete batcher when an object exceeds the local size limit.
* Obtain a canonical full object ID for cache keys.
* Pipeline old and new `info` requests.
* Request both contents together when both are actually needed.

## 18. Normalize repository identities

Current caches are substantially keyed by raw `cwd`. The same repository reached through:

* Different subdirectories.
* Symlinks.
* Separate worktrees sharing an object store.

can therefore create duplicate Git processes and duplicate cache entries.

Use:

* Canonical common Git directory or object directory for immutable object caches.
* Canonical worktree root for worktree-content caches.
* Full object ID plus repository object format for blobs.
* A separately cached repository hash format so source verification hashes only the required algorithm rather than both SHA-1 and SHA-256.

---

# Node startup improvements

Startup matters, but mostly for the first highlighted view after the 30-minute idle shutdown. The warm daemon already avoids repeated Shiki and Git startup.

## 19. Bind the singleton socket before loading Shiki

`daemon.ts` initializes the highlighter before `server.listen()`.

That has two consequences:

* The client cannot distinguish “daemon initializing” from “no daemon”.
* Multiple simultaneous cold clients can each load Shiki, WASM, logging, and the theme before all but one lose the socket-bind race.

Use a minimal bootstrap:

1. Acquire the singleton lock or bind the socket immediately.
2. Start accepting a tightly bounded number of requests.
3. Initialize the worker asynchronously.
4. Either queue one small request or tell the client to render raw while warming.
5. Reject additional cold-start load rather than accumulating an unbounded queue.

This is likely a better cold-start improvement than shaving a few milliseconds from TypeScript execution.

## 20. Measure compiled JavaScript versus direct TypeScript

The package currently executes `daemon.ts` directly.

Benchmark:

* Direct TypeScript.
* Precompiled ESM JavaScript.
* Minified versus unminified output.
* Source maps disabled in the production launcher.
* Logging modules loaded eagerly versus dynamically.

Do not assume compilation wins materially; measure import-to-listen and import-to-first-token separately.

## 21. Enable Node’s module compile cache

Node’s module compile cache covers CommonJS, ESM, and TypeScript modules, and is intended to improve subsequent process starts, although the initial compilation may become slightly more expensive. ([Node.js][6])

Use a stable cache directory under the user cache directory and benchmark:

* First start with an empty compile cache.
* Second start.
* Start after a package or Node-version change.
* Disk usage and invalidation behavior.

This helps daemon restarts, not the normal warm-view hot path.

## 22. Use a fine-grained Shiki bundle

Shiki documents a fine-grained/core setup that imports only the required engine, themes, and languages instead of the larger default bundle. ([Shiki][7])

For this project:

* Import the core directly.
* Include only the fixed theme.
* Lazy-import supported language grammars through a generated map.
* Preload only the most common or last-used grammar after the socket is listening.
* Compare startup RSS and first-language latency against the current `shiki` import.

This requires a benchmark because dozens of tiny dynamic imports can sometimes trade lower startup memory for more first-use overhead.

## 23. Make daemon lifetime configurable

Options worth supporting:

* Start at login as a user service.
* Keep alive indefinitely.
* Longer idle timeout.
* Exit only under memory pressure.
* Warm one common grammar during idle time.

A persistent service trades cold latency for background memory. That trade should be visible and configurable rather than hard-coded.

## 24. Remove avoidable launcher delay

The client currently retries connection at 50-ms intervals, up to roughly three seconds. That quantizes cold startup by as much as one retry interval.

Better approaches:

* A readiness pipe inherited by the launched daemon.
* Socket activation.
* A lock file plus short initial retry intervals.
* A bootstrap process that binds synchronously before doing heavyweight imports.

Eventually, a persistent socket connection owned directly by Tig would remove the per-view C filter process and connection setup altogether.

---

# Preloading and speculative work

## 25. Prefetch the next file before the next commit

The next file in the current diff is predictable and highly likely to be consumed.

As soon as its headers and `index` information arrive:

* Request object metadata.
* Begin blob fetches.
* Resolve textconv attributes.
* Start loading the grammar.
* Optionally advance grammar state in a second worker.
* Preserve output order with a window of only one or two files.

This is safer and more valuable than guessing the next commit.

## 26. Let content-addressed caching provide natural adjacent-commit reuse

Adjacent commits usually share source objects:

* The new side of one commit often appears as the old side of the next.
* Unchanged files retain identical object IDs.
* The same grammar states remain valid.

A full-OID grammar-state cache may capture most of the apparent benefit of “preload the next commit” without performing speculative tokenization.

Measure this cache reuse before implementing explicit adjacent-commit prefetch.

## 27. Send navigation hints from Tig

The daemon cannot reliably infer which commit is “next” from a raw `git show` stream. Tig knows:

* Current commit.
* Selected neighboring commit.
* Navigation direction.
* View generation.
* Whether the user is moving rapidly or stationary.

After the current view finishes and the UI has been idle briefly, Tig could send a low-priority hint for exactly one neighbor.

The speculative scheduler should:

* Cancel on any foreground request.
* Initially fetch only metadata and blobs.
* Tokenize only while the worker is otherwise idle.
* Store results in the probationary cache segment.
* Never extend the foreground deadline.
* Avoid fetching a second neighbor until the first was actually useful.

Blindly processing several upcoming commits will likely make latency and cache behavior worse.

---

# Progressive display and asynchronous replacement

## 28. Emit highlighted output per hunk rather than per file

A medium-sized architectural improvement is to make the parser and protocol incremental:

1. Parse file headers as they arrive.
2. Begin source metadata and blob requests immediately.
3. Advance grammar state line by line.
4. Emit each hunk once both sides needed by that hunk have been validated and styled.
5. Acknowledge and release input incrementally.

This improves first paint and lowers peak memory without changing Tig’s basic filter model.

It also allows an early hunk near the top of a large file to appear while later lexical state is still being computed.

## 29. Raw-first replacement requires Tig integration

The current filter writes an append-only byte stream. Once it emits an unhighlighted line, it cannot later replace that line with a highlighted version.

A true raw-first design therefore needs a different interface:

* Tig loads and displays the plain Git diff immediately.
* The highlighter receives file identities, hunk mappings, and a view generation.
* It returns compact style spans keyed by line ID and byte range.
* Tig applies spans to existing lines and redraws affected rows.
* Results from stale generations are discarded.

This has several large benefits:

* No ANSI expansion.
* No ANSI reparsing.
* No separate complete filtered copy of the diff.
* Visible lines can be prioritized.
* Cancellation becomes natural.
* Raw text remains authoritative.
* Large or failed files simply remain unhighlighted.
* Styles can arrive incrementally.

It also eliminates the C-side `argv_appendn()` issue by representing syntax as spans rather than fragments of embedded escape sequences.

A less invasive compromise is:

* Render raw immediately for over-budget files.
* Continue highlighting only during genuine idle time.
* Populate the cache for the next visit.

Attempting to reload the entire current view after background completion would cause cursor, scrolling, and flicker complications and is inferior to line-level style updates.

---

# Benchmark plan

The repository commit messages contain useful anecdotal figures—roughly 140 ms for one warm nine-file path and 3–6 ms for a warm revisit after the persistent blob work—but I found no reproducible benchmark harness, retained result files, or pinned corpus. Establish that before tuning thresholds or worker counts.

## 1. Instrument the complete latency path

Use monotonic timestamps and a request/connection/section/generation ID.

### Tig

Record:

* Navigation key received.
* Diff view started.
* First diff line accepted.
* First screenful drawable.
* First screenful drawn.
* View complete.
* View canceled.

### C client

Record:

* Process start.
* Connect attempt and success.
* Daemon-launch request.
* First outbound byte.
* Duration blocked waiting for outbound capacity.
* Section fully transmitted.
* First response byte.
* First stdout byte.
* Section committed.
* Raw fallback reason.
* Process finish.

### Daemon

Record:

* Connection accepted.
* Frame parsed.
* Section parser started/completed.
* Queue entry/start.
* Worker dispatch/start/finish.
* Textconv lookup.
* Blob metadata and content fetches.
* Cache hits, misses, coalesced requests, and evictions.
* UTF-8 decode.
* Grammar load.
* Old/new tokenization.
* Style encoding.
* Serialization.
* Socket backpressure and `drain`.
* Cancellation and worker termination.

For each section, attach:

* Raw bytes and lines.
* Added/deleted/context rows.
* Source bytes and lines.
* Required prefix lines.
* Token count and style-run count.
* Styled-output/raw-input ratio.
* Cache bytes before/after.
* Fallback reason.

Node’s `perf_hooks` provides event-loop utilization and event-loop delay monitoring suitable for confirming that the socket thread remains responsive. ([Node.js][8])

Also record:

* `process.memoryUsage()` including `external` and `arrayBuffers`.
* RSS peak.
* GC duration through `PerformanceObserver`.
* Worker restarts.
* Queue bytes.
* Unacknowledged client spool bytes.

Write benchmark telemetry as buffered JSONL to a separate descriptor or file. Do not synchronously log every token.

## 2. Benchmark the pipeline in layers

Run the same corpus through:

1. `git show` alone.
2. C client plus a raw echo daemon.
3. Diff parsing and Git source loading, with tokenization disabled.
4. Tokenization with style serialization disabled.
5. Tokenization plus compact runs.
6. Full SGR output.
7. Full Tig rendering through a PTY.

The basic end-to-end command is:

```sh
git show --no-color --pretty=fuller --root --patch-with-stat 5294f798 -- \
	| tig-syntax-filter \
	> /dev/null
```

The layer separation tells you whether a change improved:

* Git I/O.
* Node startup.
* Parsing.
* TextMate tokenization.
* Serialization.
* Socket transfer.
* C escape parsing.
* Actual interactive paint.

Without this decomposition, a faster tokenizer can be hidden by startup, and a smaller response can be hidden by C allocation.

## 3. Distinguish cache and startup states

Measure these independently:

| State                                | Meaning                                      |
| ------------------------------------ | -------------------------------------------- |
| Cold process                         | No daemon                                    |
| Warm daemon, cold application caches | Imports/WASM ready, no blob or token entries |
| Blob hit, token miss                 | Isolates tokenization                        |
| Grammar-state extension              | Existing state stops before requested hunk   |
| Complete token hit                   | Reopen exact source                          |
| Exact-response hit                   | Reopen exact diff section                    |
| Daemon restart, compile cache warm   | Measures Node compile cache                  |
| Fully warm revisit                   | Best attainable case                         |

Use a unique socket/runtime directory for each cold trial so an unrelated daemon cannot contaminate measurements.

Do not conflate process-cold with filesystem-cache-cold. Dropping the operating-system page cache is disruptive and generally unnecessary; label the filesystem state instead.

## 4. Use a fixed repository corpus

At minimum:

| Revision   | Characteristic                                                       |
| ---------- | -------------------------------------------------------------------- |
| `494a4085` | 94 small files; exposes per-path and process overhead                |
| `ff8a7c3a` | 16 files, approximately 122 KB; representative medium feature commit |
| `5294f798` | Approximately 4.5 MB generated-C diff; stall and fallback case       |

Add ordinary real commits covering:

* C.
* TypeScript/JavaScript.
* Rust.
* Python.
* Nix.
* Elixir.
* Markdown.
* Svelte or mixed embedded grammars.
* Worktree and staged diffs.
* Renames.
* File creation and deletion.
* Textconv.
* Binary and invalid UTF-8 input.

## 5. Add synthetic cost-shape cases

Generate deterministic repositories containing:

* A one-line hunk at source line 10.
* The same hunk at lines 10,000 and 100,000.
* A huge source with a tiny top-of-file hunk.
* A huge source with a tiny end-of-file hunk.
* Many small files using one language.
* Many small files using distinct languages.
* A near-8-MiB blob.
* A 20,000-character minified line.
* Lines producing 10, 100, 500, 1,000, and 4,000 style runs.
* A section just below and just above every proposed budget.
* Cache working sets at 0.5×, 1×, 2×, and 4× the configured byte limit.

The line-position cases are essential for selecting the grammar checkpoint interval.

## 6. Add protocol fault-injection tests

Create small fake daemons that:

* Accept but never read.
* Read one byte every few milliseconds.
* Read the complete request but never reply.
* Trickle a partial response indefinitely.
* Declare an excessive frame length.
* Disconnect mid-frame.
* Return frames out of sequence.
* Return a valid response just after the deadline.

The “accept but never read” case should become a CI regression test. Assert that the client emits lossless raw output within the configured deadline and exits normally.

## 7. Measure interactivity, not merely throughput

Use a PTY harness to drive Tig and timestamp:

* `j` or `k` keypress to first screenful.
* Keypress to complete view.
* Rapid `j j j` navigation.
* Navigation away from an active giant file.
* Scrolling into the large file.
* Two simultaneous Tig clients sharing the daemon.

A process that completes a giant commit in four seconds but shows raw text in 100 ms is preferable to one that completes in two seconds while freezing the view.

Report:

* Median.
* p90.
* p95.
* p99.
* Maximum.
* Confidence interval or repeated-run distribution.

Randomize A/B order. Avoid comparing one “before” warm run against one “after” cold run.

Useful system-level runs include:

* `/usr/bin/time -v`
* `perf stat`
* `perf record`
* `strace -f -c`
* Node CPU profiles.
* Node heap profiles.
* Node GC tracing.

Pin the benchmark package and Node/Shiki versions in the Nix environment, keep the machine otherwise quiet, and pin the process to a CPU where reproducibility matters.

## 8. Establish acceptance criteria

I would begin with criteria in this form, calibrating exact numbers on the reference machine:

* No client write can exceed the absolute foreground deadline.
* A giant or pathological section begins raw rendering within roughly 250–500 ms at p95.
* Rapid navigation cancels queued stale work immediately.
* Active stale CPU work stops within one worker-termination interval.
* The daemon main-thread event-loop delay remains below a small interactive bound during tokenization.
* Warm small and medium commits do not regress by more than a few percent.
* Memory reaches a plateau under a working set several times larger than the cache budget.
* Speculative work never increases foreground p95.
* Stripping syntax metadata produces byte-for-byte-equivalent raw diff content.
* Invalid, binary, textconv, worktree-race, timeout, and oversize cases all fall back losslessly.

The existing design document’s warm goals—under roughly 50 ms per normal file and roughly 30 ms for a warm medium reopen—are reasonable secondary throughput targets, but first-screenful latency and maximum blocking time should be the primary gates.

---

# Recommended implementation order

1. Add structured phase instrumentation and the fake-daemon regression suite.
2. Make the C client socket nonblocking with absolute deadlines and bounded frames.
3. Add queue-byte limits, socket backpressure, generations, and cancellation.
4. Move tokenization into one worker; terminate and replace it on hard timeout.
5. Add streaming raw fallback and benchmark-derived section/source budgets.
6. Reduce source sides, requested lines, duplicate decoding, splitting, and serialization.
7. Replace caches with byte-weighted, content-addressed, in-flight-coalescing caches.
8. Add grammar-state continuation and periodic checkpoints.
9. Fix the C fragment builder and linear style lookup.
10. Batch `check-attr`, preflight blobs through `cat-file --batch-command`, and normalize repository identities.
11. Benchmark compiled JavaScript, module compile caching, fine-grained Shiki imports, and daemon lifetime.
12. Add bounded next-file prefetch.
13. Measure actual adjacent-commit cache reuse before adding commit prefetch.
14. Consider per-hunk frames or the stronger raw-first style-span integration with Tig.

The first five items should eliminate the reported hangs even before the later optimizations make normal highlighting faster.

I did not produce speculative Shiki timing numbers: the archive did not contain installed JavaScript dependencies, and package installation was unavailable in the analysis environment. The client write-stall reproduction, Git diff measurements, cache/data-flow analysis, and source-level hotspots above are empirical; tokenizer throughput, worker count, cache budgets, checkpoint spacing, and fallback thresholds should be established with the benchmark matrix rather than guessed.

[1]: https://nodejs.org/api/worker_threads.html "https://nodejs.org/api/worker_threads.html"
[2]: https://shiki.style/guide/grammar-state "https://shiki.style/guide/grammar-state"
[3]: https://git-scm.com/docs/git-check-attr "https://git-scm.com/docs/git-check-attr"
[4]: https://git-scm.com/docs/diff-options.html "https://git-scm.com/docs/diff-options.html"
[5]: https://git-scm.com/docs/git-cat-file "https://git-scm.com/docs/git-cat-file"
[6]: https://nodejs.org/api/module.html "https://nodejs.org/api/module.html"
[7]: https://shiki.style/guide/best-performance "https://shiki.style/guide/best-performance"
[8]: https://nodejs.org/api/perf_hooks.html "https://nodejs.org/api/perf_hooks.html"
