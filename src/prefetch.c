/* Model-output: Claude Fable 5 */

/* Copyright (c) 2006-2026 Jonas Fonseca <jonas.fonseca@gmail.com>
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

#include "tig/tig.h"
#include "tig/io.h"
#include "tig/options.h"
#include "tig/apps.h"
#include "tig/prefetch.h"

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* How many commits past the selection to keep warm. */
#define PREFETCH_JOBS		2
/* How long the selection must sit still before prefetching starts; rapid
 * navigation only ever restarts this clock. */
#define PREFETCH_DEBOUNCE_MS	150

struct prefetch_job {
	char id[SIZEOF_REV];
	pid_t pgid;		/* Pipeline's process group; 0 = slot free. */
};

static struct prefetch_job prefetch_jobs[PREFETCH_JOBS];
static char prefetch_pending[PREFETCH_JOBS][SIZEOF_REV];
static size_t prefetch_pending_count;
static long long prefetch_pending_since;

static bool
prefetch_jobs_active(void)
{
	int i;

	for (i = 0; i < PREFETCH_JOBS; i++)
		if (prefetch_jobs[i].pgid > 0)
			return true;
	return false;
}

/* Exit handler: running pipelines must not outlive tig. */
static void
prefetch_shutdown(void)
{
	int i;

	for (i = 0; i < PREFETCH_JOBS; i++)
		if (prefetch_jobs[i].pgid > 0)
			kill(-prefetch_jobs[i].pgid, SIGKILL);
}

static long long
prefetch_now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long) ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Collect any finished prefetch pipelines; never blocks.  A finished
 * job's id is retained as a memo so re-selecting the same commit does not
 * respawn a prefetch whose results the daemon already caches. */
static void
prefetch_reap(void)
{
	int i;

	for (i = 0; i < PREFETCH_JOBS; i++) {
		struct prefetch_job *job = &prefetch_jobs[i];

		if (job->pgid > 0 && waitpid(job->pgid, NULL, WNOHANG) == job->pgid)
			job->pgid = 0;
	}
}

/* Kill one pipeline's whole process group and reap its leader.  The filter
 * client dying mid-request is safe by design: the daemon's keepalive probe
 * notices and cancels the abandoned tokenization. */
static void
prefetch_kill(struct prefetch_job *job)
{
	if (job->pgid <= 0)
		return;
	kill(-job->pgid, SIGKILL);
	while (waitpid(job->pgid, NULL, 0) < 0 && errno == EINTR)
		;
	job->pgid = 0;
	job->id[0] = 0;
}

static bool
prefetch_id_in(const char *id, const char *ids[], size_t ids_len)
{
	size_t i;

	for (i = 0; i < ids_len; i++)
		if (!strcmp(id, ids[i]))
			return true;
	return false;
}

/* Spawn `git show <id> | <filter> > /dev/null` as one process group led by
 * the filter process, so the pair can be killed together. */
static pid_t
prefetch_spawn(const char *id, struct app_external *app)
{
	const char *candidates[] = {
		"git", "show", encoding_arg, "--pretty=fuller", "--root",
			"--patch-with-stat", show_notes_arg(),
			diff_context_arg(), ignore_space_arg(), "--no-color",
			NULL
	};
	const char *show_argv[32];
	size_t argc = 0;
	int pipefds[2];
	pid_t pid;
	size_t arg;

	/* Mirror the diff view's hunk-affecting options: the option helpers
	 * return "" when disabled (the diff view's argv_format drops those,
	 * but a direct exec must not hand git empty arguments), and the
	 * user's diff-options change hunk shapes, so cache keys only match
	 * when they are included. */
	for (arg = 0; candidates[arg]; arg++)
		if (*candidates[arg])
			show_argv[argc++] = candidates[arg];
	for (arg = 0; opt_diff_options && opt_diff_options[arg] &&
		      argc < ARRAY_SIZE(show_argv) - 2; arg++)
		show_argv[argc++] = opt_diff_options[arg];
	show_argv[argc++] = id;
	show_argv[argc] = NULL;

	if (pipe(pipefds) < 0)
		return -1;

	pid = fork();
	if (pid < 0) {
		close(pipefds[0]);
		close(pipefds[1]);
		return -1;
	}
	if (pid > 0) {
		/* Parent: mirror the child's setpgid to close the race. */
		setpgid(pid, pid);
		close(pipefds[0]);
		close(pipefds[1]);
		return pid;
	}

	/* Filter process, its own group's leader. */
	setpgid(0, 0);
	signal(SIGPIPE, SIG_DFL);
	{
		int devnull = open("/dev/null", O_RDWR);
		pid_t git_pid = fork();

		if (git_pid == 0) {
			/* git show, writing into the pipe. */
			if (dup2(pipefds[1], STDOUT_FILENO) < 0)
				_exit(127);
			if (devnull >= 0)
				dup2(devnull, STDERR_FILENO);
			close(pipefds[0]);
			close(pipefds[1]);
			execvp(show_argv[0], (char *const *) show_argv);
			_exit(127);
		}
		if (git_pid < 0 || dup2(pipefds[0], STDIN_FILENO) < 0 ||
		    devnull < 0 || dup2(devnull, STDOUT_FILENO) < 0)
			_exit(127);
		dup2(devnull, STDERR_FILENO);
		close(pipefds[0]);
		close(pipefds[1]);
		execvp(app->argv[0], (char *const *) app->argv);
		_exit(127);
	}
}

