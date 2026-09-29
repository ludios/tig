/* Model-output: Claude Fable 5 */
/* Model-output: Claude Opus 5.5 */
/* Model-output: ChatGPT 6 Astra */

/* For struct ucred (SO_PEERCRED). */
#define _GNU_SOURCE

/*
 * tig-syntax-filter: the client tig runs as its diff-syntax-filter.  It
 * streams stdin to the highlight daemon (spawning it if needed) and the
 * daemon's frames to stdout.  All input stays spooled, so if the daemon
 * is missing, dies, or stalls, the client emits the unacknowledged rest
 * of the diff raw from the spool: tig always gets output.
 *
 * One poll() loop drives the nonblocking socket in both directions.
 * While input is unacknowledged or the end frame is due, the daemon must
 * deliver a frame within FRAME_DEADLINE_MS; keepalives and partial reads
 * or writes don't re-arm the deadline.  So a wedged daemon can block tig
 * neither through a full socket buffer nor by trickling bytes.  A
 * deadline noticed well after it passed means the client itself was
 * stopped, which earns one extension per frame.
 *
 * A missing daemon is spawned and waited for up to SPAWN_WAIT_MS, since a
 * cold start can take seconds and raw output is worse than waiting.  A
 * launcher that exits with failure (no node, a crashing daemon) ends the
 * wait at once, and a spawn lock keeps a burst of clients from starting a
 * herd of daemons.
 *
 * Protocol: see src/daemon.ts.  A frame declaring more than
 * MAX_FRAME_BYTES, an output frame acknowledging nothing or more than is
 * outstanding, or an end frame while input is unacknowledged is a
 * protocol error; that, or a spool outgrowing SPOOL_MAX, triggers
 * fallback.  Fallback output frames literal ESC bytes as ESC[999m so tig's
 * SGR decoder restores them.
 *
 * Exit status is always 0: tig renders whatever arrives on the pipe.
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* A hash of the daemon's sources, from the Makefile.  It names the
 * socket, so clients built against changed daemon sources start and use a
 * daemon of their own instead of one still running the old code. */
#ifndef TIG_SYNTAX_BUILD_ID
#error "build with the Makefile, which defines TIG_SYNTAX_BUILD_ID"
#endif

#define SPOOL_MAX	(64u * 1024 * 1024)
/* Interval between connect() attempts while a spawned daemon starts.  A
 * cold start waits for the first attempt after the daemon listens (~100 ms
 * after spawn), so keep it short. */
#define CONNECT_WAIT_MS	5
/* Default limit on waiting for a spawned daemon to start listening;
 * overridable via TIG_SYNTAX_SPAWN_WAIT_MS.  Only a daemon that neither
 * listens nor exits runs into it (see connect_daemon). */
#define SPAWN_WAIT_MS	60000
/* Bounded wait for an in-progress nonblocking connect (rare on AF_UNIX;
 * happens when the daemon's accept backlog is full). */
#define CONNECT_POLL_MS	500
/* Default frame deadline; overridable via TIG_SYNTAX_DEADLINE_MS.  A
 * section's tokenization budget (daemon side) plus contention from other
 * connections must fit comfortably inside it. */
#define FRAME_DEADLINE_MS 60000
/* Lateness past the frame deadline that means we, not the daemon, were not
 * running (stopped with ^Z or SIGSTOP, or starved): poll() otherwise wakes
 * up within milliseconds of the deadline. */
#define STALL_MS	250
/* Longest path a unix socket can be bound or connected at. */
#define SOCKET_PATH_MAX	(sizeof(((struct sockaddr_un *) 0)->sun_path) - 1)
/* Sanity bound on a frame's declared payload size. */
#define MAX_FRAME_BYTES	(1ull << 30)

/* Growable byte buffer for spooled input and daemon output parsing. */
struct buf {
	unsigned char *data;
	size_t len;
	size_t cap;
};

static bool
buf_append(struct buf *buf, const unsigned char *data, size_t len)
{
	if (buf->len + len > buf->cap) {
		size_t cap = buf->cap ? buf->cap : 65536;

		while (cap < buf->len + len) {
			cap *= 2;
		}
		unsigned char *grown = realloc(buf->data, cap);

		if (grown == NULL) {
			return false;
		}
		buf->data = grown;
		buf->cap = cap;
	}
	memcpy(buf->data + buf->len, data, len);
	buf->len += len;
	return true;
}

