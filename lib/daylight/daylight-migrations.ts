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
 * A note for whoever adds the second step. The `daylight` field the other three
 * device types now carry holds the SAME `DaylightResponse` as this plan's
 * `response`, so a change to that shape needs a step in FOUR chains rather than
 * this one. That is the cost of the response being inline in each store rather
 * than referenced from one place, and it is a cost that was chosen: a device that
 * depends on another device existing is a device that breaks when somebody
 * deletes the other one.
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

export const CURRENT_DAYLIGHT_SCHEMA_VERSION = 1;

export type DaylightMigration = MigrationStep;

/** Keyed by the version being migrated FROM. Empty: see the header. */
const DAYLIGHT_MIGRATIONS: Record<number, DaylightMigration> = {};

export function migrateDaylightPlan(raw: unknown): MigrationResult<DaylightPlan> {
  return runMigrationChain(raw, {
    label: 'Daylight',
    current: CURRENT_DAYLIGHT_SCHEMA_VERSION,
    table: DAYLIGHT_MIGRATIONS,
    validate: validateDaylightPlan,
  });
}
