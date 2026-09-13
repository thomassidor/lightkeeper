import type { SchedulePlan } from './schedule-types';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateSchedulePlan } from '../validation/plans';
/**
 * A schedule plan's own migration chain, separate from the controller profile's.
 *
 * Two device types, two stores, two schemas: folding schedules into the
 * controller's version number would mean a controller-only change bumping a
 * schedule's schema and vice versa, and every migration step would have to guess
 * which shape it was handed. Same rules as lib/profiles/migrations.ts — add an
 * entry, never edit one, because an installed base is already carrying the old
 * shape — and the same refusal to downgrade.
 *
 * The three chains stay separate; the RUNNER does not. It lives in
 * `lib/support/migrations.ts`, and it is what now ends every chain in a
 * validator rather than a cast.
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

export const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

export type ScheduleMigration = MigrationStep;

/** Keyed by the version being migrated FROM. Empty: see the header. */
const SCHEDULE_MIGRATIONS: Record<number, ScheduleMigration> = {};

export function migrateSchedulePlan(raw: unknown): MigrationResult<SchedulePlan> {
  return runMigrationChain(raw, {
    label: 'Schedule',
    current: CURRENT_SCHEDULE_SCHEMA_VERSION,
    table: SCHEDULE_MIGRATIONS,
    validate: validateSchedulePlan,
  });
}
