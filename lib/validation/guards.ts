/**
 * The small explicit checks the three plan validators are built from.
 *
 * Hand-written, and no new dependency: `zod` and friends are excellent and they
 * are also 10–50 kB of bundle inside a Homey app for three schemas, on a
 * `@tsconfig/node16` target whose emitted JS is what was hardware-verified. Small
 * named functions also match the rest of `lib/` — the planner and the window
 * maths are the same shape.
 *
 * Every failure throws with a PATH, because the message ends up in a log line
 * next to a device that has gone unavailable, and "invalid" without a path is a
 * message nobody can act on.
 */

export class ValidationError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path || 'value'} ${reason}`);
    this.name = 'ValidationError';
  }
}

export function fail(path: string, reason: string): never {
  throw new ValidationError(path, reason);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'is not an object');
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'is not a non-empty string');
  return value;
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'is not a boolean');
  return value;
}

/**
 * A finite number in range. `Number.isFinite` rather than `typeof === 'number'`
 * because `NaN` and `Infinity` are numbers, survive `JSON.parse` as `null` or
 * not at all, and reach arithmetic that produces no error and no effect.
 */
export function requireNumber(
  value: unknown,
  path: string,
  range?: { min?: number; max?: number; integer?: boolean },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'is not a finite number');
  if (range?.integer && !Number.isInteger(value)) fail(path, 'is not an integer');
  if (range?.min !== undefined && value < range.min) fail(path, `is below ${range.min}`);
  if (range?.max !== undefined && value > range.max) fail(path, `is above ${range.max}`);
  return value;
}

export function optionalNumber(
  value: unknown,
  path: string,
  range?: { min?: number; max?: number; integer?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, path, range);
}

/**
 * An array, bounded.
 *
 * The cap is not defensive theatre. Every one of these lists becomes a loop over
 * device writes or generated Flows, and the app's own limits are far lower than
 * the caps here (12 schedule windows, 12 flow variants). A stored list of 100 000
 * entries is corruption or an attack, and either way iterating it inside a
 * device's `onInit` takes the app down rather than reporting a bad plan.
 */
export function requireArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'is not a list');
  if (value.length > max) fail(path, `has more than ${max} entries`);
  return value;
}

/**
 * One of a closed set.
 *
 * Exhaustive over the discriminant on purpose: an unknown `kind` reaching a
 * `switch` that has no `default` is a silent no-op, which is how a target the app
 * cannot drive reads as a target it simply chose not to write to.
 */
export function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `is not one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** A 0–1 value, already clamped by the sanitiser on the way in. */
export function requireUnitInterval(value: unknown, path: string): number {
  return requireNumber(value, path, { min: 0, max: 1 });
}
