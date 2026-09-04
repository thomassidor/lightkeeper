import { DEFAULT_RESPONSE, type DaylightPlan } from './daylight-types';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateDaylightPlan } from '../validation/plans';
import { isRecord } from '../validation/guards';

/**
 * The Daylight light's own migration chain — a FIFTH store, a fifth schema.
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
 */

export const CURRENT_DAYLIGHT_SCHEMA_VERSION = 2;

export type DaylightMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
const DAYLIGHT_MIGRATIONS: Record<number, DaylightMigration> = {
  /**
   * 0 → 1: plans written before `schemaVersion` existed.
   *
   * None can exist — this driver ships at version 1 — but the step is here so
   * version 0 is never a special case in the runner's loop, exactly as it is in
   * the other four chains.
   *
   * The defaults are filled in per field rather than by spreading
   * DEFAULT_RESPONSE over the whole thing, because a partial write is the case
   * this step exists for and a spread would throw away the half that survived.
   */
  0: plan => {
    const response = isRecord(plan.response) ? plan.response : {};
    return {
      ...plan,
      schemaVersion: 1,
      enabled: plan.enabled ?? true,
      response: {
        sensors: Array.isArray(response.sensors) ? response.sensors : [],
        darkLux: response.darkLux ?? DEFAULT_RESPONSE.darkLux,
        brightLux: response.brightLux ?? DEFAULT_RESPONSE.brightLux,
        dark: response.dark ?? DEFAULT_RESPONSE.dark,
        bright: response.bright ?? DEFAULT_RESPONSE.bright,
      },
    };
  },
  /**
   * 1 → 2: the response learns when its room gets the sun.
   *
   * `'none'` is "do not model it", which is what every version-1 plan did, so
   * nothing changes for an installed device except that its schemaVersion now
   * describes the shape it actually has.
   *
   * Spread AFTER the default so a plan that somehow already carries the field
   * keeps its own value — the same order the steps above use.
   */
  1: plan => ({
    ...plan,
    schemaVersion: 2,
    response: isRecord(plan.response)
      ? { sunPeak: 'none', ...plan.response }
      : plan.response,
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
