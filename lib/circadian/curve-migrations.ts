import type { CircadianPlan } from './circadian-types';
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
 * **The table is empty, and that is a deliberate reset rather than an omission.**
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
 */

export const CURRENT_CURVE_SCHEMA_VERSION = 1;

export type CurveMigration = MigrationStep;

/** Keyed by the version being migrated FROM. Empty: see the header. */
const CURVE_MIGRATIONS: Record<number, CurveMigration> = {};

export function migrateCurvePlan(raw: unknown): MigrationResult<CircadianPlan> {
  return runMigrationChain(raw, {
    label: 'Curve',
    current: CURRENT_CURVE_SCHEMA_VERSION,
    table: CURVE_MIGRATIONS,
    validate: validateCircadianPlan,
  });
}
