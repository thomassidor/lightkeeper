import type { CircadianPlan } from './circadian-types';
import { carryBrightness } from '../outputs/light-intent';
import type { LegacyBrightnessScale } from '../app-contract';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateCircadianPlan } from '../validation/plans';

/**
 * The curve controller's own migration chain — a fourth store, a fourth schema.
 *
 * Separate from the circadian light's for the reason all four are separate: this
 * device type stores a LIST OF POINTS and the circadian light stores two ends, so
 * one version number over both would mean a change to either forcing a step
 * neither shape can supply. Same rules as the other three: add an entry, never
 * edit one, and refuse a plan from a newer build rather than guessing at it.
 *
 * Its plan type is `CircadianPlan` and its validator is
 * `validateCircadianPlan` — the curve controller IS the point-based engine, and
 * shares every type with it. What it does not share is the STORE: the point-based
 * plan lives under `curve` and the two-ended one under `circadian`.
 *
 * **Version 1 began with an empty table, and that was a deliberate reset.**
 * The pairing rewrite changed this stored shape in ways no honest step could
 * carry an old plan across. Nothing had shipped, so the installed base was one
 * Homey and its owner chose the clean slate over a migration inventing values
 * nobody had chosen.
 *
 * A device carrying an older plan needs no step here — that case is already
 * built: `runMigrationChain` refuses a `schemaVersion` higher than it knows and
 * `DeviceLifecycle` quarantines the device with its store untouched, so it comes
 * up unavailable with a reason rather than running on a plan nobody can vouch
 * for. Delete it and add it again.
 *
 * **1 → 2 (0.6.6): the Transition choice, and existing devices get BALANCED.**
 * The curve used to ease every segment with a raised cosine. Balanced is within
 * 0.016 of it at every point of every segment (interpolate.test.ts), under the
 * colour deadband, so a migrated curve does not visibly change.
 *
 * **2 → 3 (1.0.0): every brightness becomes Homey's own `dim`.** The app-wide
 * "Brightness scale" setting is gone, and with it the natural scale it defaulted
 * to (`dim = p^2.2`, so 50% read 22% in Homey). A plan saved on that scale has
 * each point's brightness converted through `carryBrightness()`, which keeps every lamp at the
 * level it was showing; one saved under *Same as Homey* already holds `dim`
 * values and is only re-stamped. Which of the two a plan is comes from the
 * retired setting itself (`legacyBrightnessScale()` on the app), passed in
 * because a step is otherwise a pure function of the stored shape.
 */

export const CURRENT_CURVE_SCHEMA_VERSION = 3;

export type CurveMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const curveMigrations = (legacy: LegacyBrightnessScale): Record<number, CurveMigration> => ({
  1: raw => ({ ...raw, transition: 'balanced', schemaVersion: 2 }),
  2: raw => ({
    ...raw,
    points: Array.isArray(raw.points)
      ? raw.points.map(point => (point && typeof point === 'object' && 'brightness' in point
        ? { ...point, brightness: carryBrightness((point as Record<string, unknown>).brightness, legacy) }
        : point))
      : raw.points,
    schemaVersion: 3,
  }),
});

export function migrateCurvePlan(
  raw: unknown,
  legacy: LegacyBrightnessScale = 'natural',
): MigrationResult<CircadianPlan> {
  return runMigrationChain(raw, {
    label: 'Curve',
    current: CURRENT_CURVE_SCHEMA_VERSION,
    table: curveMigrations(legacy),
    validate: validateCircadianPlan,
  });
}
