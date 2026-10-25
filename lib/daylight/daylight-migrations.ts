import { type DaylightPlan } from './daylight-types';
import { carryBrightness } from '../outputs/light-intent';
import type { LegacyBrightnessScale } from '../app-contract';
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
 *
 * **2 → 3 (1.0.0): every brightness becomes Homey's own `dim`.** The app-wide
 * "Brightness scale" setting is gone, and with it the natural scale it defaulted
 * to (`dim = p^2.2`, so 50% read 22% in Homey). A plan saved on that scale has
 * the response's two ends (`dark`, `bright`) converted through `carryBrightness()`, which keeps every lamp at the
 * level it was showing; one saved under *Same as Homey* already holds `dim`
 * values and is only re-stamped. Which of the two a plan is comes from the
 * retired setting itself (`legacyBrightnessScale()` on the app), passed in
 * because a step is otherwise a pure function of the stored shape.
 */

export const CURRENT_DAYLIGHT_SCHEMA_VERSION = 3;

export type DaylightMigration = MigrationStep;

/** Keyed by the version being migrated FROM. See the header for each step. */
const daylightMigrations = (legacy: LegacyBrightnessScale): Record<number, DaylightMigration> => ({
  1: raw => ({
    ...raw,
    response: raw.response && typeof raw.response === 'object'
      ? { ...raw.response as Record<string, unknown>, transition: 'balanced' }
      : raw.response,
    schemaVersion: 2,
  }),
  2: raw => {
    const response = raw.response && typeof raw.response === 'object'
      ? raw.response as Record<string, unknown>
      : null;
    return {
      ...raw,
      response: response
        ? { ...response, dark: carryBrightness(response.dark, legacy), bright: carryBrightness(response.bright, legacy) }
        : raw.response,
      schemaVersion: 3,
    };
  },
});

export function migrateDaylightPlan(
  raw: unknown,
  legacy: LegacyBrightnessScale = 'natural',
): MigrationResult<DaylightPlan> {
  return runMigrationChain(raw, {
    label: 'Daylight',
    current: CURRENT_DAYLIGHT_SCHEMA_VERSION,
    table: daylightMigrations(legacy),
    validate: validateDaylightPlan,
  });
}
