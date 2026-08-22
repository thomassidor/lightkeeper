import type { SchedulePlan } from './schedule-types';

/**
 * A schedule plan's own migration chain, separate from the controller profile's.
 *
 * Two device types, two stores, two schemas: folding schedules into the
 * controller's version number would mean a controller-only change bumping a
 * schedule's schema and vice versa, and every migration step would have to guess
 * which shape it was handed. Same rules as lib/profiles/migrations.ts — add an
 * entry, never edit one, because an installed base is already carrying the old
 * shape — and the same refusal to downgrade.
 */

export const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

export type ScheduleMigration = (plan: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version being migrated FROM. */
export const SCHEDULE_MIGRATIONS: Record<number, ScheduleMigration> = {
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
  if (!raw || typeof raw !== 'object') {
    throw new Error('Cannot migrate a schedule that is not an object');
  }

  let working = { ...(raw as Record<string, unknown>) };
  const fromVersion = typeof working.schemaVersion === 'number' ? working.schemaVersion : 0;
  const steps: number[] = [];

  if (fromVersion > CURRENT_SCHEDULE_SCHEMA_VERSION) {
    // Refusing beats corrupting: the newer shape is one this build cannot know.
    throw new Error(
      `Schedule schema version ${fromVersion} is newer than this app understands `
      + `(${CURRENT_SCHEDULE_SCHEMA_VERSION}). Update Lightkeeper.`,
    );
  }

  let version = fromVersion;
  while (version < CURRENT_SCHEDULE_SCHEMA_VERSION) {
    const migration = SCHEDULE_MIGRATIONS[version];
    if (!migration) throw new Error(`No schedule migration registered from version ${version}`);
    working = migration(working);
    steps.push(version);
    const next = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
    if (next <= version) throw new Error(`Schedule migration from ${version} did not advance the version`);
    version = next;
  }

  return {
    plan: working as unknown as SchedulePlan,
    migrated: steps.length > 0,
    fromVersion,
    steps,
  };
}
