/* Model-output: Claude Fable 5 */

/* For struct ucred (SO_PEERCRED). */
#define _GNU_SOURCE

/*
 * tig-syntax-filter: the thin, transactional client tig runs as its
 * diff-syntax-filter.  It streams stdin to the highlight daemon (spawning
 * it on first use) and daemon frames to stdout.  All unacknowledged input
 * stays spooled, so if the daemon is missing, dies, or stalls, the client
 * emits the raw diff from the spool instead — tig always gets output.
 *
 * The daemon socket is nonblocking and both directions are driven through
 * one poll() loop, under an ABSOLUTE deadline: whenever input bytes are
 * outstanding (sent or ready to send, but not yet acknowledged by a
 * complete frame), the daemon has FRAME_DEADLINE_MS to complete a frame.
 * Only a completed frame re-arms the deadline — partial writes, partial
 * reads, or a daemon trickling bytes do not.  A wedged daemon therefore
 * can never block tig: neither in write() (the socket buffer filling up
 * no longer matters) nor by dribbling just enough traffic to look alive.
 *
 * Daemon protocol: see src/daemon.ts.  Frames are validated: a declared
 * payload above MAX_FRAME_BYTES or an acknowledgment for more bytes than
 * are actually outstanding is a protocol error and triggers fallback.
 * In fallback output, literal ESC bytes are framed as ESC[999m so tig's
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
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SPOOL_MAX	(64u * 1024 * 1024)
#define CONNECT_TRIES	60
#define CONNECT_WAIT_MS	50
/* Bounded wait for an in-progress nonblocking connect (rare on AF_UNIX;
 * happens when the daemon's accept backlog is full). */
#define CONNECT_POLL_MS	500
/* Default frame deadline; overridable via TIG_SYNTAX_DEADLINE_MS. */
#define FRAME_DEADLINE_MS 15000
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

/* The configured frame deadline in ms ($TIG_SYNTAX_DEADLINE_MS or default). */
static long long
frame_deadline_ms(void)
{
	const char *env = getenv("TIG_SYNTAX_DEADLINE_MS");

	if (env != NULL && *env != '\0') {
		char *end = NULL;
		long val = strtol(env, &end, 10);

		if (end != NULL && *end == '\0' && val >= 100 && val <= 600000) {
			return val;
		}
	}
	return FRAME_DEADLINE_MS;
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
 * $XDG_RUNTIME_DIR can name another user's directory (e.g. a session
 * su'd from root keeps /run/user/0), where both connecting and
 * listening fail with EACCES — such a value must be ignored, not
 * obeyed into permanent raw passthrough. */
static bool
usable_socket_dir(const char *dir)
{
	struct stat st;

	return stat(dir, &st) == 0 && S_ISDIR(st.st_mode) &&
	       st.st_uid == geteuid() && access(dir, W_OK | X_OK) == 0;
}

/* The daemon socket path, mirroring socket_path() in daemon.ts (the two
 * must agree in any environment, or the spawned daemon listens where no
 * client looks). */
static void
socket_path(char *dest, size_t destlen)
{
	const char *override = getenv("TIG_SYNTAX_SOCKET");
	const char *runtime_dir = getenv("XDG_RUNTIME_DIR");
	const char *tmpdir = getenv("TMPDIR");

	if (override != NULL && *override != '\0') {
		snprintf(dest, destlen, "%s", override);
	} else if (runtime_dir != NULL && *runtime_dir != '\0' &&
		   usable_socket_dir(runtime_dir)) {
		snprintf(dest, destlen, "%s/tig-syntax.sock", runtime_dir);
	} else {
		/* $TMPDIR gets the same scrutiny: a stale or unwritable value
		 * must not regress the plain-/tmp case that always worked. */
		if (tmpdir == NULL || *tmpdir == '\0' ||
		    !usable_socket_dir(tmpdir)) {
			tmpdir = "/tmp";
		}
		snprintf(dest, destlen, "%s/tig-syntax-%ld.sock", tmpdir,
			 (long) geteuid());
	}
}

static int
try_connect(const char *path)
{
	struct sockaddr_un addr;
	int fd;

	if (strlen(path) >= sizeof(addr.sun_path)) {
		return -1;
	}
	fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		return -1;
	}
	if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) {
		close(fd);
		return -1;
	}
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strcpy(addr.sun_path, path);
	if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) != 0) {
		if (errno == EAGAIN) {
			/* Full accept backlog: a daemon exists but is not
			 * accepting right now.  Distinct from absence, so the
			 * caller retries without spawning a competitor (whose
			 * liveness probe could hit the same full backlog and
			 * steal the live daemon's socket path). */
			close(fd);
			return -2;
		}
		if (errno != EINPROGRESS) {
			close(fd);
			return -1;
		}
		struct pollfd pfd = { fd, POLLOUT, 0 };
		int err = 0;
		socklen_t err_len = sizeof(err);

		if (poll(&pfd, 1, CONNECT_POLL_MS) <= 0 ||
		    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &err_len) != 0 ||
		    err != 0) {
			close(fd);
			return -1;
		}
	}
