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

  constructor(private readonly cap: number) {}

  add(entry: T): void {
    this.items.unshift(entry);
    if (this.items.length > this.cap) this.items.pop();
  }

  /** Newest first, always. */
  entries(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
