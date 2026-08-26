import type { CircadianPlan } from './circadian-types';
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

export const CURRENT_CURVE_SCHEMA_VERSION = 1;

export type CurveMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
export const CURVE_MIGRATIONS: Record<number, CurveMigration> = {
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
