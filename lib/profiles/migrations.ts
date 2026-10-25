import { CURRENT_SCHEMA_VERSION, type ControllerProfile } from './controller-profile';
import { carryBrightness } from '../outputs/light-intent';
import type { LegacyBrightnessScale } from '../app-contract';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateControllerProfile } from '../validation/plans';

/**
 * Every profile carries schemaVersion and migrates
 * deterministically at startup. Every historical schema
 * fixture migrates without data loss, so each step is a pure function and the
 * chain is exhaustive.
 *
 * The RUNNER lives in `lib/support/migrations.ts` — the object check, the
 * version read, the refuse-newer and the step loop were three byte-identical
 * copies. The table below stays here, verbatim and immutable: add an entry,
 * never edit one, because an installed base is already carrying the old shape.
 *
 * What the shared runner adds is the validator at the end. A migration chain
 * ending in a cast is a chain ending in a hope: persisted data is JSON in a
 * device store, and the code downstream reads it without asking.
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
 * every "Set brightness" button's preset converted through `carryBrightness()`, which keeps every lamp at the
 * level it was showing; one saved under *Same as Homey* already holds `dim`
 * values and is only re-stamped. Which of the two a plan is comes from the
 * retired setting itself (`legacyBrightnessScale()` on the app), passed in
 * because a step is otherwise a pure function of the stored shape.
 */

export type Migration = MigrationStep;

/**
 * Keyed by the version being migrated FROM. See the header for each step. Add a
 * new entry, never edit an existing one — an installed base is already carrying
 * the old shape.
 */
const migrations = (legacy: LegacyBrightnessScale): Record<number, Migration> => ({
  1: raw => ({
    ...raw,
    mappings: Array.isArray(raw.mappings)
      ? raw.mappings.map(rule => {
        if (!rule || typeof rule !== 'object') return rule;
        const preset = (rule as Record<string, unknown>).preset;
        if (!preset || typeof preset !== 'object' || !('brightness' in preset)) return rule;
        const record = preset as Record<string, unknown>;
        return { ...rule, preset: { ...record, brightness: carryBrightness(record.brightness, legacy) } };
      })
      : raw.mappings,
    schemaVersion: 2,
  }),
});

export function migrateProfile(
  raw: unknown,
  legacy: LegacyBrightnessScale = 'natural',
): MigrationResult<ControllerProfile> {
  return runMigrationChain(raw, {
    label: 'Profile',
    current: CURRENT_SCHEMA_VERSION,
    table: migrations(legacy),
    validate: validateControllerProfile,
  });
}
