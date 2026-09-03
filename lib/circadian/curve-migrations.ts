import type { CircadianPlan } from './circadian-types';
import { withFlooredBrightness } from '../outputs/light-intent';
import { runMigrationChain, type MigrationStep } from '../support/migrations';
import { validateCircadianPlan } from '../validation/plans';

/**
 * The curve controller's own migration chain — a fourth store, a fourth schema.
 *
 * Separate from the circadian light's for the reason all four are separate: this
 * device type stores a LIST OF POINTS and the circadian light stores two ends, so
 * one version number over both would mean a change to either forcing a step
 * neither shape can supply. Same rules as the other three: add an entry, never
 * edit one, and refuse a plan from a newer build rather than guessing at it.
 *
 * Its plan type is `CircadianPlan` and its validator is
 * `validateCircadianPlan` — the curve controller IS the point-based engine, and
 * shares every type with it. What it does not share is the STORE: the point-based
 * plan lives under `curve` and the two-ended one under `circadian`.
 */

export const CURRENT_CURVE_SCHEMA_VERSION = 2;

export type CurveMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
const CURVE_MIGRATIONS: Record<number, CurveMigration> = {
  /**
   * 0 → 1: plans written before `schemaVersion` existed.
   *
   * None can exist — this driver ships at version 1 — but the step is here so
   * version 0 is never a special case in the runner's loop, exactly as it is in
   * the other three chains.
   */
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
   * 1 → 2: every point's brightness comes up to the floor.
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
   */
  1: plan => ({
    ...plan,
    schemaVersion: 2,
    // Guarded rather than assumed: a step runs before the chain's validator, so
    // `points` may be anything at all.
    points: Array.isArray(plan.points) ? plan.points.map(withFlooredBrightness) : plan.points,
  }),
};

export interface CurveMigrationResult {
  plan: CircadianPlan;
  migrated: boolean;
  fromVersion: number;
  steps: number[];
}

export function migrateCurvePlan(raw: unknown): CurveMigrationResult {
  const result = runMigrationChain(raw, {
    label: 'Curve',
    current: CURRENT_CURVE_SCHEMA_VERSION,
    table: CURVE_MIGRATIONS,
    validate: validateCircadianPlan,
  });
  return {
    plan: result.value,
    migrated: result.migrated,
    fromVersion: result.fromVersion,
    steps: result.steps,
  };
}
