/* Model-output: Claude Opus 5.5 */

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
#include "tig/util.h"
#include "tig/graph.h"
#include "compat/hashtab.h"
#include <stdint.h>

struct graph_symbol {
	unsigned int color:8;

	unsigned int commit:1;
	unsigned int boundary:1;
	unsigned int initial:1;
	unsigned int merge:1;

	unsigned int continued_down:1;
	unsigned int continued_up:1;
	unsigned int continued_right:1;
	unsigned int continued_left:1;
	unsigned int continued_up_left:1;

	unsigned int parent_down:1;
	unsigned int parent_right:1;

	unsigned int below_commit:1;
	unsigned int flanked:1;
	unsigned int next_right:1;
	unsigned int matches_commit:1;

	unsigned int shift_left:1;
	unsigned int continue_shift:1;
	unsigned int below_shift:1;

	unsigned int new_column:1;
	unsigned int empty:1;
};

struct graph_column {
	struct graph_symbol symbol;
	const char *id;			/* Parent SHA1 ID. */
};

struct graph_row {
	size_t size;
	struct graph_column *columns;
};

struct colors {
	htab_t id_map;
	size_t count[GRAPH_COLORS];
};

/* Maps ids to columns of one row at a time.  Open addressing, sized for
 * the widest row so far and reused from row to row: a slot is in use only
 * while its generation is the index's. */
struct graph_id_slot {
	const char *id;
	unsigned int generation;
	int pos;
};

struct graph_id_index {
	struct graph_id_slot *slots;
	size_t size;			/* A power of two, at least twice the row. */
	unsigned int generation;
};

/* What graph_generate_symbols() needs to know about the columns of
 * prev_row, row and next_row, gathered in O(W) per row by graph_scan_rows()
 * so that no symbol has to rescan a row.  Arrays are indexed by column;
 * "same id" compares interned pointers, and an empty (NULL) column has the
 * same id as another empty one. */
struct graph_row_scan {
	struct graph_id_index ids;
	size_t capacity;		/* Columns the arrays have room for. */
	int *row_left;			/* Nearest column of row to the left with the same id, or -1. */
	int *row_right;			/* Nearest column of row to the right with the same id, or W. */
	int *prev_left;			/* Nearest column of prev_row to the left with the same id, or -1. */
	int *prev_last;			/* Last column of prev_row with the id of row's column, or -1. */
	int *next_right;		/* Nearest column of next_row to the right with the same id, or W. */
	bool *shift_left;		/* Each column's symbol.shift_left. */
	bool *parent_down;		/* Whether the column holds one of the parents in next_row. */
	int commit_first;		/* First column of row with the commit's id, or W. */
	int commit_last;		/* Last column of row with the commit's id, or -1. */
	int new_parent_last;		/* Last column that turns into a parent in next_row, or -1. */
};

struct graph_v2 {
	struct graph api;
	struct graph_row row;
	struct graph_row parents;
	struct graph_row prev_row;
	struct graph_row next_row;
	size_t position;
	size_t prev_position;
	size_t expanded;
	const char *id;
	struct colors colors;
	struct graph_row_scan scan;
	bool has_parents;
	bool is_boundary;
};

DEFINE_ALLOCATOR(realloc_graph_columns, struct graph_column, 32)
DEFINE_ALLOCATOR(realloc_graph_symbols, struct graph_symbol, 1)
DEFINE_ALLOCATOR(realloc_graph_positions, int, 32)
DEFINE_ALLOCATOR(realloc_graph_flags, bool, 32)

static htab_t intern_string_htab;

static int
intern_string_eq(const void *entry, const void *element)
{
	return strcmp((const char *) entry, (const char *) element) == 0;
}

static hashval_t
intern_string_hash(const void *node)
{
	return htab_hash_string((const char *) node);
}

static const char *intern_string(const char *str)
{
	void **result;

	if (!str)
		return NULL;

	if (!intern_string_htab)
		intern_string_htab = htab_create_alloc(500, intern_string_hash, intern_string_eq, free, calloc, free);

	result = htab_find_slot(intern_string_htab, str, INSERT);
	if (!*result)
		*result = strdup(str);

	return *result;
}

/* Ids are interned, so the map compares them by pointer.  All empty (NULL)
 * columns share one entry; unlike when the map compared strings, an id ""
 * (only from a malformed `parent` line) has an entry of its own. */
