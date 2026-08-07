# Model-output: Claude Fable 5
CFLAGS ?= -Wall -Wextra -O2

../bin/tig-syntax-filter: tig-syntax-filter.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f ../bin/tig-syntax-filter

.PHONY: clean
