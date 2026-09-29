// Model-output: Claude Opus 5.5

/**
 * Entry point of the tig-syntax highlight daemon (daemon.ts).
 *
 * Turns on node's compile cache before loading the daemon's modules, so a
 * restarted daemon reuses their compiled, type-stripped code and listens
 * sooner.  Plain JavaScript on purpose: as the one module loaded before the
 * cache is on, a TypeScript entry would make node start its type stripper
 * on every launch.  Node writes the cache only at a clean exit, which a
 * daemon killed by a signal never reaches, so it is flushed once the daemon
 * has begun listening (daemon.ts's top-level await resolves then).
 *
 * Node files cache entries by its own version and each module's absolute
 * path, and discards an entry whose source changed; an install at a new
 * path starts afresh.  NODE_DISABLE_COMPILE_CACHE=1 turns the cache off.
 */

import { constants, enableCompileCache, flushCompileCache } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The compile cache's directory under $XDG_CACHE_HOME or ~/.cache, or null
 * without an absolute one.  The cache holds code that node runs, so a
 * relative or empty setting, which would resolve inside the repository
 * being viewed, is never used, and neither is a shared /tmp fallback.
 * @returns {string | null}
 */
function cache_dir() {
	const xdg = process.env.XDG_CACHE_HOME;
	if (xdg !== undefined && isAbsolute(xdg)) {
		return join(xdg, "tig-syntax", "node-compile-cache");
	}
	const home = homedir();
	return isAbsolute(home) ? join(home, ".cache", "tig-syntax", "node-compile-cache") : null;
}

const dir = cache_dir();
const cache = dir === null
	? { status: constants.compileCacheStatus.FAILED, message: "no absolute $XDG_CACHE_HOME or home directory" }
	: enableCompileCache(dir);

await import("./daemon.ts");
if (cache.status === constants.compileCacheStatus.FAILED) {
	const { getLogger } = await import("@logtape/logtape");
	getLogger(["tig-syntax", "daemon"]).warn("starting without a compile cache: {message}", {
		message: cache.message,
	});
} else {
	flushCompileCache();
}
