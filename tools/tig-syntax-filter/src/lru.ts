/**
 * A byte-budgeted LRU map.  An entry-count bound lets a few multi-megabyte
 * values dominate memory; a byte budget bounds what matters.  Sizes are
 * the caller's approximations.
 */

import { A } from "ayy";

export class ByteLRU<V> {
	private map = new Map<string, { value: V, bytes: number }>();
	private total = 0;
	private budget: number;
	private size_of: (value: V) => number;

	/**
	 * @param budget    Approximate total byte budget; evicts oldest past it.
	 * @param size_of   Approximate byte size of one value.  Values over half
	 *                  the budget are not cached at all: one such entry would
	 *                  evict everything else for a single revisit's benefit.
	 */
	constructor(budget: number, size_of: (value: V) => number) {
		A(budget > 0, "ByteLRU budget must be positive");
		this.budget = budget;
		this.size_of = size_of;
	}

	get(key: string): V | undefined {
		const entry = this.map.get(key);
		if (entry === undefined) {
			return undefined;
		}
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	/** Cache `value` under `key`, replacing any value there, then evict
	 * the oldest entries past the budget; but if `value` is over
	 * max_value_bytes, change nothing. */
	set(key: string, value: V): void {
		const bytes = this.size_of(value);
		if (bytes > this.max_value_bytes) {
			return;
		}
		const existing = this.map.get(key);
		if (existing !== undefined) {
			this.total -= existing.bytes;
			this.map.delete(key);
		}
		this.map.set(key, { value, bytes });
		this.total += bytes;
		while (this.total > this.budget) {
			const oldest = this.map.keys().next().value as string;
			this.total -= this.map.get(oldest)!.bytes;
			this.map.delete(oldest);
		}
	}

	/** Drop every entry (idle shedding). */
	clear(): void {
		this.map.clear();
		this.total = 0;
	}

	/** The largest value size set() caches. */
	get max_value_bytes(): number {
		return this.budget / 2;
	}

	/** Current approximate resident bytes (for tests and logging). */
	get bytes(): number {
		return this.total;
	}

	/** Current entry count (for tests and logging). */
	get size(): number {
		return this.map.size;
	}
}
