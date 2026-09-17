import { quantise } from '../outputs/light-intent';

/**
 * The values a user can READ off a device, and the one place that decides when
 * one moved far enough to be worth writing.
 *
 * The deliberate sibling of `visible-state.ts`: same shape, same composition
 * rule, and the same reason for existing. `VisibleState` carries the one thing
 * the device layer renders as availability — a state and its sentence. This
 * carries the numbers the four engines compute and nothing else could see: what
 * the curve says now, what the room's light says now, what the running schedule
 * window says now. Homey registers every device capability as a global Flow tag,
 * so publishing them is what puts Lightkeeper's own arithmetic inside somebody
 * else's Flow (platform §18).
 *
 * **Why a field and not a base class.** Exactly as with `VisibleState`:
 * `DeviceRuntime` is satisfied structurally, CLAUDE.md keeps the four runtimes
 * flat on purpose, and composition buys everything a parent would.
 *
 * **The callback stays SYNCHRONOUS**, for the same reason the state one does —
 * the runtimes call `set()` from inside a tick they cannot await, and the device
 * layer queues the write on a FIFO of its own.
 *
 * **The gate is the capability's own declared resolution**, which is the same
 * argument the curve's write gate rests on (platform §12): every numeric
 * capability this publishes declares `decimals: 2`, so a change below 0.005 is
 * invisible wherever it lands — the tile, Insights, a Flow. Ungated, a curve
 * moving about 0.003 a minute would write sixty indistinguishable points an hour
 * into a user's Insights and wake the device layer sixty times to do it. Gated,
 * it publishes roughly every third tick, which is also how often the same value
 * reaches a lamp.
 */

/**
 * A value `lib/` can produce but cannot render: one or more locale keys, which
 * the device layer resolves through `homey.__` before it writes the capability.
 *
 * The same rule `StateDetail` follows, for the same reason — nothing in `lib/`
 * can translate, and a string hardcoded here could never be translated later.
 * The curve is why it has to be a LIST: a segment between two coloured points
 * blends, and the honest name for what the lamps are doing is both of them.
 */
export interface TranslatableValue {
  readonly keys: readonly string[];
}

/** What a capability can carry. `null` means "there is no such value now". */
export type PublishedValue = number | string | boolean | null | TranslatableValue;

export type PublishedValues = Readonly<Record<string, PublishedValue>>;

/**
 * The capabilities these values land in, named once.
 *
 * The runtimes publish under these keys, the device types list the subset they
 * carry, and `test/unit/device-capabilities.test.ts` ties the list to the files
 * in `.homeycompose/capabilities/` — so a capability renamed in one place and
 * not the other fails a test rather than publishing into nothing.
 */
export const VALUE_CAPABILITIES = {
  brightness: 'lightkeeper_brightness',
  temperature: 'lightkeeper_temperature',
  colour: 'lightkeeper_colour',
  daylight: 'lightkeeper_daylight',
} as const;

/** Every capability this app owns the value of, for the removal half of a sync. */
export const ALL_VALUE_CAPABILITIES: readonly string[] = Object.values(VALUE_CAPABILITIES);

/**
 * Every numeric capability in `.homeycompose/capabilities/` declares this, and
 * they declare it together on purpose: the gate below is only honest while the
 * number it rounds to is the number Homey stores.
 */
export const PUBLISHED_DECIMALS = 2;

/**
 * Round a number to what the capability can actually hold, and refuse anything
 * that is not a number at all.
 *
 * A non-finite value becomes `null` rather than `0`: `Number(null)` is 0 and 0
 * is a legitimate reading on every axis here — pitch dark, the coolest white —
 * so a NaN that arrived as zero would be indistinguishable from a real answer.
 * That is the same trap `lib/daylight/` guards on the way in.
 */
function coarsen(value: PublishedValue): PublishedValue {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) return null;
  return quantise(value, PUBLISHED_DECIMALS);
}

/** Whether a published value is a list of locale keys rather than a value. */
export function isTranslatable(value: PublishedValue): value is TranslatableValue {
  return typeof value === 'object' && value !== null && Array.isArray((value as TranslatableValue).keys);
}

/**
 * Field-wise equality for one published value.
 *
 * Identity would be wrong for the translatable variant alone: a runtime builds a
 * fresh `{ keys: [...] }` on every tick, so `===` would report a change sixty
 * times an hour for a colour that has not moved — which is precisely the noise
 * the gate exists to stop.
 */
function same(a: PublishedValue, b: PublishedValue): boolean {
  if (isTranslatable(a) || isTranslatable(b)) {
    if (!isTranslatable(a) || !isTranslatable(b)) return false;
    return a.keys.length === b.keys.length && a.keys.every((key, i) => key === b.keys[i]);
  }
  return a === b;
}

export class ValueBoard {
  private readonly values = new Map<string, PublishedValue>();

  private onChange: ((changed: PublishedValues) => void) | null = null;

  /**
   * Start listening, and receive whatever is already known.
   *
   * The replay is what makes the order of `register()` and the first tick stop
   * mattering: a schedule publishes its active window on start, before the
   * device layer has had the runtime handed back to it, and without a replay
   * that first publish would be dropped and nothing would resend it until the
   * window changed — hours later, or tomorrow.
   */
  watch(onChange: (changed: PublishedValues) => void): void {
    this.onChange = onChange;
    if (this.values.size > 0) onChange(this.snapshot());
  }

  /** Everything currently published, for diagnostics and for the replay. */
  get current(): PublishedValues {
    return this.snapshot();
  }

  /** Adopt a set of values, and tell the device layer only about the movers. */
  set(next: PublishedValues): void {
    const changed: Record<string, PublishedValue> = {};
    let moved = false;

    for (const [key, raw] of Object.entries(next)) {
      const value = coarsen(raw);
      if (this.values.has(key) && same(this.values.get(key) as PublishedValue, value)) continue;
      this.values.set(key, value);
      changed[key] = value;
      moved = true;
    }

    if (moved) this.onChange?.(changed);
  }

  private snapshot(): PublishedValues {
    return Object.fromEntries(this.values);
  }
}