struct id_color {
	const char *id;
	size_t color;
};

static int
id_color_eq(const void *entry, const void *element)
{
	return ((const struct id_color *) entry)->id == ((const struct id_color *) element)->id;
}

static hashval_t
id_color_hash(const void *node)
{
	return htab_hash_pointer(((const struct id_color *) node)->id);
}

static void
colors_remove_id(struct colors *colors, const char *id)
{
	struct id_color key = { id };
	void **slot = htab_find_slot(colors->id_map, &key, NO_INSERT);

	if (slot != NULL && *slot != NULL) {
		colors->count[((struct id_color *) *slot)->color]--;
		htab_clear_slot(colors->id_map, slot);
	}
}

static size_t
colors_get_free_color(struct colors *colors)
{
	size_t free_color = 0;
	size_t lowest = (size_t) -1; // Max value of size_t
	int i;

	for (i = 0; i < ARRAY_SIZE(colors->count); i++) {
		if (colors->count[i] < lowest) {
			lowest = colors->count[i];
			free_color = i;
		}
	}
	return free_color;
}

static void
colors_init(struct colors *colors)
{
	if (colors->id_map == NULL) {
		size_t size = 500;

		colors->id_map = htab_create_alloc(size, id_color_hash, id_color_eq, free, calloc, free);
	}
}

/* The color of the lane with `id`, picking the least used color for an id
 * not seen before. */
static size_t
get_color(struct graph_v2 *graph, const char *id)
{
	struct id_color key = { id };
	struct id_color *node;
	void **slot;

	colors_init(&graph->colors);
	slot = htab_find_slot(graph->colors.id_map, &key, INSERT);
	if (!slot) {
		die("Failed to allocate color");
	}

	if (!*slot) {
		node = malloc(sizeof(*node));
		if (!node) {
			die("Failed to allocate color");
		}
		node->id = id;
		node->color = colors_get_free_color(&graph->colors);
		graph->colors.count[node->color]++;
		*slot = node;
	}

	return ((struct id_color *) *slot)->color;
}

static void
graph_row_scan_free(struct graph_row_scan *scan)
{
	free(scan->ids.slots);
	free(scan->row_left);
	free(scan->row_right);
	free(scan->prev_left);
	free(scan->prev_last);
	free(scan->next_right);
	free(scan->shift_left);
	free(scan->parent_down);
	memset(scan, 0, sizeof(*scan));
}

static void
graph_row_free(struct graph_row *row)
{
	free(row->columns);
	memset(row, 0, sizeof(*row));
}

/* Free the rows and scan state, leaving an empty graph behind.  Safe to
 * call more than once. */
static void
done_graph_rendering(struct graph *graph_ref)
{
	struct graph_v2 *graph = graph_ref->private;

	graph_row_free(&graph->prev_row);
	graph_row_free(&graph->row);
	graph_row_free(&graph->next_row);
	graph_row_free(&graph->parents);
	graph_row_scan_free(&graph->scan);
}

static void
done_graph(struct graph *graph_ref)
{
	struct graph_v2 *graph = graph_ref->private;

	if (graph->colors.id_map)
		htab_delete(graph->colors.id_map);

	done_graph_rendering(graph_ref);

	free(graph);

	if (intern_string_htab)
		htab_empty(intern_string_htab);
}

#define graph_column_has_commit(col) ((col)->id)

static size_t
graph_find_column_by_id(struct graph_row *row, const char *id)
{
	size_t free_column = row->size;
	size_t i;

	for (i = 0; i < row->size; i++) {
		if (!graph_column_has_commit(&row->columns[i]) && free_column == row->size)
			free_column = i;
		else if (row->columns[i].id == id)
			return i;
	}

	return free_column;
}

static size_t
graph_find_free_column(struct graph_row *row)
{
	size_t i;

	for (i = 0; i < row->size; i++) {
		if (!graph_column_has_commit(&row->columns[i]))
			return i;
	}

	return row->size;
}

