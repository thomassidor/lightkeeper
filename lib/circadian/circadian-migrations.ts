import { DEFAULT_SIMPLE_PLAN, type SimpleCircadianPlan } from './simple-curve';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateSimpleCircadianPlan } from '../validation/plans';

/**
 * A circadian plan's own migration chain — one store, one schema.
 *
 * **Version 1 began with an empty table, and that was a deliberate reset.**
 * The pairing rewrite changed this device type from two ends of the day plus a
 * fixed four-point shape to three zones with boundaries that follow the sun.
 * There is no honest step from the old shape to the new one: two temperatures
 * cannot say what the morning and the evening should each look like, and
 * inventing the third from the other two would produce an evening nobody chose,
 * on a device whose whole job is the colour of somebody's evening.
 *
 * Nothing had shipped, so the installed base was one Homey and its owner chose
 * the clean slate. What happens to a device carrying an older plan is already
 * built and needs no step here: `runMigrationChain` refuses a `schemaVersion`
 * higher than it knows, and `DeviceLifecycle` quarantines the device with its
 * store untouched — so it comes up unavailable with a reason rather than running
 * on a plan nobody can vouch for. Delete it and add it again.
 *
 * The chain itself stays, and so do the other four. The rules are unchanged for
 * everything after this point: add an entry, never edit one, and refuse a plan
 * from a newer build rather than guessing at it.
 *
 * **1 → 2 (0.6.6): the Transition choice, and existing devices get QUICK.**
 * The zones used to be held flat and blended only across a fixed 100 minutes
 * centred on each boundary; now each zone blends into the next across the whole
 * gap, shaped by `transition` (`zoneValueAt`). No choice reproduces the old
 * shape — it was not a member of the family — and Quick is the nearest: most of
 * its change happens in the middle of the window, around the boundary, which is
 * where the old ramp put all of it. New devices get Balanced. The change is
 * named in the changelog, because a device that looks different tomorrow with
 * no explanation is the worse surprise.
 */
export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 2;

export type CircadianMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const CIRCADIAN_MIGRATIONS: Record<number, CircadianMigration> = {
  1: raw => ({ ...raw, transition: 'quick', schemaVersion: 2 }),
};

/** What a plan with no stored zones falls back to. Exported for the driver. */
export { DEFAULT_SIMPLE_PLAN };

export function migrateCircadianPlan(raw: unknown): MigrationResult<SimpleCircadianPlan> {
  return runMigrationChain(raw, {
    label: 'Circadian',
    current: CURRENT_CIRCADIAN_SCHEMA_VERSION,
    table: CIRCADIAN_MIGRATIONS,
    validate: validateSimpleCircadianPlan,
  });
}