/* Milliseconds on the monotonic clock. */
static long long
now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long) ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* The value of environment variable `name` when it parses as an integer
 * within [min, max]; `fallback` otherwise (a typo must not disable a
 * bound). */
static long long
env_ms(const char *name, long long fallback, long long min, long long max)
{
	const char *env = getenv(name);

	if (env != NULL && *env != '\0') {
		char *end = NULL;
		long val = strtol(env, &end, 10);

		if (end != NULL && *end == '\0' && val >= min && val <= max) {
			return val;
		}
	}
	return fallback;
}

/* Write all of data to fd, retrying on short writes and EINTR.  Only for
 * stdout, which may legitimately block until tig reads. */
static bool
write_all(int fd, const unsigned char *data, size_t len)
{
	while (len > 0) {
		ssize_t written = write(fd, data, len);

		if (written < 0) {
			if (errno == EINTR) {
				continue;
			}
			return false;
		}
		data += written;
		len -= (size_t) written;
	}
	return true;
}

/* Write content to stdout with literal ESC bytes framed as ESC[999m. */
static bool
write_framed(const unsigned char *data, size_t len)
{
	static const unsigned char marker[] = "\x1b[999m";

	while (len > 0) {
		const unsigned char *esc = memchr(data, 0x1b, len);
		size_t plain = esc == NULL ? len : (size_t) (esc - data);

		if (!write_all(STDOUT_FILENO, data, plain)) {
			return false;
		}
		data += plain;
		len -= plain;
		if (len > 0) {
			if (!write_all(STDOUT_FILENO, marker, sizeof(marker) - 1)) {
				return false;
			}
			data++;
			len--;
		}
	}
	return true;
}

/* Whether `dir` is a directory we own and can create a socket in.
 * $XDG_RUNTIME_DIR may name another user's directory (su from root keeps
 * /run/user/0), where connect and listen fail with EACCES; trusting it
 * would leave every diff raw. */
static bool
usable_socket_dir(const char *dir)
{
	struct stat st;

	return stat(dir, &st) == 0 && S_ISDIR(st.st_mode) &&
	       st.st_uid == geteuid() && access(dir, W_OK | X_OK) == 0;
}

/* The daemon socket path: $TIG_SYNTAX_SOCKET, or a name specific to this
 * build of the daemon in the runtime or temporary directory.  A daemon we
 * spawn is told this path. */
static void
socket_path(char *dest, size_t destlen)
{
	const char *override = getenv("TIG_SYNTAX_SOCKET");
	const char *runtime_dir = getenv("XDG_RUNTIME_DIR");
	const char *tmpdir = getenv("TMPDIR");

	if (override != NULL && *override != '\0') {
		snprintf(dest, destlen, "%s", override);
		return;
	}
	if (runtime_dir != NULL && *runtime_dir != '\0' &&
	    usable_socket_dir(runtime_dir)) {
		snprintf(dest, destlen, "%s/tig-syntax-%s.sock", runtime_dir,
			 TIG_SYNTAX_BUILD_ID);
		if (strlen(dest) <= SOCKET_PATH_MAX) {
			return;
		}
	}
	/* $TMPDIR gets the same scrutiny: a stale or unwritable value must
	 * not regress the plain-/tmp case that always worked, and neither
	 * may a directory too deep to hold a socket. */
	if (tmpdir == NULL || *tmpdir == '\0' || !usable_socket_dir(tmpdir)) {
		tmpdir = "/tmp";
	}
	snprintf(dest, destlen, "%s/tig-syntax-%ld-%s.sock", tmpdir,
		 (long) geteuid(), TIG_SYNTAX_BUILD_ID);
	if (strlen(dest) > SOCKET_PATH_MAX) {
		snprintf(dest, destlen, "/tmp/tig-syntax-%ld-%s.sock",
			 (long) geteuid(), TIG_SYNTAX_BUILD_ID);
	}
}

/* try_connect() verdicts besides a connected fd. */
#define CONNECT_ABSENT	-1	/* nothing listens (or the socket is unusable) */
#define CONNECT_BACKLOG	-2	/* a daemon listens but its accept backlog is full */
#define CONNECT_FOREIGN	-3	/* another user owns the path or its listener */

/* Connect to the daemon at `path` without blocking; a connected,
 * nonblocking fd or one of the verdicts above. */
