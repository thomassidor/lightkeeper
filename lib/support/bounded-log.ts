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