void
prefetch_request(const char *ids[], size_t ids_len)
{
	size_t i;
	int job;

	if (!opt_diff_prefetch || opt_word_diff ||
	    !opt_diff_syntax_filter || !*opt_diff_syntax_filter ||
	    (opt_file_args && opt_file_args[0])) {
		/* Disabled (or the diff is file-filtered, which the prefetch
		 * pipeline does not replicate): cancel and forget everything,
		 * so a live :set change takes effect immediately. */
		for (job = 0; job < PREFETCH_JOBS; job++) {
			prefetch_kill(&prefetch_jobs[job]);
			prefetch_jobs[job].id[0] = 0;
		}
		prefetch_pending_count = 0;
		return;
	}

	prefetch_reap();

	/* A moved selection invalidates running prefetches it no longer
	 * wants; completed memos for unwanted commits merely expire. */
	for (job = 0; job < PREFETCH_JOBS; job++) {
		if (!prefetch_id_in(prefetch_jobs[job].id, ids, ids_len)) {
			if (prefetch_jobs[job].pgid > 0)
				prefetch_kill(&prefetch_jobs[job]);
			else
				prefetch_jobs[job].id[0] = 0;
		}
	}

	prefetch_pending_count = 0;
	for (i = 0; i < ids_len && i < PREFETCH_JOBS; i++) {
		bool known = false;

		for (job = 0; job < PREFETCH_JOBS; job++)
			if (!strcmp(prefetch_jobs[job].id, ids[i]))
				known = true;
		if (known)
			continue;
		string_copy_rev(prefetch_pending[prefetch_pending_count], ids[i]);
		prefetch_pending_count++;
	}
	prefetch_pending_since = prefetch_now_ms();
}

int
prefetch_adjust_delay(int delay)
{
	long long remaining;

	if (prefetch_pending_count == 0) {
		/* Poll occasionally while pipelines run so they get reaped
		 * even if the user stays idle. */
		if (prefetch_jobs_active() && (delay < 0 || delay > 1000))
			return 1000;
		return delay;
	}
	remaining = PREFETCH_DEBOUNCE_MS - (prefetch_now_ms() - prefetch_pending_since);
	if (remaining < 1)
		remaining = 1;
	if (delay < 0 || delay > remaining)
		return (int) remaining;
	return delay;
}

void
prefetch_idle(void)
{
	struct app_external *app;
	size_t i;
	int job;

	prefetch_reap();

	if (prefetch_pending_count == 0 ||
	    prefetch_now_ms() - prefetch_pending_since < PREFETCH_DEBOUNCE_MS)
		return;

	app = app_syntax_filter_load(opt_diff_syntax_filter);
	if (!*app->argv) {
		prefetch_pending_count = 0;
		return;
	}

	for (i = 0; i < prefetch_pending_count; i++) {
		struct prefetch_job *slot = NULL;

		/* Prefer slots holding nothing over completed-job memos, so
		 * launching one new commit does not erase the memo that stops
		 * another from being redone. */
		for (job = 0; job < PREFETCH_JOBS && !slot; job++)
			if (prefetch_jobs[job].pgid == 0 && !prefetch_jobs[job].id[0])
				slot = &prefetch_jobs[job];
		for (job = 0; job < PREFETCH_JOBS && !slot; job++)
			if (prefetch_jobs[job].pgid == 0)
				slot = &prefetch_jobs[job];
		if (!slot) {
			/* All slots busy with still-wanted commits. */
			break;
		}
		slot->pgid = prefetch_spawn(prefetch_pending[i], app);
		if (slot->pgid > 0) {
			static bool at_exit_registered;

			string_copy_rev(slot->id, prefetch_pending[i]);
			if (!at_exit_registered) {
				at_exit_registered = true;
				atexit(prefetch_shutdown);
			}
		} else {
			slot->pgid = 0;
		}
	}
	prefetch_pending_count = 0;
}

/* vim: set ts=8 sw=8 noexpandtab: */
