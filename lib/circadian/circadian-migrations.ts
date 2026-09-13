import { DEFAULT_SIMPLE_PLAN, type SimpleCircadianPlan } from './simple-curve';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateSimpleCircadianPlan } from '../validation/plans';

/**
 * A circadian plan's own migration chain — one store, one schema.
 *
 * **The table is empty, and that is a deliberate reset rather than an omission.**
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
 */
export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 1;

export type CircadianMigration = MigrationStep;

/** Keyed by the version being migrated FROM. Empty: see the header. */
const CIRCADIAN_MIGRATIONS: Record<number, CircadianMigration> = {};

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