static struct graph_column *
graph_insert_column(struct graph_v2 *graph, struct graph_row *row, size_t pos, const char *id)
{
	struct graph_column *column;

	if (!realloc_graph_columns(&row->columns, row->size, 1))
		return NULL;

	column = &row->columns[pos];
	if (pos < row->size) {
		memmove(column + 1, column, sizeof(*column) * (row->size - pos));
	}

	id = intern_string(id);

	row->size++;
	memset(column, 0, sizeof(*column));
	column->id = id;
	column->symbol.boundary = !!graph->is_boundary;

	return column;
}

static bool
graph_add_parent(struct graph *graph_ref, const char *parent)
{
	struct graph_v2 *graph = graph_ref->private;

	if (graph->has_parents)
		return true;
	return graph_insert_column(graph, &graph->parents, graph->parents.size, parent) != NULL;
}

static bool
graph_needs_expansion(struct graph_v2 *graph)
{
	return graph->position + graph->parents.size > graph->row.size;
}

static bool
graph_expand(struct graph_v2 *graph)
{
	while (graph_needs_expansion(graph)) {
		if (!graph_insert_column(graph, &graph->prev_row, graph->prev_row.size, NULL))
			return false;

		if (!graph_insert_column(graph, &graph->row, graph->row.size, NULL))
			return false;

		if (!graph_insert_column(graph, &graph->next_row, graph->next_row.size, NULL))
			return false;
	}

	return true;
}

static bool
graph_needs_collapsing(struct graph_v2 *graph)
{
	return graph->row.size > 1
	    && !graph_column_has_commit(&graph->row.columns[graph->row.size - 1]);
}

static bool
graph_collapse(struct graph_v2 *graph)
{
	while (graph_needs_collapsing(graph)) {
		graph->prev_row.size--;
		graph->row.size--;
		graph->next_row.size--;
	}

	return true;
}

static void
graph_row_clear_commit(struct graph_row *row, const char *id)
{
	int i;

	for (i = 0; i < row->size; i++) {
		if (row->columns[i].id == id) {
			row->columns[i].id = NULL;
		}
	}
}

static void
graph_insert_parents(struct graph_v2 *graph)
{
	struct graph_row *prev_row = &graph->prev_row;
	struct graph_row *row = &graph->row;
	struct graph_row *next_row = &graph->next_row;
	struct graph_row *parents = &graph->parents;
	int i;

	for (i = 0; i < parents->size; i++) {
		struct graph_column *new = &parents->columns[i];

		if (graph_column_has_commit(new)) {
			size_t match = graph_find_free_column(next_row);

			if (match == next_row->size && graph_column_has_commit(&next_row->columns[next_row->size - 1])) {
				graph_insert_column(graph, next_row, next_row->size, new->id);
				graph_insert_column(graph, row, row->size, NULL);
				graph_insert_column(graph, prev_row, prev_row->size, NULL);
			} else {
				next_row->columns[match] = *new;
			}
		}
	}
}

static bool
commit_is_in_row(const char *id, struct graph_row *row)
{
	int i;

	for (i = 0; i < row->size; i++) {
		if (!graph_column_has_commit(&row->columns[i]))
			continue;

		if (id == row->columns[i].id)
			return true;
	}
	return false;
}

static void
graph_remove_collapsed_columns(struct graph_v2 *graph)
{
	struct graph_row *row = &graph->next_row;
	int i;

	for (i = row->size - 1; i > 0; i--) {
		if (i == graph->position)
			continue;

		if (i == graph->position + 1)
			continue;

		if (row->columns[i].id == graph->id)
			continue;

		if (row->columns[i].id != row->columns[i - 1].id)
			continue;

		if (commit_is_in_row(row->columns[i].id, &graph->parents) && !graph_column_has_commit(&graph->prev_row.columns[i]))
			continue;

		if (row->columns[i - 1].id != graph->prev_row.columns[i - 1].id || graph->prev_row.columns[i - 1].symbol.shift_left) {
			if (i + 1 >= row->size)
				memset(&row->columns[i], 0, sizeof(row->columns[i]));
			else
				row->columns[i] = row->columns[i + 1];
		}
	}
}

static void
graph_fill_empty_columns(struct graph_v2 *graph)
{
	struct graph_row *row = &graph->next_row;
	int i;

	for (i = row->size - 2; i >= 0; i--) {
		if (!graph_column_has_commit(&row->columns[i])) {
			row->columns[i] = row->columns[i + 1];
		}
	}
}

