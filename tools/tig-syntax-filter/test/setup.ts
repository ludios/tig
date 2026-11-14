/**
 * Runs in every test file's worker before the file's tests.
 *
 * Removes the environment variables that select a git repository
 * (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...), which a git hook or
 * another harness may have set.  Left in place, they would send the
 * fixtures' `git -C <scratch dir> init/add/commit`, and the git commands
 * of the modules under test, to that repository instead.
 */

import { execFileSync } from "node:child_process";

const repo_env_vars = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
	.split("\n")
	.filter((name) => name !== "");
for (const name of repo_env_vars) {
	delete process.env[name];
}
