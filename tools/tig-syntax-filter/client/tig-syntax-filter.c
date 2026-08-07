/* Model-output: Claude Fable 5 */

/*
 * tig-syntax-filter: the thin, transactional client tig runs as its
 * diff-syntax-filter.  It streams stdin to the highlight daemon (spawning
 * it on first use) and daemon frames to stdout.  All unacknowledged input
 * stays spooled, so if the daemon is missing, dies, or stalls, the client
 * emits the raw diff from the spool instead — tig always gets output.
 *
 * Daemon protocol: see src/daemon.ts.  In fallback output, literal ESC
 * bytes are framed as ESC[999m so tig's SGR decoder restores them.
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
#define FRAME_TIMEOUT_MS 15000

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

/* Write all of data to fd, retrying on short writes and EINTR. */
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

/* The daemon socket path, mirroring socket_path() in daemon.ts. */
static void
socket_path(char *dest, size_t destlen)
{
	const char *override = getenv("TIG_SYNTAX_SOCKET");
	const char *runtime_dir = getenv("XDG_RUNTIME_DIR");

	if (override != NULL && *override != '\0') {
		snprintf(dest, destlen, "%s", override);
	} else if (runtime_dir != NULL && *runtime_dir != '\0') {
		snprintf(dest, destlen, "%s/tig-syntax.sock", runtime_dir);
	} else {
		snprintf(dest, destlen, "/tmp/tig-syntax-%ld.sock", (long) getuid());
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
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strcpy(addr.sun_path, path);
	if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) != 0) {
		close(fd);
		return -1;
	}
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

	spawn_daemon();
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
 * each frame's consumed-input count and compacts the inbox.  Returns 1 on
 * clean end frame, 0 to continue, -1 on protocol error.
 */
static int
drain_frames(struct buf *inbox, size_t *acked)
{
	while (true) {
		unsigned char *newline = memchr(inbox->data, '\n', inbox->len);
		size_t header_len;
		unsigned long long consumed, out_len;
		char kind;

		if (newline == NULL) {
			if (inbox->len > 128) {
				return -1;
			}
			return 0;
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
			} else {
				return -1;
			}
		}
		if (inbox->len - header_len < out_len) {
			return 0;
		}
		if (!write_all(STDOUT_FILENO, inbox->data + header_len, out_len)) {
			return -1;
		}
		*acked += consumed;
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
	size_t acked = 0;
	size_t sent = 0;
	bool stdin_open = true;
	int daemon_fd;

	signal(SIGPIPE, SIG_IGN);

	daemon_fd = connect_daemon();
	if (daemon_fd < 0) {
		return fallback_passthrough(&spool, 0, true);
	}

	{
		char cwd[PATH_MAX];
		char header[PATH_MAX + 32];
		int header_len;

		if (getcwd(cwd, sizeof(cwd)) == NULL) {
			strcpy(cwd, "/");
		}
		header_len = snprintf(header, sizeof(header), "TIGSYN1 %zu\n%s",
				      strlen(cwd), cwd);
		if (!write_all(daemon_fd, (unsigned char *) header, (size_t) header_len)) {
			close(daemon_fd);
			return fallback_passthrough(&spool, 0, true);
		}
	}

	while (true) {
		struct pollfd fds[2];
		int nfds = 0;
		int stdin_slot = -1, daemon_slot = -1;

		if (stdin_open && sent == spool.len) {
			stdin_slot = nfds;
			fds[nfds].fd = STDIN_FILENO;
			fds[nfds].events = POLLIN;
			nfds++;
		}
		daemon_slot = nfds;
		fds[nfds].fd = daemon_fd;
		fds[nfds].events = POLLIN;
		nfds++;

		int ready = poll(fds, (nfds_t) nfds, FRAME_TIMEOUT_MS);

		if (ready < 0 && errno == EINTR) {
			continue;
		}
		if (ready == 0) {
			/* The daemon stalled with work outstanding. */
			if (acked < spool.len || stdin_open) {
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
			}
			continue;
		}

		if (stdin_slot >= 0 && (fds[stdin_slot].revents & (POLLIN | POLLHUP))) {
			unsigned char chunk[65536];
			ssize_t got = read(STDIN_FILENO, chunk, sizeof(chunk));

			if (got < 0 && errno != EINTR) {
				got = 0;
			}
			if (got == 0) {
				stdin_open = false;
				shutdown(daemon_fd, SHUT_WR);
			} else if (got > 0) {
				if (spool.len + (size_t) got > SPOOL_MAX ||
				    !buf_append(&spool, chunk, (size_t) got)) {
					close(daemon_fd);
					return fallback_passthrough(&spool, acked, stdin_open);
				}
				if (!write_all(daemon_fd, chunk, (size_t) got)) {
					return fallback_passthrough(&spool, acked, stdin_open);
				}
				sent = spool.len;
			}
		}

		if (fds[daemon_slot].revents & (POLLIN | POLLHUP | POLLERR)) {
			unsigned char chunk[65536];
			ssize_t got = read(daemon_fd, chunk, sizeof(chunk));

			if (got < 0 && errno == EINTR) {
				continue;
			}
			if (got <= 0) {
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
			}
			if (!buf_append(&inbox, chunk, (size_t) got)) {
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
			}
			int state = drain_frames(&inbox, &acked);

			if (state == 1) {
				return 0;
			}
			if (state == -1) {
				close(daemon_fd);
				return fallback_passthrough(&spool, acked, stdin_open);
			}
		}
	}
}