static void
graph_generate_next_row(struct graph_v2 *graph)
{
	graph_row_clear_commit(&graph->next_row, graph->id);
	graph_insert_parents(graph);
	graph_remove_collapsed_columns(graph);
	graph_fill_empty_columns(graph);
}

static int
commits_in_row(struct graph_row *row)
{
	int count = 0;
	int i;

	for (i = 0; i < row->size;i++) {
		if (graph_column_has_commit(&row->columns[i]))
			count++;
	}

	return count;
}

static void
graph_commit_next_row(struct graph_v2 *graph)
{
	int i;

	for (i = 0; i < graph->row.size; i++) {
		graph->prev_row.columns[i] = graph->row.columns[i];

		if (i == graph->position && commits_in_row(&graph->parents) > 0)
			graph->prev_row.columns[i] = graph->next_row.columns[i];

		if (!graph_column_has_commit(&graph->prev_row.columns[i]))
			graph->prev_row.columns[i] = graph->next_row.columns[i];

		graph->row.columns[i] = graph->next_row.columns[i];
	}

	graph->prev_position = graph->position;
}

static bool
continued_down(struct graph_row *row, struct graph_row *next_row, int pos)
{
	if (row->columns[pos].id != next_row->columns[pos].id)
		return false;

	if (row->columns[pos].symbol.shift_left)
		return false;

	return true;
}

static bool
below_commit(int pos, struct graph_v2 *graph)
{
	if (pos != graph->prev_position)
		return false;

	if (graph->row.columns[pos].id != graph->prev_row.columns[pos].id)
		return false;

	return true;
}

/* Multiplicative hashing.  The index uses the result's low bits, i.e. bits
 * 32 and up of the product, which mix all of the pointer's low 32 bits. */
static size_t
graph_id_hash(const char *id)
{
	return (size_t) (((uint64_t) (uintptr_t) id * UINT64_C(0x9E3779B97F4A7C15)) >> 32);
}

/* Make room for a row of `columns` columns and forget the previous row's
 * ids. */
static void
graph_id_index_reset(struct graph_id_index *index, size_t columns)
{
	if (!index->slots || index->size < 2 * columns) {
		size_t size = 16;

		while (size < 2 * columns) {
			size *= 2;
		}
		free(index->slots);
		index->slots = calloc(size, sizeof(*index->slots));
		if (!index->slots) {
			die("Failed to allocate graph index");
		}
		index->size = size;
		index->generation = 0;
	}

	if (++index->generation == 0) {
		memset(index->slots, 0, index->size * sizeof(*index->slots));
		index->generation = 1;
	}
}

/* The slot holding `id` since the last reset, or else the free slot where
 * it would go (whose generation isn't the index's). */
static struct graph_id_slot *
graph_id_index_slot(struct graph_id_index *index, const char *id)
{
	size_t mask = index->size - 1;
	size_t i = graph_id_hash(id) & mask;

	while (index->slots[i].generation == index->generation && index->slots[i].id != id) {
		i = (i + 1) & mask;
	}

	return &index->slots[i];
}

/* Set nearest[pos], for each column pos of `row`, to the nearest column
 * with the same id on the left (from_left) or else on the right; or to -1
 * or W when there is none.  Afterwards, the index maps each id to its last
 * column in scan order. */
static void
graph_id_index_scan(struct graph_id_index *index, struct graph_row *row, bool from_left, int *nearest)
{
	int size = row->size;
	int none = from_left ? -1 : size;
	int step = from_left ? 1 : -1;
	int pos;

	graph_id_index_reset(index, size);
	for (pos = from_left ? 0 : size - 1; 0 <= pos && pos < size; pos += step) {
		struct graph_id_slot *slot = graph_id_index_slot(index, row->columns[pos].id);

		nearest[pos] = slot->generation == index->generation ? slot->pos : none;
		slot->id = row->columns[pos].id;
		slot->generation = index->generation;
		slot->pos = pos;
	}
}

/* Make room in the arrays of `scan` for rows of `columns` columns.  They
 * only ever grow. */
