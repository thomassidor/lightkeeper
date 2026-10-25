import type { SchedulePlan } from './schedule-types';
import { carryBrightness } from '../outputs/light-intent';
import type { LegacyBrightnessScale } from '../app-contract';
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
 *
 * **1 → 2 (1.0.0): every brightness becomes Homey's own `dim`.** The app-wide
 * "Brightness scale" setting is gone, and with it the natural scale it defaulted
 * to (`dim = p^2.2`, so 50% read 22% in Homey). A plan saved on that scale has
 * each window's brightness converted through `carryBrightness()`, which keeps every lamp at the
 * level it was showing; one saved under *Same as Homey* already holds `dim`
 * values and is only re-stamped. Which of the two a plan is comes from the
 * retired setting itself (`legacyBrightnessScale()` on the app), passed in
 * because a step is otherwise a pure function of the stored shape.
 */

export const CURRENT_SCHEDULE_SCHEMA_VERSION = 2;

export type ScheduleMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const scheduleMigrations = (legacy: LegacyBrightnessScale): Record<number, ScheduleMigration> => ({
  1: raw => ({
    ...raw,
    entries: Array.isArray(raw.entries)
      ? raw.entries.map(entry => (entry && typeof entry === 'object' && 'brightness' in entry
        ? { ...entry, brightness: carryBrightness((entry as Record<string, unknown>).brightness, legacy) }
        : entry))
      : raw.entries,
    schemaVersion: 2,
  }),
});

export function migrateSchedulePlan(
  raw: unknown,
  legacy: LegacyBrightnessScale = 'natural',
): MigrationResult<SchedulePlan> {
  return runMigrationChain(raw, {
    label: 'Schedule',
    current: CURRENT_SCHEDULE_SCHEMA_VERSION,
    table: scheduleMigrations(legacy),
    validate: validateSchedulePlan,
  });
}
