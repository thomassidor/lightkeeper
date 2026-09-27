import { type DaylightPlan } from './daylight-types';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateDaylightPlan } from '../validation/plans';

/**
 * The Room-sensing Light's own migration chain — a FIFTH store, a fifth schema.
 *
 * Separate from the other four for the reason all of them are separate: this
 * device type stores a response and nothing else, and one version number shared
 * with a plan that stores points would mean a change to either forcing a step
 * neither shape can supply. Same rules: add an entry, never edit one, and refuse
 * a plan from a newer build rather than guessing at it.
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
 * Both ramps used to be eased with a raised cosine; Balanced is within 0.016 of
 * it everywhere (interpolate.test.ts), so a migrated room does not visibly
 * change. It goes INSIDE `response` — see `DaylightResponse.transition`. A
 * response that is not an object is left for the validator to refuse with its
 * own path, rather than replaced here by one that would pass.
 */

export const CURRENT_DAYLIGHT_SCHEMA_VERSION = 2;

export type DaylightMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const DAYLIGHT_MIGRATIONS: Record<number, DaylightMigration> = {
  1: raw => ({
    ...raw,
    response: raw.response && typeof raw.response === 'object'
      ? { ...raw.response as Record<string, unknown>, transition: 'balanced' }
      : raw.response,
    schemaVersion: 2,
  }),
};

export function migrateDaylightPlan(raw: unknown): MigrationResult<DaylightPlan> {
  return runMigrationChain(raw, {
    label: 'Daylight',
    current: CURRENT_DAYLIGHT_SCHEMA_VERSION,
    table: DAYLIGHT_MIGRATIONS,
    validate: validateDaylightPlan,
  });
}