static void
graph_row_scan_reserve(struct graph_row_scan *scan, size_t columns)
{
	size_t more;

	if (columns <= scan->capacity) {
		return;
	}

	more = columns - scan->capacity;
	realloc_graph_positions(&scan->row_left, scan->capacity, more);
	realloc_graph_positions(&scan->row_right, scan->capacity, more);
	realloc_graph_positions(&scan->prev_left, scan->capacity, more);
	realloc_graph_positions(&scan->prev_last, scan->capacity, more);
	realloc_graph_positions(&scan->next_right, scan->capacity, more);
	realloc_graph_flags(&scan->shift_left, scan->capacity, more);
	realloc_graph_flags(&scan->parent_down, scan->capacity, more);
	scan->capacity = columns;
}

/* Fill graph->scan for the current rows. */
static void
graph_scan_rows(struct graph_v2 *graph)
{
	struct graph_row_scan *scan = &graph->scan;
	struct graph_row *prev_row = &graph->prev_row;
	struct graph_row *row = &graph->row;
	struct graph_row *next_row = &graph->next_row;
	int size = row->size;
	int pos;

	graph_row_scan_reserve(scan, size);

	/* After the scan of prev_row from the left, the index holds each of
	 * its ids at its last column. */
	graph_id_index_scan(&scan->ids, prev_row, true, scan->prev_left);
	for (pos = 0; pos < size; pos++) {
		struct graph_id_slot *slot = graph_id_index_slot(&scan->ids, row->columns[pos].id);

		scan->prev_last[pos] = slot->generation == scan->ids.generation ? slot->pos : -1;
	}

	graph_id_index_scan(&scan->ids, row, true, scan->row_left);
	graph_id_index_scan(&scan->ids, next_row, false, scan->next_right);

	/* row_left links each column to the previous one with its id; each
	 * link read backwards gives the next one. */
	for (pos = 0; pos < size; pos++) {
		scan->row_right[pos] = size;
	}
	for (pos = 0; pos < size; pos++) {
		if (scan->row_left[pos] >= 0) {
			scan->row_right[scan->row_left[pos]] = pos;
		}
	}

	/* A column shifts left when the nearest column on its left with its id
	 * didn't continue down from prev_row. */
	for (pos = 0; pos < size; pos++) {
		int left = scan->row_left[pos];

		scan->shift_left[pos] = graph_column_has_commit(&row->columns[pos])
				     && left >= 0 && !continued_down(prev_row, row, left);
	}

	scan->commit_first = size;
	scan->commit_last = -1;
	for (pos = 0; pos < size; pos++) {
		if (row->columns[pos].id == graph->id) {
			if (scan->commit_first == size) {
				scan->commit_first = pos;
			}
			scan->commit_last = pos;
		}
	}

	scan->new_parent_last = -1;
	for (pos = 0; pos < size; pos++) {
		scan->parent_down[pos] = commit_is_in_row(next_row->columns[pos].id, &graph->parents);
		if (scan->parent_down[pos] && next_row->columns[pos].id != row->columns[pos].id) {
			scan->new_parent_last = pos;
		}
	}
}

