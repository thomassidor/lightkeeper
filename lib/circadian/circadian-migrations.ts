import { DEFAULT_SIMPLE_PLAN, type SimpleCircadianPlan } from './simple-curve';
import { carryBrightness } from '../outputs/light-intent';
import type { LegacyBrightnessScale } from '../app-contract';
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
 *
 * **2 → 3 (1.0.0): every brightness becomes Homey's own `dim`.** The app-wide
 * "Brightness scale" setting is gone, and with it the natural scale it defaulted
 * to (`dim = p^2.2`, so 50% read 22% in Homey). A plan saved on that scale has
 * each zone's brightness converted through `carryBrightness()`, which keeps every lamp at the
 * level it was showing; one saved under *Same as Homey* already holds `dim`
 * values and is only re-stamped. Which of the two a plan is comes from the
 * retired setting itself (`legacyBrightnessScale()` on the app), passed in
 * because a step is otherwise a pure function of the stored shape.
 */
export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 3;

export type CircadianMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const circadianMigrations = (legacy: LegacyBrightnessScale): Record<number, CircadianMigration> => ({
  1: raw => ({ ...raw, transition: 'quick', schemaVersion: 2 }),
  2: raw => {
    const zones = raw.zones && typeof raw.zones === 'object' ? raw.zones as Record<string, unknown> : null;
    if (!zones) return { ...raw, schemaVersion: 3 };
    const carried: Record<string, unknown> = { ...zones };
    for (const name of ['morning', 'midday', 'evening']) {
      const zone = zones[name];
      if (zone && typeof zone === 'object' && 'brightness' in zone) {
        const record = zone as Record<string, unknown>;
        carried[name] = { ...record, brightness: carryBrightness(record.brightness, legacy) };
      }
    }
    return { ...raw, zones: carried, schemaVersion: 3 };
  },
});

/** What a plan with no stored zones falls back to. Exported for the driver. */
export { DEFAULT_SIMPLE_PLAN };

export function migrateCircadianPlan(
  raw: unknown,
  legacy: LegacyBrightnessScale = 'natural',
): MigrationResult<SimpleCircadianPlan> {
  return runMigrationChain(raw, {
    label: 'Circadian',
    current: CURRENT_CIRCADIAN_SCHEMA_VERSION,
    table: circadianMigrations(legacy),
    validate: validateSimpleCircadianPlan,
  });
}
