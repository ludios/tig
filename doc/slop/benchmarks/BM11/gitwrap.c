/* Model-output: Claude Opus 5.5 */
/* git shim for benchmarks: optionally preload an allocator, then exec the real git. */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int
main(int argc, char **argv)
{
	(void) argc;
#ifdef PRELOAD
	if (setenv("LD_PRELOAD", PRELOAD, 1)) {
		perror("setenv");
		return 127;
	}
#endif
	execv(REAL_GIT, argv);
	perror("execv " REAL_GIT);
	return 127;
}