static void
graph_generate_symbols(struct graph_v2 *graph, struct graph_canvas *canvas)
{
	struct graph_row *prev_row = &graph->prev_row;
	struct graph_row *row = &graph->row;
	struct graph_row *next_row = &graph->next_row;
	struct graph_row *parents = &graph->parents;
	struct graph_row_scan *scan = &graph->scan;
	int commits = commits_in_row(parents);
	int initial = commits < 1;
	int merge = commits > 1;
	int size = row->size;
	int commit_pos = graph->position;
	int pos;

	assert(prev_row->size == row->size);
	assert(next_row->size == row->size);
	assert(0 <= commit_pos && commit_pos < size);

	graph_scan_rows(graph);
	realloc_graph_symbols(&canvas->symbols, canvas->size, size);

	for (pos = 0; pos < size; pos++) {
		struct graph_column *column = &row->columns[pos];
		struct graph_symbol *symbol = &column->symbol;
		const char *id = next_row->columns[pos].id;

		symbol->commit            = (pos == commit_pos);
		symbol->boundary          = (pos == commit_pos && next_row->columns[pos].symbol.boundary);
		symbol->initial           = initial;
		symbol->merge             = merge;

		/* Reads the column's shift_left before it's set below, i.e.
		 * the 0 that the column carried in from next_row. */
		symbol->continued_down    = continued_down(row, next_row, pos);
		symbol->continued_up      = continued_down(prev_row, row, pos);
		symbol->continued_right   = scan->row_right[pos] < (pos < commit_pos ? commit_pos : size);
		symbol->continued_left    = graph_column_has_commit(column)
					    && scan->row_left[pos] >= (pos < commit_pos ? 0 : commit_pos);
		symbol->continued_up_left = graph_column_has_commit(&prev_row->columns[pos])
					    && scan->prev_left[pos] >= 0;

		symbol->parent_down       = scan->parent_down[pos];
		symbol->parent_right      = (pos > commit_pos && pos < scan->new_parent_last);

		symbol->below_commit      = below_commit(pos, graph);
		symbol->flanked           = (pos < commit_pos ? scan->commit_first < pos : scan->commit_last > pos);
		symbol->next_right        = scan->next_right[pos] < size;
		symbol->matches_commit    = column->id == graph->id;

		symbol->shift_left        = scan->shift_left[pos];
		symbol->continue_shift    = (pos + 1 < size && scan->shift_left[pos + 1]);
		symbol->below_shift       = prev_row->columns[pos].symbol.shift_left;

		symbol->new_column        = !graph_column_has_commit(&prev_row->columns[pos])
					    || scan->prev_last[pos] < pos;
		symbol->empty             = (!graph_column_has_commit(&row->columns[pos]));

		if (graph_column_has_commit(column)) {
			id = column->id;
		}
		symbol->color = get_color(graph, id);

		canvas->symbols[canvas->size++] = *symbol;
	}

	colors_remove_id(&graph->colors, graph->id);
}

static bool
graph_render_parents(struct graph *graph_ref, struct graph_canvas *canvas)
{
	struct graph_v2 *graph = graph_ref->private;

	if (graph->parents.size == 0 &&
	    !graph_add_parent(graph_ref, NULL))
		return false;

	if (!graph_expand(graph))
		return false;

	graph_generate_next_row(graph);
	graph_generate_symbols(graph, canvas);
	graph_commit_next_row(graph);

	graph->parents.size = graph->position = 0;

	if (!graph_collapse(graph))
		return false;

	return true;
}

static bool
graph_is_merge(struct graph_canvas *canvas)
{
	return !!canvas->symbols->merge;
}

static bool
graph_add_commit(struct graph *graph_ref, struct graph_canvas *canvas,
		 const char *id, const char *parents, bool is_boundary)
{
	struct graph_v2 *graph = graph_ref->private;
	int has_parents = 0;

	id = intern_string(id);

	graph->position = graph_find_column_by_id(&graph->row, id);
	graph->id = id;
	graph->is_boundary = is_boundary;
	graph->has_parents = false;

	while ((parents = strchr(parents, ' '))) {
		char parent[SIZEOF_REV] = {0};
		parents++;
		string_copy_rev(parent, parents);
		if (!graph_add_parent(graph_ref, *parent ? parent : NULL))
			return false;
		has_parents++;
	}

	graph->has_parents = has_parents > 0;

	return true;
}

static bool
graph_symbol_forks(const struct graph_symbol *symbol)
{
	if (!symbol->continued_down)
		return false;

	if (!symbol->continued_right)
		return false;

	if (!symbol->continued_up)
		return false;

	return true;
}

static bool
graph_symbol_cross_merge(const struct graph_symbol *symbol)
{
	if (symbol->empty)
		return false;

	if (!symbol->continued_up && !symbol->new_column && !symbol->below_commit)
		return false;

	if (symbol->shift_left && symbol->continued_up_left)
		return false;

	if (symbol->next_right)
		return false;

	if (symbol->merge && symbol->continued_up && symbol->continued_right && symbol->continued_left && symbol->parent_down && !symbol->next_right)
		return true;

	return false;
}

static bool
graph_symbol_vertical_merge(const struct graph_symbol *symbol)
{
	if (symbol->empty)
		return false;

	if (!symbol->continued_up && !symbol->new_column && !symbol->below_commit)
		return false;

	if (symbol->shift_left && symbol->continued_up_left)
		return false;

	if (symbol->next_right)
		return false;

	if (!symbol->matches_commit)
		return false;

	if (symbol->merge && symbol->continued_up && symbol->continued_left && symbol->parent_down && !symbol->continued_right)
		return true;

	return false;
}

