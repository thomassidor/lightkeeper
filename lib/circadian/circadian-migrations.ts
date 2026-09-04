import { sanitiseCurve } from './circadian-types';
import { DEFAULT_SIMPLE_PLAN, endsFromPoints, type SimpleCircadianPlan } from './simple-curve';
import { withFlooredBrightness } from '../outputs/light-intent';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
import { validateSimpleCircadianPlan } from '../validation/plans';
/**
 * A circadian plan's own migration chain — a third store, a third schema.
 *
 * Same rules as lib/profiles/migrations.ts and lib/schedules/schedule-migrations.ts:
 * add an entry, never edit one, because an installed base is already carrying the
 * old shape; and refuse a plan from a newer build rather than guessing at it.
 * Keeping the three chains separate is what stops a controller-only change from
 * bumping a circadian device's schema and vice versa.
 *
 * The three chains stay separate; the RUNNER does not. It lives in
 * `lib/support/migrations.ts`, and it is what now ends every chain in a
 * validator rather than a cast.
 */

/**
 * 1 → 2 is the version where this device type STOPPED being the curve editor.
 *
 * A circadian light is now two ends of the day and a fixed shape; the point-based
 * editor moved to its own device type (`drivers/curve/`). See the step below for
 * what that costs an installed device and why it is the honest trade.
 *
 * 2 → 3 brings a stored brightness up to the floor a lamp can show.
 */
export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 3;

export type CircadianMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
const CIRCADIAN_MIGRATIONS: Record<number, CircadianMigration> = {
  // 0 → 1: plans written before schemaVersion existed. None shipped, but the
  // step exists so version 0 is never a special case in the loop below.
  0: plan => ({
    ...plan,
    schemaVersion: 1,
    enabled: plan.enabled ?? true,
    points: plan.points ?? [],
    adjustBrightness: plan.adjustBrightness ?? false,
    // Opt-in, so an unknown value is a no, never a yes.
    preStage: plan.preStage === true,
  }),

  /**
   * 1 → 2: a curve of points becomes two ends of the day.
   *
   * This device type was the curve editor. It is now the simple one — warmest and
   * coolest, with the shape supplied — and the editor lives in its own device
   * type, because a five-point editor is a lot of screen for "warm at night, cool
   * in the day" and that is what most people want.
   *
   * The migration keeps the WARMEST and COOLEST points, which are the two values
   * the user actually chose and the two the new shape is built to hold. Anything
   * they set between them is lost, and it has to be: there is nowhere in the new
   * plan to put it. That is stated in the changelog rather than hidden, and a
   * Curve light is where such a curve can be rebuilt.
   *
   * `sanitiseCurve` runs first because a plan stored at version 1 has never been
   * validated — the chain ended in a cast until Phase 6 — so `points` may be
   * anything at all, and `endsFromPoints` reads `warmth` off every entry.
   */
  1: plan => {
    const { points } = sanitiseCurve(plan.points, plan.adjustBrightness === true);
    const { warmest, coolest } = endsFromPoints(points);
    return {
      schemaVersion: 2,
      enabled: plan.enabled ?? true,
      target: plan.target,
      warmest,
      coolest,
      // Carried forward only if BOTH derived ends have a brightness, which is the
      // engine's all-or-nothing rule.
      adjustBrightness: plan.adjustBrightness === true
        && warmest.brightness !== undefined && coolest.brightness !== undefined,
      // The one verdict this device type persists about itself (platform §12),
      // and it is about the integration rather than about the curve — so it
      // survives the reshape.
      preStage: plan.preStage === true,
    };
  },

  /**
   * 2 → 3: both ends' brightness comes up to the floor.
   *
   * A brightness below the floor is one the lamp could not show.
   *
   * The sliders used to start at 5%, and 5% is inside the band that quantises to
   * `dim` 0.00 — off, on most lamps (see MINIMUM_BRIGHTNESS). So the dimmest
   * setting they offered was the one that meant darkness, and a stored plan can
   * be carrying it.
   *
   * Lifting it here rather than only flooring it at write time is what keeps the
   * screens honest: a stored 5% loaded into a slider that now starts at 10%
   * DISPLAYS 10% while the plan still says 5%, so the card would show one number
   * and save another. `litDim` in the intent planner still floors the write, for
   * a plan that reaches the engine another way.
   *
   * Both ends are lifted independently, and that cannot break the engine's
   * all-or-nothing rule: it turns on whether a brightness is PRESENT, and this
   * step adds none and removes none.
   */
  2: plan => ({
    ...plan,
    schemaVersion: 3,
    warmest: withFlooredBrightness(plan.warmest),
    coolest: withFlooredBrightness(plan.coolest),
  }),
};

/** What a plan with no stored ends falls back to. Exported for the driver. */
export { DEFAULT_SIMPLE_PLAN };

export function migrateCircadianPlan(raw: unknown): MigrationResult<SimpleCircadianPlan> {
  return runMigrationChain(raw, {
    label: 'Circadian',
    current: CURRENT_CIRCADIAN_SCHEMA_VERSION,
    table: CIRCADIAN_MIGRATIONS,
    validate: validateSimpleCircadianPlan,
  });
}
