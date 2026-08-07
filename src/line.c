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

/* Model-output: Claude Fable 5 */

#include "tig/tig.h"
#include "tig/types.h"
#include "tig/refdb.h"
#include "tig/line.h"
#include "tig/util.h"
#include "tig/options.h"

static struct line_rule *line_rule;
static size_t line_rules;

static struct line_info **color_pair;
static size_t color_pairs;

DEFINE_ALLOCATOR(realloc_line_rule, struct line_rule, 8)
DEFINE_ALLOCATOR(realloc_color_pair, struct line_info *, 8)

enum line_type
get_line_type(const char *line)
{
	int linelen = strlen(line);
	enum line_type type;

	for (type = 0; type < line_rules; type++) {
		struct line_rule *rule = &line_rule[type];

		if (rule->regex && !regexec(rule->regex, line, 0, NULL, 0))
			return type;

		/* Case insensitive search matches Signed-off-by lines better. */
		if (rule->linelen && linelen >= rule->linelen &&
		    !strncasecmp(rule->line, line, rule->linelen))
			return type;
	}

	return LINE_DEFAULT;
}

enum line_type
get_line_type_from_ref(const struct ref *ref)
{
	if (ref->type == REFERENCE_HEAD)
		return LINE_MAIN_HEAD;
	else if (ref->type == REFERENCE_LOCAL_TAG)
		return LINE_MAIN_LOCAL_TAG;
	else if (ref->type == REFERENCE_TAG)
		return LINE_MAIN_TAG;
	else if (ref->type == REFERENCE_TRACKED_REMOTE)
		return LINE_MAIN_TRACKED;
	else if (ref->type == REFERENCE_REMOTE)
		return LINE_MAIN_REMOTE;
	else if (ref->type == REFERENCE_STASH)
		return LINE_MAIN_STASH;
	else if (ref->type == REFERENCE_NOTE)
		return LINE_MAIN_NOTE;
	else if (ref->type == REFERENCE_PREFETCH)
		return LINE_MAIN_PREFETCH;
	else if (ref->type == REFERENCE_OTHER)
		return LINE_MAIN_OTHER;
	else if (ref->type == REFERENCE_REPLACE)
		return LINE_MAIN_REPLACE;

	return LINE_MAIN_REF;
}

const char *
get_line_type_name(enum line_type type)
{
	assert(0 <= type && type < line_rules);
	return line_rule[type].name;
}

struct line_info *
get_line_info(const char *prefix, enum line_type type)
{
	struct line_info *info;
	struct line_rule *rule;

	assert(0 <= type && type < line_rules);
	rule = &line_rule[type];
	for (info = &rule->info; info; info = info->next) {
		if (prefix && info->prefix == prefix)
			return info;
		if (!prefix && !info->prefix)
			return info;
	}

	return &rule->info;
}

static struct line_info *
init_line_info(const char *prefix, const char *name, size_t namelen, const char *line, size_t linelen, regex_t *regex)
{
	struct line_rule *rule;

	if (!realloc_line_rule(&line_rule, line_rules, 1))
		die("Failed to allocate line info");

	rule = &line_rule[line_rules++];
	rule->name = name;
	rule->namelen = namelen;
	rule->line = line;
	rule->linelen = linelen;
	rule->regex = regex;

	rule->info.prefix = prefix;
	rule->info.fg = COLOR_DEFAULT;
	rule->info.bg = COLOR_DEFAULT;

	return &rule->info;
}