static bool
graph_symbol_cross_over(const struct graph_symbol *symbol)
{
	if (symbol->empty)
		return false;

	if (!symbol->continued_down)
		return false;

	if (!symbol->continued_up && !symbol->new_column && !symbol->below_commit)
		return false;

	if (symbol->shift_left)
		return false;

	if (symbol->parent_right && symbol->merge)
		return true;

	if (symbol->flanked)
		return true;

	return false;
}

static bool
graph_symbol_turn_left(const struct graph_symbol *symbol)
{
	if (symbol->matches_commit && symbol->continued_right && !symbol->continued_down)
		return false;

	if (symbol->continue_shift)
		return false;

	if (symbol->continued_up || symbol->new_column || symbol->below_commit) {
		if (symbol->matches_commit)
			return true;

		if (symbol->shift_left)
			return true;
	}

	return false;
}

static bool
graph_symbol_turn_down_cross_over(const struct graph_symbol *symbol)
{
	if (!symbol->continued_down)
		return false;

	if (!symbol->continued_right)
		return false;

	if (!symbol->parent_right && !symbol->flanked)
		return false;

	if (symbol->flanked)
		return true;

	if (symbol->merge)
		return true;

	return false;
}

static bool
graph_symbol_turn_down(const struct graph_symbol *symbol)
{
	if (!symbol->continued_down)
		return false;

	if (!symbol->continued_right)
		return false;

	return true;
}

static bool
graph_symbol_merge(const struct graph_symbol *symbol)
{
	if (symbol->continued_down)
		return false;

	if (!symbol->parent_down)
		return false;

	if (symbol->parent_right)
		return false;

	if (symbol->continued_right)
		return false;

	return true;
}

static bool
graph_symbol_multi_merge(const struct graph_symbol *symbol)
{
	if (!symbol->parent_down)
		return false;

	if (!symbol->parent_right && !symbol->continued_right)
		return false;

	return true;
}

static bool
graph_symbol_vertical_bar(const struct graph_symbol *symbol)
{
	if (symbol->empty)
		return false;

	if (symbol->shift_left)
		return false;

	if (!symbol->continued_down)
		return false;

	if (symbol->continued_up)
		return true;

	if (symbol->parent_right)
		return false;

	if (symbol->flanked)
		return false;

	if (symbol->continued_right)
		return false;

	return true;
}

static bool
graph_symbol_horizontal_bar(const struct graph_symbol *symbol)
{
	if (!symbol->next_right)
		return false;

	if (symbol->shift_left)
		return true;

	if (symbol->continued_down)
		return false;

	if (!symbol->parent_right && !symbol->continued_right)
		return false;

	if ((symbol->continued_up && !symbol->continued_up_left))
		return false;

	if (!symbol->below_commit)
		return true;

	return false;
}

static bool
graph_symbol_multi_branch(const struct graph_symbol *symbol)
{
	if (symbol->continued_down)
		return false;

	if (!symbol->continued_right)
		return false;

	if (symbol->below_shift)
		return false;

	if (symbol->continued_up || symbol->new_column || symbol->below_commit) {
		if (symbol->matches_commit)
			return true;

		if (symbol->shift_left)
			return true;
	}

	return false;
}

static const char *
graph_symbol_to_utf8(const struct graph_symbol *symbol)
{
	if (symbol->commit) {
		if (symbol->boundary)
			return " ◯";
		else if (symbol->initial)
			return " ◎";
		else if (symbol->merge)
			return " ●";
		return " ∙";
	}

	if (graph_symbol_cross_merge(symbol))
		return "─┼";

	if (graph_symbol_vertical_merge(symbol))
		return "─┤";

	if (graph_symbol_cross_over(symbol))
		return "─│";

	if (graph_symbol_vertical_bar(symbol))
		return " │";

	if (graph_symbol_turn_left(symbol))
		return "─╯";

	if (graph_symbol_multi_branch(symbol))
		return "─┴";

	if (graph_symbol_horizontal_bar(symbol))
		return "──";

	if (graph_symbol_forks(symbol))
		return " ├";

	if (graph_symbol_turn_down_cross_over(symbol))
		return "─╭";

	if (graph_symbol_turn_down(symbol))
		return " ╭";

	if (graph_symbol_merge(symbol))
		return "─╮";

	if (graph_symbol_multi_merge(symbol))
		return "─┬";

	return "  ";
}