static int
try_connect(const char *path)
{
	struct sockaddr_un addr;
	struct stat st;
	int fd;

	if (strlen(path) > SOCKET_PATH_MAX) {
		return CONNECT_ABSENT;
	}
	/* Whatever another user planted at the path (possible in the /tmp
	 * fallback) — a file, a dead socket, a listener that never accepts —
	 * no daemon of ours can ever listen there. */
	if (lstat(path, &st) == 0 && st.st_uid != geteuid()) {
		return CONNECT_FOREIGN;
	}
	fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		return CONNECT_ABSENT;
	}
	if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) {
		close(fd);
		return CONNECT_ABSENT;
	}
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strcpy(addr.sun_path, path);
	if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) != 0) {
		if (errno == EAGAIN) {
			/* Full accept backlog: a daemon listens but is busy.
			 * The caller retries rather than spawning a rival,
			 * whose liveness probe could hit the same backlog and
			 * take over the live daemon's socket path. */
			close(fd);
			return CONNECT_BACKLOG;
		}
		if (errno != EINPROGRESS) {
			close(fd);
			return CONNECT_ABSENT;
		}
		struct pollfd pfd = { fd, POLLOUT, 0 };
		int err = 0;
		socklen_t err_len = sizeof(err);

		if (poll(&pfd, 1, CONNECT_POLL_MS) <= 0 ||
		    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &err_len) != 0 ||
		    err != 0) {
			close(fd);
			return CONNECT_ABSENT;
		}
	}
#ifdef SO_PEERCRED
	/* The /tmp fallback path is predictable: never send the diff to
	 * another user's daemon.  Its own verdict ends the retries, since a
	 * daemon we spawn yields to any live listener. */
	{
		struct ucred cred;
		socklen_t cred_len = sizeof(cred);

		if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0) {
			close(fd);
			return CONNECT_ABSENT;
		}
		if (cred.uid != geteuid()) {
			close(fd);
			return CONNECT_FOREIGN;
		}
	}
#endif
	return fd;
}

/* Close every descriptor above stderr.  We inherit whatever tig had open
 * (its terminal, the pipes of its views), and the long-lived daemon must
 * not pin those for its whole lifetime. */
static void
close_inherited_fds(void)
{
#ifdef SYS_close_range
	if (syscall(SYS_close_range, 3u, ~0u, 0) == 0) {
		return;
	}
#endif
	long max = sysconf(_SC_OPEN_MAX);

	for (long fd = 3; fd < (max > 0 ? max : 1024); fd++) {
		close((int) fd);
	}
}

/*
 * Start the daemon launcher as our child in a new session, so terminal
 * signals and process-group kills aimed at us never reach it.  Staying our
 * child lets connect_daemon() see it exit without ever listening; once it
 * becomes the daemon, it outlives us unreaped.  Returns its pid, or -1
 * when fork fails.
 *
 * The child gets stdio on /dev/null (the daemon logs to a file) and no
 * other inherited descriptors, and runs $TIG_SYNTAX_DAEMON, else
 * tig-syntax-daemon next to this executable or on $PATH, telling it to
 * listen on `sock_path` via $TIG_SYNTAX_SOCKET.
 */
static pid_t
spawn_daemon(const char *sock_path)
{
	pid_t pid = fork();

	if (pid != 0) {
		return pid;
	}
	setsid();
	int devnull = open("/dev/null", O_RDWR);

	if (devnull >= 0) {
		dup2(devnull, STDIN_FILENO);
		dup2(devnull, STDOUT_FILENO);
		dup2(devnull, STDERR_FILENO);
		if (devnull > STDERR_FILENO) {
			close(devnull);
		}
	}
	close_inherited_fds();
	if (setenv("TIG_SYNTAX_SOCKET", sock_path, 1) != 0) {
		_exit(127);
	}

	const char *launcher = getenv("TIG_SYNTAX_DAEMON");

	if (launcher != NULL && *launcher != '\0') {
		execlp(launcher, launcher, (char *) NULL);
		_exit(127);
	}

	char self[PATH_MAX];
	ssize_t self_len = readlink("/proc/self/exe", self, sizeof(self) - 1);

	if (self_len > 0) {
		self[self_len] = '\0';
		char *slash = strrchr(self, '/');

		if (slash != NULL) {
			char sibling[PATH_MAX];

			*slash = '\0';
			if (snprintf(sibling, sizeof(sibling), "%s/tig-syntax-daemon", self)
			    < (int) sizeof(sibling)) {
				execl(sibling, sibling, (char *) NULL);
			}
		}
	}
	execlp("tig-syntax-daemon", "tig-syntax-daemon", (char *) NULL);
	_exit(127);
}

