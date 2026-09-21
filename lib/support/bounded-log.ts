/**
 * A fixed-capacity ring of diagnostic entries, newest first.
 *
 * Three of these existed inline with three slightly different shapes — two
 * newest-first via unshift/pop, one oldest-first via push/shift — which meant
 * the settings page rendered one of them backwards. Ordering is part of the
 * contract here rather than a property of the call site: `entries()` is ALWAYS
 * newest-first.
 */
export class BoundedLog<T> {
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(private readonly cap: number, private readonly onAdd?: (entry: T) => void) {}

  add(entry: T): void {
    this.onAdd?.(entry);
    this.push(entry);
  }

  /**
   * Add, unless one of the last few entries is this same thing happening again
   * — in which case fold it into that row instead of taking a slot.
   *
   * A ring is only worth having if what it holds is news. Measured on the
   * reference Homey: one curve device dropped 341 control events in 4.8 hours
   * and 108 of the 120 it had kept were `write_pending` — the echo of a
   * pre-stage write the app had just made, which says nothing that the write
   * record does not already say. The exception that ring exists to preserve had
   * long since fallen off the end.
   *
   * `sameAs` decides identity and `repeat` decides what a second occurrence
   * does to the row it lands in; the caller owns both because only it knows
   * which fields distinguish one of its entries from another.
   *
   * `window` is scanned rather than the newest entry alone because the repeats
   * this exists for INTERLEAVE: five lamps in a room echo one write each, in
   * turn, so a newest-only test would match none of them. It is a small scan of
   * a small array, on a path that already builds an object per event.
   *
   * The sink still sees every entry. A seven-day recording is the one consumer
   * that wants the unabridged stream, and it is not the thing under memory
   * pressure — only the in-memory ring is.
   */
  addRepeat(entry: T, sameAs: (existing: T) => boolean, repeat: (existing: T) => void, window = 16): void {
    this.onAdd?.(entry);
    const scan = Math.min(window, this.items.length);
    for (let index = 0; index < scan; index += 1) {
      const existing = this.items[index] as T;
      if (!sameAs(existing)) continue;
      repeat(existing);
      return;
    }
    this.push(entry);
  }

  private push(entry: T): void {
    this.items.unshift(entry);
    if (this.items.length > this.cap) {
      this.items.pop();
      this.dropped += 1;
    }
  }

  /** Newest first, always. */
  entries(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  retention(): { capacity: number; retained: number; dropped: number } {
    return { capacity: this.cap, retained: this.size, dropped: this.dropped };
  }

  clear(): void {
    this.items.length = 0;
    this.dropped = 0;
  }
}
