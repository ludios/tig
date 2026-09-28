# Model-output: Claude Fable 5
# Model-output: Claude Opus 5.5
CFLAGS ?= -Wall -Wextra -O2

# Everything that decides how the daemon behaves.  Its hash is part of the
# socket name, so a changed daemon gets a fresh socket instead of clients
# reusing a daemon still running the old code, which then idles out.
DAEMON_INPUTS := $(sort $(wildcard ../src/*.ts ../themes/*)) ../package.json ../pnpm-lock.yaml
BUILD_ID := $(shell sha256sum $(DAEMON_INPUTS) | sha256sum | cut -c1-12)

ifeq ($(BUILD_ID),)
$(error cannot hash the daemon sources for the build id (is sha256sum installed?))
endif

../bin/tig-syntax-filter: tig-syntax-filter.c $(DAEMON_INPUTS)
	$(CC) $(CFLAGS) -DTIG_SYNTAX_BUILD_ID='"$(BUILD_ID)"' -o $@ $<

clean:
	rm -f ../bin/tig-syntax-filter

.PHONY: clean