/* spawn_lock() verdicts besides a held lock fd. */
#define LOCK_BUSY	-2	/* another client is spawning right now */
#define LOCK_UNUSABLE	-1	/* no usable lock file; spawn regardless */

/*
 * Take the spawn lock, a flock()ed file next to the socket, so a burst of
 * clients at a cold socket (tig's warm-up, the diff view, prefetches)
 * starts one daemon, not a herd that each load grammars only for all but
 * one to lose the socket and exit.  Returns the held fd (released on exit,
 * even a crash), LOCK_BUSY, or LOCK_UNUSABLE.  The lock is only an
 * optimization; the daemons themselves settle socket ownership.
 */
static int
spawn_lock(const char *sock_path)
{
	char path[PATH_MAX];
	struct stat st;
	int fd;

	if (snprintf(path, sizeof(path), "%s.lock", sock_path) >= (int) sizeof(path)) {
		return LOCK_UNUSABLE;
	}
	fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
	if (fd < 0) {
		return LOCK_UNUSABLE;
	}
	/* A lock file planted by another user (possible in the /tmp
	 * fallback) must not be able to stall every client. */
	if (fstat(fd, &st) != 0 || st.st_uid != geteuid()) {
		close(fd);
		return LOCK_UNUSABLE;
	}
	if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
		int busy = errno == EWOULDBLOCK || errno == EAGAIN;

		close(fd);
		return busy ? LOCK_BUSY : LOCK_UNUSABLE;
	}
	return fd;
}

/*
 * Connect to the daemon, spawning it when nothing listens; -1 when no
 * daemon becomes reachable.  connect() is retried every CONNECT_WAIT_MS
 * for up to the spawn wait, which ends early when our launcher exits with
 * failure or another user owns the path.  A launcher's success is
 * inconclusive (it may have yielded to a live daemon or daemonized), so
 * retries continue.  While another client holds the spawn lock, we only
 * retry, spawning if the lock frees without a daemon.
 */
static int
connect_daemon(void)
{
	char path[512];
	const long long wait_ms = env_ms("TIG_SYNTAX_SPAWN_WAIT_MS", SPAWN_WAIT_MS, 100, 600000);
	long long give_up;
	int lock_fd = LOCK_UNUSABLE;
	bool spawned = false;
	pid_t child = 0;
	int fd;

	socket_path(path, sizeof(path));
	if (strlen(path) > SOCKET_PATH_MAX) {
		/* Only an explicit $TIG_SYNTAX_SOCKET gets here; no daemon we
		 * spawn could ever listen at it. */
		return -1;
	}
	fd = try_connect(path);
	if (fd >= 0) {
		return fd;
	}
	give_up = now_ms() + wait_ms;
	while (fd != CONNECT_FOREIGN) {
		struct timespec wait = { 0, CONNECT_WAIT_MS * 1000000L };

		if (!spawned && fd == CONNECT_ABSENT) {
			lock_fd = spawn_lock(path);
			if (lock_fd != LOCK_BUSY) {
				child = spawn_daemon(path);
				spawned = true;
				if (child < 0) {
					break;
				}
			}
		}
		if (child > 0) {
			int status;

			if (waitpid(child, &status, WNOHANG) == child) {
				child = 0;
				if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
					break;
				}
			}
		}
		if (now_ms() >= give_up) {
			break;
		}
		nanosleep(&wait, NULL);
		fd = try_connect(path);
		if (fd >= 0) {
			break;
		}
	}
	if (lock_fd >= 0) {
		close(lock_fd);
	}
	return fd >= 0 ? fd : -1;
}

/* Emit spool[acked..] framed, then stream the rest of stdin framed. */
static int
fallback_passthrough(struct buf *spool, size_t acked, bool stdin_open)
{
	unsigned char chunk[65536];

	if (spool->len > acked) {
		write_framed(spool->data + acked, spool->len - acked);
	}
	while (stdin_open) {
		ssize_t got = read(STDIN_FILENO, chunk, sizeof(chunk));

		if (got < 0 && errno == EINTR) {
			continue;
		}
		if (got <= 0) {
			break;
		}
		if (!write_framed(chunk, (size_t) got)) {
			break;
		}
	}
	return 0;
}

/*
 * Parse and emit complete daemon frames from `inbox`.  Advances *acked by
 * each frame's consumed-input count and compacts the inbox.  A frame may
 * only acknowledge bytes that were actually sent and are still
 * unacknowledged.  Returns 1 on clean end frame, 0 to continue, -1 on
 * protocol error.
 */
