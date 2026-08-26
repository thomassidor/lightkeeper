import type { CircadianPlan } from './circadian-types';
import { runMigrationChain, type MigrationStep } from '../support/migrations';
import { validateCircadianPlan } from '../validation/plans';
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

export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 1;

export type CircadianMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
export const CIRCADIAN_MIGRATIONS: Record<number, CircadianMigration> = {
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
};

export interface CircadianMigrationResult {
  plan: CircadianPlan;
  migrated: boolean;
  fromVersion: number;
  steps: number[];
}

export function migrateCircadianPlan(raw: unknown): CircadianMigrationResult {
  const result = runMigrationChain(raw, {
    label: 'Circadian',
    current: CURRENT_CIRCADIAN_SCHEMA_VERSION,
    table: CIRCADIAN_MIGRATIONS,
    validate: validateCircadianPlan,
  });
  return {
    plan: result.value,
    migrated: result.migrated,
    fromVersion: result.fromVersion,
    steps: result.steps,
  };
}