#define INIT_BUILTIN_LINE_INFO(type, line) \
	init_line_info(NULL, #type, STRING_SIZE(#type), (line), STRING_SIZE(line), NULL)

static struct line_rule *
find_line_rule(struct line_rule *query)
{
	enum line_type type;

	if (!line_rules) {
		LINE_INFO(INIT_BUILTIN_LINE_INFO);
	}

	for (type = 0; type < line_rules; type++) {
		struct line_rule *rule = &line_rule[type];

		if (query->namelen && enum_equals(*rule, query->name, query->namelen))
			return rule;

		if (query->linelen && query->linelen == rule->linelen &&
		    !strncasecmp(rule->line, query->line, rule->linelen))
			return rule;
	}

	return NULL;
}

struct line_info *
add_line_rule(const char *prefix, struct line_rule *query)
{
	struct line_rule *rule = find_line_rule(query);
	struct line_info *info, *last;

	if (!rule) {
		if (query->name)
			return NULL;

		return init_line_info(prefix, "", 0, query->line, query->linelen, query->regex);
	}

	/* When a rule already exists and we are just adding view-specific
	 * colors, query->line and query->regex can be freed. */
	free((void *) query->line);
	if (query->regex) {
		regfree(query->regex);
		free(query->regex);
	}

	for (info = &rule->info; info; last = info, info = info->next)
		if (info->prefix == prefix)
			return info;

	info = calloc(1, sizeof(*info));
	if (info)
		info->prefix = prefix;
	last->next = info;
	return info;
}

bool
foreach_line_rule(line_rule_visitor_fn visitor, void *data)
{
	enum line_type type;

	for (type = 0; type < line_rules; type++) {
		struct line_rule *rule = &line_rule[type];

		if (!visitor(data, rule))
			return false;
	}

	return true;
}

/* How rgb:RRGGBB colors are realized on the terminal; chosen by
 * init_colors() from the truecolor option and terminal capabilities. */
enum color_tier {
	COLOR_TIER_INDEXED,	/* quantize to the nearest xterm-256 entry */
	COLOR_TIER_PALETTE,	/* reprogram unused palette slots to exact RGB */
	COLOR_TIER_DIRECT,	/* pass packed 24-bit values (terminfo RGB) */
};

static enum color_tier color_tier = COLOR_TIER_INDEXED;

/*
 * Map a 24-bit RGB value to the nearest xterm-256 palette index, considering
 * both the 6x6x6 color cube (16..231) and the grayscale ramp (232..255).
 * Returns a palette index in the range 16..255.
 */
static int
rgb_to_256(int rgb)
{
	static const int levels[6] = { 0, 95, 135, 175, 215, 255 };
	int r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
	int ri, gi, bi, gray_index, gray_value, i;
	long cube_dist, gray_dist;

	for (i = 5; i > 0 && r < (levels[i - 1] + levels[i] + 1) / 2; i--)
		;
	ri = i;
	for (i = 5; i > 0 && g < (levels[i - 1] + levels[i] + 1) / 2; i--)
		;
	gi = i;
	for (i = 5; i > 0 && b < (levels[i - 1] + levels[i] + 1) / 2; i--)
		;
	bi = i;
	cube_dist = (long) (r - levels[ri]) * (r - levels[ri])
		  + (long) (g - levels[gi]) * (g - levels[gi])
		  + (long) (b - levels[bi]) * (b - levels[bi]);

	/* Ramp entries hold 8 + 10i, so round to the nearest multiple of 10. */
	gray_index = ((r + g + b) / 3 - 3) / 10;
	gray_index = gray_index < 0 ? 0 : gray_index > 23 ? 23 : gray_index;
	gray_value = 8 + gray_index * 10;
	gray_dist = (long) (r - gray_value) * (r - gray_value)
		  + (long) (g - gray_value) * (g - gray_value)
		  + (long) (b - gray_value) * (b - gray_value);

	if (gray_dist < cube_dist)
		return 232 + gray_index;
	return 16 + 36 * ri + 6 * gi + bi;
}

/* Palette-reprogramming state: which RGB value each slot was programmed to
 * (-1 = free), and which slots the user's indexed colors already occupy. */
#define PALETTE_SLOT_MIN 16
static int palette_slot_rgb[256];
static bool palette_slot_reserved[256];

static bool
palette_mark_reserved(void *data, const struct line_rule *rule)
{
	const struct line_info *info;

	for (info = &rule->info; info; info = info->next) {
		if (!COLOR_IS_RGB(info->fg) && info->fg >= 0 && info->fg <= 255)
			palette_slot_reserved[info->fg] = true;
		if (!COLOR_IS_RGB(info->bg) && info->bg >= 0 && info->bg <= 255)
			palette_slot_reserved[info->bg] = true;
	}
	return true;
}

static void
palette_program_slot(int slot, int rgb)
{
	int r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;

	/* Ceiling the 0..1000 scale keeps the value exact after the terminal
	 * converts back with a truncating v * 255 / 1000 (xterm's initc). */
	init_color(slot, (r * 1000 + 254) / 255, (g * 1000 + 254) / 255,
		   (b * 1000 + 254) / 255);
}

/*
 * Recompute which palette slots may be reprogrammed and re-issue init_color()
 * for mappings that survive, since start_color() resets the color table.
 * Mappings landing on a now-reserved slot are dropped and will reallocate.
 */
static void
palette_reset(void)
{
	static bool initialized;
	int slot;

	if (!initialized) {
		for (slot = 0; slot < 256; slot++)
			palette_slot_rgb[slot] = -1;
		initialized = true;
	}

	memset(palette_slot_reserved, 0, sizeof(palette_slot_reserved));
	foreach_line_rule(palette_mark_reserved, NULL);

	for (slot = PALETTE_SLOT_MIN; slot < 256 && slot < COLORS; slot++) {
		if (palette_slot_rgb[slot] == -1)
			continue;
		if (palette_slot_reserved[slot]) {
			palette_slot_rgb[slot] = -1;
		} else {
			palette_program_slot(slot, palette_slot_rgb[slot]);
		}
	}
}

/*
 * Program `rgb` into a free palette slot, reusing an existing mapping when
 * one exists.  Slots are taken from the top of the palette down to keep away
 * from commonly used low indices.  Returns the slot, or a quantized xterm-256
 * index when no free slot remains.
 */
static int
palette_alloc(int rgb)
{
	int limit = COLORS < 256 ? COLORS : 256;
	int slot;

	for (slot = limit - 1; slot >= PALETTE_SLOT_MIN; slot--)
		if (palette_slot_rgb[slot] == rgb)
			return slot;

	for (slot = limit - 1; slot >= PALETTE_SLOT_MIN; slot--) {
		if (palette_slot_rgb[slot] == -1 && !palette_slot_reserved[slot]) {
			palette_slot_rgb[slot] = rgb;
			palette_program_slot(slot, rgb);
			return slot;
		}
	}

	return rgb_to_256(rgb);
}

/* The RGB value a given xterm-256 palette index stands for. */
static int
xterm256_to_rgb(int index)
{
	static const int levels[6] = { 0, 95, 135, 175, 215, 255 };

	if (index >= 232) {
		int v = 8 + 10 * (index - 232);

		return (v << 16) | (v << 8) | v;
	}
	index -= 16;
	return (levels[index / 36] << 16)
	     | (levels[(index / 6) % 6] << 8)
	     |  levels[index % 6];
}

/*
 * Translate a configured color to the value passed to curses pair
 * initialization: indexed colors pass through, RGB colors are realized
 * according to the active color tier.  On a direct-color terminal the
 * quantized tier still has to emit RGB values, since such terminals
 * interpret color numbers >= 8 as packed RGB, not palette indices.
 */
static int
resolve_color(int color)
{
	if (!COLOR_IS_RGB(color))
		return color;

	switch (color_tier) {
	case COLOR_TIER_DIRECT:
		return COLOR_RGB_VALUE(color);
	case COLOR_TIER_PALETTE:
		return palette_alloc(COLOR_RGB_VALUE(color));
	default:
#ifdef TIG_EXT_PAIR
		if (COLORS >= (1 << 24))
			return xterm256_to_rgb(rgb_to_256(COLOR_RGB_VALUE(color)));
#endif
		return rgb_to_256(COLOR_RGB_VALUE(color));
	}
}

/*
 * Initialize a curses color pair from possibly-RGB color values.  Extended
 * pairs are required for direct-color values, which do not fit in the short
 * range accepted by init_pair(); the pair ID itself stays small, so pairs
 * remain addressable through COLOR_PAIR() in the draw layer.
 */
void
tig_init_pair(int id, int fg, int bg)
{
	int resolved_fg = resolve_color(fg);
	int resolved_bg = resolve_color(bg);

#ifdef TIG_EXT_PAIR
	if (resolved_fg > SHRT_MAX || resolved_bg > SHRT_MAX) {
		init_extended_pair(id, resolved_fg, resolved_bg);
		return;
	}
#endif
	init_pair(id, resolved_fg, resolved_bg);
}

static void
init_line_info_color_pair(struct line_info *info, enum line_type type,
	int default_bg, int default_fg)
{
	int bg = info->bg == COLOR_DEFAULT ? default_bg : info->bg;
	int fg = info->fg == COLOR_DEFAULT ? default_fg : info->fg;
	int i;

	for (i = 0; i < color_pairs; i++) {
		if (color_pair[i]->fg == info->fg && color_pair[i]->bg == info->bg) {
			info->color_pair = i;
			/* Re-issue the pair: the color tier may have changed
			 * since it was first initialized (:set truecolor). */
			tig_init_pair(COLOR_ID(i), fg, bg);
			return;
		}
	}

	if (!realloc_color_pair(&color_pair, color_pairs, 1))
		die("Failed to allocate color pair");

	color_pair[color_pairs] = info;
	info->color_pair = color_pairs++;
	tig_init_pair(COLOR_ID(info->color_pair), fg, bg);
}

/*
 * Ephemeral syntax styles.  Pair IDs are allocated from SYNTAX_PAIR_BASE
 * upward, far above the line-rule pair range, so both allocators can grow
 * independently; the style count is capped both by SYNTAX_STYLE_MAX and by
 * the terminal's pair budget.  Styles are never freed: views keep style IDs
 * in their box cells, and the table is bounded.
 */

#define SYNTAX_PAIR_BASE	1024
#define SYNTAX_STYLE_MAX	1024

struct syntax_style {
	int fg;			/* Color as in struct line_info (index or RGB). */
	int attr;		/* Curses attributes decoded from SGR. */
	enum line_type base;	/* Line type supplying the background. */
	int color_pair;		/* Allocated curses pair ID. */
};

static struct syntax_style *syntax_style;
static size_t syntax_styles;
static size_t syntax_pairs;

DEFINE_ALLOCATOR(realloc_syntax_style, struct syntax_style, 32)

/* The background color a syntax style composes its foreground onto: the
 * base line type's configured background, or the default background. */
static int
syntax_style_bg(enum line_type base)
{
	struct line_info *info = get_line_info(NULL, base);

	if (info->bg != COLOR_DEFAULT)
		return info->bg;
	return get_line_info(NULL, LINE_DEFAULT)->bg;
}

int
syntax_style_get(int fg, int attr, enum line_type base)
{
	size_t i;
	struct syntax_style *style;
	int pair = 0;

#ifndef TIG_EXT_PAIR
	/* Pair IDs above 255 cannot be expressed through COLOR_PAIR() and
	 * need the extended attribute path; without it, do not allocate. */
	return 0;
#endif

	for (i = 0; i < syntax_styles; i++) {
		style = &syntax_style[i];
		if (style->fg == fg && style->attr == attr && style->base == base)
			return (int) i + 1;
	}

	if (syntax_styles >= SYNTAX_STYLE_MAX)
		return 0;

	/* Styles differing only in attributes share a color pair. */
	for (i = 0; i < syntax_styles; i++) {
		style = &syntax_style[i];
		if (style->fg == fg && style->base == base) {
			pair = style->color_pair;
			break;
		}
	}

	if (!pair) {
		if (SYNTAX_PAIR_BASE + syntax_pairs >= COLOR_PAIRS)
			return 0;
		pair = SYNTAX_PAIR_BASE + syntax_pairs++;
		tig_init_pair(pair, fg, syntax_style_bg(base));
	}

	if (!realloc_syntax_style(&syntax_style, syntax_styles, 1))
		die("Failed to allocate syntax style");

	style = &syntax_style[syntax_styles++];
	style->fg = fg;
	style->attr = attr;
	style->base = base;
	style->color_pair = pair;
	return (int) syntax_styles;
}

bool
syntax_style_attr(int style, attr_t *attr, int *pair)
{
	if (style < 1 || (size_t) style > syntax_styles)
		return false;

	*attr = syntax_style[style - 1].attr;
	*pair = syntax_style[style - 1].color_pair;
	return true;
}

/* Re-initialize syntax pairs after start_color() or configuration changes;
 * base backgrounds may have changed, pair IDs stay stable. */
static void
syntax_styles_reinit(void)
{
	size_t i;

	for (i = 0; i < syntax_styles; i++) {
		struct syntax_style *style = &syntax_style[i];
		bool first = true;
		size_t j;

		for (j = 0; j < i; j++) {
			if (syntax_style[j].color_pair == style->color_pair) {
				first = false;
				break;
			}
		}
		if (first)
			tig_init_pair(style->color_pair, style->fg,
				      syntax_style_bg(style->base));
	}
}

void
init_colors(void)
{
	char *no_color = getenv("NO_COLOR");
	struct line_rule query = { "default", STRING_SIZE("default") };
	struct line_rule *rule = find_line_rule(&query);
	int default_bg = rule ? rule->info.bg : COLOR_BLACK;
	int default_fg = rule ? rule->info.fg : COLOR_WHITE;
	enum line_type type;

	/* XXX: Even if the terminal does not support colors (e.g.
	 * TERM=dumb) init_colors() must ensure that the built-in rules
	 * have been initialized. This is done by the above call to
	 * find_line_rule(). */
	if (!has_colors() || (no_color != NULL && no_color[0] != '\0'))
		return;

	start_color();

	color_tier = COLOR_TIER_INDEXED;
#ifdef TIG_EXT_PAIR
	if (opt_truecolor != TRUECOLOR_NO && COLORS >= (1 << 24))
		color_tier = COLOR_TIER_DIRECT;
#endif
	if (color_tier == COLOR_TIER_INDEXED &&
	    opt_truecolor == TRUECOLOR_PALETTE && can_change_color()) {
		color_tier = COLOR_TIER_PALETTE;
		palette_reset();
	}

	if (assume_default_colors(resolve_color(default_fg),
				  resolve_color(default_bg)) == ERR) {
		default_bg = COLOR_BLACK;
		default_fg = COLOR_WHITE;
	}

	for (type = 0; type < line_rules; type++) {
		struct line_rule *rule = &line_rule[type];
		struct line_info *info;

		for (info = &rule->info; info; info = info->next) {
			init_line_info_color_pair(info, type, default_bg, default_fg);
		}
	}

	syntax_styles_reinit();
}

/* vim: set ts=8 sw=8 noexpandtab: */
