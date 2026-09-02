import type { SchedulePlan } from './schedule-types';
import { runMigrationChain, type MigrationStep } from '../support/migrations';
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
 */

export const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

export type ScheduleMigration = MigrationStep;

/** Keyed by the version being migrated FROM. */
const SCHEDULE_MIGRATIONS: Record<number, ScheduleMigration> = {
  // 0 → 1: plans written before schemaVersion existed. None shipped, but the
  // step exists so version 0 is never a special case in the loop below.
  0: plan => ({
    ...plan,
    schemaVersion: 1,
    enabled: plan.enabled ?? true,
    entries: plan.entries ?? [],
    managedFlows: plan.managedFlows ?? [],
  }),
};

export interface ScheduleMigrationResult {
  plan: SchedulePlan;
  migrated: boolean;
  fromVersion: number;
  steps: number[];
}

export function migrateSchedulePlan(raw: unknown): ScheduleMigrationResult {
  const result = runMigrationChain(raw, {
    label: 'Schedule',
    current: CURRENT_SCHEDULE_SCHEMA_VERSION,
    table: SCHEDULE_MIGRATIONS,
    validate: validateSchedulePlan,
  });
  return {
    plan: result.value,
    migrated: result.migrated,
    fromVersion: result.fromVersion,
    steps: result.steps,
  };
}