#ifdef SO_PEERCRED
	/* The socket path can be predictable (/tmp fallback); never hand the
	 * repository's diff to a daemon owned by another user. */
	{
		struct ucred cred;
		socklen_t cred_len = sizeof(cred);

		if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0 ||
		    cred.uid != geteuid()) {
			close(fd);
			return -1;
		}
	}
#endif
	return fd;
}

/*
 * Start the daemon, detached: double-fork so it survives us, stdio to
 * /dev/null (it logs to a file itself).  The launcher is found via
 * $TIG_SYNTAX_DAEMON, next to this executable, or on $PATH.
 */
static void
spawn_daemon(void)
{
	pid_t pid = fork();

	if (pid != 0) {
		if (pid > 0) {
			waitpid(pid, NULL, 0);
		}
		return;
	}

	if (fork() != 0) {
		_exit(0);
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

/* Connect to the daemon, spawning it if needed; -1 when unavailable. */
static int
connect_daemon(void)
{
	char path[512];
	int fd = -1;
	int attempt;

	socket_path(path, sizeof(path));
	fd = try_connect(path);
	if (fd >= 0) {
		return fd;
	}
	if (fd != -2) {
		spawn_daemon();
	}
	for (attempt = 0; attempt < CONNECT_TRIES; attempt++) {
		struct timespec wait = { 0, CONNECT_WAIT_MS * 1000000L };

		nanosleep(&wait, NULL);
		fd = try_connect(path);
		if (fd >= 0) {
			return fd;
		}
	}
	return -1;
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
				/* Keepalive: the daemon probes whether we are still
				 * here.  No payload, acknowledges nothing, and is
				 * NOT progress — it must never re-arm the deadline. */
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
		/* A frame that consumes no input is not progress (a stream of
		 * them must not re-arm the deadline) and any payload on it
		 * would be output corresponding to no input; reject both. */
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
	const long long deadline_ms = frame_deadline_ms();
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
			close(daemon_fd);
			return fallback_passthrough(&spool, acked, stdin_open);
		}

		if (fds[daemon_slot].revents & (POLLIN | POLLHUP | POLLERR)) {
			unsigned char chunk[65536];
			ssize_t got = read(daemon_fd, chunk, sizeof(chunk));

			if (got < 0 && (errno == EINTR || errno == EAGAIN ||
					errno == EWOULDBLOCK)) {
				/* nothing readable after all */
			} else if (got <= 0) {
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
			} else {
				if (!buf_append(&inbox, chunk, (size_t) got)) {
					close(daemon_fd);
					return fallback_passthrough(&spool, acked, stdin_open);
				}
				int state = drain_frames(&inbox, &acked, sent);

				if (state == 1) {
					return 0;
				}
				if (state == -1) {
					close(daemon_fd);
					return fallback_passthrough(&spool, acked, stdin_open);
				}
				if (state == 2) {
					/* A complete frame is progress: re-arm.
					 * With everything acknowledged and stdin
					 * still open there is no outstanding work
					 * (a slow git must not trip the deadline),
					 * so disarm until more input arrives. */
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
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
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
					close(daemon_fd);
					return fallback_passthrough(&spool, acked, stdin_open);
				}
				if (deadline == 0) {
					deadline = now_ms() + deadline_ms;
				}
			}
		}

		if (deadline != 0 && now_ms() >= deadline) {
			/* The daemon failed to complete a frame in time. */
			close(daemon_fd);
			if (acked < spool.len || stdin_open) {
				return fallback_passthrough(&spool, acked, stdin_open);
			}
			/* Everything is emitted and only the end frame is
			 * missing; there is nothing left to recover. */
			return 0;
		}
	}
}
