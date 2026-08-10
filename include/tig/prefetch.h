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

#ifndef TIG_PREFETCH_H
#define TIG_PREFETCH_H

#include "tig/tig.h"

/*
 * Diff prefetch: when `diff-prefetch` is enabled and a diff-syntax-filter
 * is configured, the commits after the main-view selection are pushed
 * through `git show | <filter> > /dev/null` in the background once the
 * selection has been idle briefly, so the filter daemon's caches are warm
 * before the user navigates onto them.
 */

/* Record up to `ids_len` candidate commit IDs adjacent to the selection.
 * Replaces earlier candidates; running prefetches for commits no longer
 * wanted are killed.  Launching happens later, from prefetch_idle(). */
void prefetch_request(const char *ids[], size_t ids_len);

/* Clamp an input-poll timeout (ms; < 0 = block forever) so that a pending
 * prefetch's debounce period can expire and be noticed. */
int prefetch_adjust_delay(int delay);

/* Launch pending prefetches whose debounce has expired and reap finished
 * prefetch children.  Call when input polling times out while no view is
 * loading. */
void prefetch_idle(void);

/* Start the diff-syntax-filter daemon in the background at tig startup so
 * the first diff view skips its cold start; a no-op when no filter is
 * configured. */
void prefetch_warmup_filter(void);

#endif
/* vim: set ts=8 sw=8 noexpandtab: */