static const chtype *
graph_symbol_to_chtype(const struct graph_symbol *symbol)
{
	static chtype graphics[2];

	if (symbol->commit) {
		graphics[0] = ' ';
		if (symbol->boundary)
			graphics[1] = 'o';
		else if (symbol->initial)
			graphics[1] = 'I';
		else if (symbol->merge)
			graphics[1] = 'M';
		else
			graphics[1] = 'o'; //ACS_DIAMOND; //'*';
		return graphics;

	} else if (graph_symbol_cross_merge(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_PLUS;

	} else if (graph_symbol_vertical_merge(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_RTEE;

	} else if (graph_symbol_cross_over(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_VLINE;

	} else if (graph_symbol_vertical_bar(symbol)) {
		graphics[0] = ' ';
		graphics[1] = ACS_VLINE;

	} else if (graph_symbol_turn_left(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_LRCORNER;

	} else if (graph_symbol_multi_branch(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_BTEE;

	} else if (graph_symbol_horizontal_bar(symbol)) {
		graphics[0] = graphics[1] = ACS_HLINE;

	} else if (graph_symbol_forks(symbol)) {
		graphics[0] = ' ';
		graphics[1] = ACS_LTEE;

	} else if (graph_symbol_turn_down_cross_over(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_ULCORNER;

	} else if (graph_symbol_turn_down(symbol)) {
		graphics[0] = ' ';
		graphics[1] = ACS_ULCORNER;

	} else if (graph_symbol_merge(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_URCORNER;

	} else if (graph_symbol_multi_merge(symbol)) {
		graphics[0] = ACS_HLINE;
		graphics[1] = ACS_TTEE;

	} else {
		graphics[0] = graphics[1] = ' ';
	}

	return graphics;
}

static const char *
graph_symbol_to_ascii(const struct graph_symbol *symbol)
{
	if (symbol->commit) {
		if (symbol->boundary)
			return " o";
		else if (symbol->initial)
			return " I";
		else if (symbol->merge)
			return " M";
		return " *";
	}

	if (graph_symbol_cross_merge(symbol))
		return "-+";

	if (graph_symbol_vertical_merge(symbol))
		return "-|";

	if (graph_symbol_cross_over(symbol))
		return "-|";

	if (graph_symbol_vertical_bar(symbol))
		return " |";

	if (graph_symbol_turn_left(symbol))
		return "-'";

	if (graph_symbol_multi_branch(symbol))
		return "-+";

	if (graph_symbol_horizontal_bar(symbol))
		return "--";

	if (graph_symbol_forks(symbol))
		return " +";

	if (graph_symbol_turn_down_cross_over(symbol))
		return "-.";

	if (graph_symbol_turn_down(symbol))
		return " .";

	if (graph_symbol_merge(symbol))
		return "-.";

	if (graph_symbol_multi_merge(symbol))
		return "-+";

	return "  ";
}

static void
graph_foreach_symbol(const struct graph *graph, const struct graph_canvas *canvas,
		     graph_symbol_iterator_fn fn, void *data)
{
	int i;

	for (i = 0; i < canvas->size; i++) {
		struct graph_symbol *symbol = &canvas->symbols[i];
		int color_id = symbol->commit ? GRAPH_COMMIT_COLOR : symbol->color;

		if (fn(data, graph, symbol, color_id, i == 0))
			break;
	}
}

struct graph *
init_graph_v2(void)
{
	struct graph_v2 *graph = calloc(1, sizeof(*graph));
	struct graph *api = NULL;

	if (graph) {
		api = &graph->api;

		api->private = graph;
		api->done = done_graph;
		api->done_rendering = done_graph_rendering;
		api->add_commit = graph_add_commit;
		api->add_parent = graph_add_parent;
		api->render_parents = graph_render_parents;
		api->is_merge = graph_is_merge;
		api->foreach_symbol = graph_foreach_symbol;
		api->symbol_to_ascii = graph_symbol_to_ascii;
		api->symbol_to_utf8 = graph_symbol_to_utf8;
		api->symbol_to_chtype = graph_symbol_to_chtype;
	}

	return api;
}

/* vim: set ts=8 sw=8 noexpandtab: */