static int
drain_frames(struct buf *inbox, size_t *acked, size_t sent)
{
	int progressed = 0;

	while (true) {
		unsigned char *newline = memchr(inbox->data, '\n', inbox->len);
		size_t header_len;
		unsigned long long consumed, out_len;
		char kind;

		if (newline == NULL) {
			if (inbox->len > 128) {
				return -1;
			}
			return progressed;
		}
		header_len = (size_t) (newline - inbox->data) + 1;
		{
			char header[130];

			if (header_len >= sizeof(header)) {
				return -1;
			}
			memcpy(header, inbox->data, header_len);
			header[header_len] = '\0';
			if (sscanf(header, "%c %llu %llu", &kind, &consumed, &out_len) == 3
			    && kind == 'O') {
				/* fall through to payload handling */
			} else if (sscanf(header, "%c %llu", &kind, &consumed) == 2
				   && kind == 'E') {
				return 1;
			} else if (sscanf(header, "%c %llu", &kind, &consumed) == 2
				   && kind == 'P') {
				/* Keepalive probe from the daemon: no payload,
				 * acknowledges nothing, and must not re-arm
				 * the deadline. */
				memmove(inbox->data, inbox->data + header_len,
					inbox->len - header_len);
				inbox->len -= header_len;
				continue;
			} else {
				return -1;
			}
		}
		if (out_len > MAX_FRAME_BYTES) {
			return -1;
		}
		/* An output frame must acknowledge input: one that doesn't
		 * would re-arm the deadline without progress, and its
		 * payload would be output for no input. */
		if (consumed == 0) {
			return -1;
		}
		if (consumed > (unsigned long long) (sent - *acked)) {
			return -1;
		}
		if (inbox->len - header_len < out_len) {
			return progressed;
		}
		if (!write_all(STDOUT_FILENO, inbox->data + header_len, out_len)) {
			return -1;
		}
		*acked += consumed;
		progressed = 2;
		{
			size_t total = header_len + out_len;

			memmove(inbox->data, inbox->data + total, inbox->len - total);
			inbox->len -= total;
		}
	}
}

