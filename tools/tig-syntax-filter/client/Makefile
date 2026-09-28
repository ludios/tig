# Model-output: Claude Fable 5
# Model-output: Claude Opus 5.5
CFLAGS ?= -Wall -Wextra -O2

# Everything that decides how the daemon behaves.  Its hash is part of the
# socket name, so a changed daemon gets a fresh socket instead of clients
# reusing a daemon still running the old code, which then idles out.
DAEMON_INPUTS = $(sort $(wildcard ../src/*.ts ../themes/*)) ../package.json \
	../pnpm-lock.yaml ../bin/tig-syntax-daemon
SHA256 = $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo 'shasum -a 256')
BUILD_ID = $(shell $(SHA256) $(DAEMON_INPUTS) | $(SHA256) | cut -c1-12)
BUILD_ID_STAMP = ../bin/.tig-syntax-filter.build-id

../bin/tig-syntax-filter: tig-syntax-filter.c $(BUILD_ID_STAMP)
	$(CC) $(CFLAGS) -DTIG_SYNTAX_BUILD_ID="\"$$(cat $(BUILD_ID_STAMP))\"" -o $@ $<

# Rewritten only when the id changes, so the client is rebuilt exactly
# then: input mtimes alone would miss a deleted input or a restored older
# file.
$(BUILD_ID_STAMP): FORCE
	@id='$(BUILD_ID)'; \
	if [ -z "$$id" ]; then \
		echo "cannot hash the daemon sources (need sha256sum or shasum)" >&2; \
		exit 1; \
	fi; \
	echo "$$id" | cmp -s - $@ || echo "$$id" > $@

clean:
	rm -f ../bin/tig-syntax-filter $(BUILD_ID_STAMP)

FORCE:

.PHONY: clean FORCE
