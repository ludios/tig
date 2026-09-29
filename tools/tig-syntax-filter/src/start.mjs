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
 * The cache lives in $XDG_CACHE_HOME/tig-syntax; node keys its entries by
 * node version and each file's content.  NODE_DISABLE_COMPILE_CACHE=1
 * turns it off.
 */

import { constants, enableCompileCache, flushCompileCache } from "node:module";
import { join, resolve } from "node:path";

// Relative settings mean the spawning client's cwd, as in daemon.ts.
const cache_home = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "/tmp", ".cache");
const cache = enableCompileCache(resolve(cache_home, "tig-syntax", "node-compile-cache"));

await import("./daemon.ts");
if (cache.status === constants.compileCacheStatus.FAILED) {
	const { getLogger } = await import("@logtape/logtape");
	getLogger(["tig-syntax", "daemon"]).warn("starting without a compile cache: {message}", {
		message: cache.message,
	});
} else {
	flushCompileCache();
}