int
main(void)
{
	struct buf spool = { NULL, 0, 0 };
	struct buf inbox = { NULL, 0, 0 };
	size_t acked = 0;		/* spool bytes emitted via daemon frames */
	size_t sent = 0;		/* spool bytes written to the daemon */
	bool stdin_open = true;
	bool wr_shutdown = false;
	char header[PATH_MAX + 32];
	size_t header_len;
	size_t header_sent = 0;
	long long deadline = 0;		/* 0 = disarmed */
	bool stall_forgiven = false;	/* since the last completed frame */
	const long long deadline_ms = env_ms("TIG_SYNTAX_DEADLINE_MS", FRAME_DEADLINE_MS, 100, 600000);
	int daemon_fd;

	signal(SIGPIPE, SIG_IGN);

	daemon_fd = connect_daemon();
	if (daemon_fd < 0) {
		return fallback_passthrough(&spool, 0, true);
	}

	{
		char cwd[PATH_MAX];

		if (getcwd(cwd, sizeof(cwd)) == NULL) {
			strcpy(cwd, "/");
		}
		header_len = (size_t) snprintf(header, sizeof(header), "TIGSYN1 %zu\n%s",
					       strlen(cwd), cwd);
	}

	while (true) {
		struct pollfd fds[2];
		int nfds = 0;
		int stdin_slot = -1, daemon_slot;
		bool want_write = header_sent < header_len || sent < spool.len;
		int timeout = -1;

		if (stdin_open) {
			stdin_slot = nfds;
			fds[nfds].fd = STDIN_FILENO;
			fds[nfds].events = POLLIN;
			nfds++;
		}
		daemon_slot = nfds;
		fds[nfds].fd = daemon_fd;
		fds[nfds].events = POLLIN | (want_write ? POLLOUT : 0);
		nfds++;

		if (deadline != 0) {
			long long remain = deadline - now_ms();

			if (remain < 0) {
				remain = 0;
			}
			timeout = remain > INT_MAX ? INT_MAX : (int) remain;
		}

		int ready = poll(fds, (nfds_t) nfds, timeout);

		if (ready < 0) {
			if (errno == EINTR) {
				continue;
			}
			goto fallback;
		}

		if (fds[daemon_slot].revents & (POLLIN | POLLHUP | POLLERR)) {
			unsigned char chunk[65536];
			ssize_t got = read(daemon_fd, chunk, sizeof(chunk));

			if (got < 0 && (errno == EINTR || errno == EAGAIN ||
					errno == EWOULDBLOCK)) {
				/* nothing readable after all */
			} else if (got <= 0) {
				goto fallback;
			} else {
				if (!buf_append(&inbox, chunk, (size_t) got)) {
					goto fallback;
				}
				int state = drain_frames(&inbox, &acked, sent);

				if (state == 1) {
					/* An end frame is only valid once all input
					 * was acknowledged; otherwise it would drop
					 * the tail of the diff. */
					if (acked == spool.len && !stdin_open) {
						return 0;
					}
					goto fallback;
				}
				if (state == -1) {
					goto fallback;
				}
				if (state == 2) {
					stall_forgiven = false;
					/* Re-arm after an output frame, or
					 * disarm while everything is
					 * acknowledged and we only wait for
					 * more stdin. */
					if (acked == spool.len && stdin_open) {
						deadline = 0;
					} else {
						deadline = now_ms() + deadline_ms;
					}
				}
			}
		}

		if (fds[daemon_slot].revents & POLLOUT) {
			bool write_failed = false;

			while (header_sent < header_len) {
				ssize_t n = write(daemon_fd, header + header_sent,
						  header_len - header_sent);

				if (n < 0) {
					if (errno == EINTR) {
						continue;
					}
					if (errno == EAGAIN || errno == EWOULDBLOCK) {
						break;
					}
					write_failed = true;
					break;
				}
				header_sent += (size_t) n;
			}
			while (!write_failed && header_sent == header_len &&
			       sent < spool.len) {
				ssize_t n = write(daemon_fd, spool.data + sent,
						  spool.len - sent);

				if (n < 0) {
					if (errno == EINTR) {
						continue;
					}
					if (errno == EAGAIN || errno == EWOULDBLOCK) {
						break;
					}
					write_failed = true;
					break;
				}
				sent += (size_t) n;
			}
			if (write_failed) {
				goto fallback;
			}
			if (!stdin_open && !wr_shutdown &&
			    header_sent == header_len && sent == spool.len) {
				shutdown(daemon_fd, SHUT_WR);
				wr_shutdown = true;
			}
		}

		if (stdin_slot >= 0 && (fds[stdin_slot].revents & (POLLIN | POLLHUP))) {
			unsigned char chunk[65536];
			ssize_t got = read(STDIN_FILENO, chunk, sizeof(chunk));

			if (got < 0 && errno != EINTR) {
				got = 0;
			}
			if (got == 0) {
				stdin_open = false;
				if (header_sent == header_len && sent == spool.len &&
				    !wr_shutdown) {
					shutdown(daemon_fd, SHUT_WR);
					wr_shutdown = true;
				}
				/* Still owed acknowledgments and the end frame. */
				if (deadline == 0) {
					deadline = now_ms() + deadline_ms;
				}
			} else if (got > 0) {
				if (!buf_append(&spool, chunk, (size_t) got)) {
					/* The chunk is already consumed from
					 * stdin: emit it after the spool so
					 * fallback loses nothing. */
					close(daemon_fd);
					if (spool.len > acked) {
						write_framed(spool.data + acked, spool.len - acked);
					}
					write_framed(chunk, (size_t) got);
					return fallback_passthrough(&spool, spool.len, stdin_open);
				}
				if (spool.len > SPOOL_MAX) {
					goto fallback;
				}
				if (deadline == 0) {
					deadline = now_ms() + deadline_ms;
				}
			}
		}

		long long now = now_ms();

		/* Checking the deadline well after it passed means we were not
		 * running, and the daemon may have finished meanwhile (its frame
		 * waiting partly in the socket, partly in the daemon): time we
		 * could not read must not count against it.  Once per frame, so
		 * that sustained starvation cannot shield a wedged daemon. */
		if (deadline != 0 && now > deadline + STALL_MS && !stall_forgiven) {
			deadline = now + deadline_ms;
			stall_forgiven = true;
		} else if (deadline != 0 && now >= deadline) {
			/* The daemon failed to complete a frame in time. */
			goto fallback;
		}
	}

fallback:
	/* Abandon the daemon and emit what it has not acknowledged raw;
	 * with everything acknowledged and stdin closed, only the end
	 * frame was missing and this emits nothing. */
	close(daemon_fd);
	return fallback_passthrough(&spool, acked, stdin_open);
}
