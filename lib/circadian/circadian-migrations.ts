import type { CircadianPlan } from './circadian-types';

/**
 * A circadian plan's own migration chain — a third store, a third schema.
 *
 * Same rules as lib/profiles/migrations.ts and lib/schedules/schedule-migrations.ts:
 * add an entry, never edit one, because an installed base is already carrying the
 * old shape; and refuse a plan from a newer build rather than guessing at it.
 * Keeping the three chains separate is what stops a controller-only change from
 * bumping a circadian device's schema and vice versa.
 */

export const CURRENT_CIRCADIAN_SCHEMA_VERSION = 1;

export type CircadianMigration = (plan: Record<string, unknown>) => Record<string, unknown>;

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
  if (!raw || typeof raw !== 'object') {
    throw new Error('Cannot migrate a circadian plan that is not an object');
  }

  let working = { ...(raw as Record<string, unknown>) };
  const fromVersion = typeof working.schemaVersion === 'number' ? working.schemaVersion : 0;
  const steps: number[] = [];

  if (fromVersion > CURRENT_CIRCADIAN_SCHEMA_VERSION) {
    // Refusing beats corrupting: the newer shape is one this build cannot know.
    throw new Error(
      `Circadian schema version ${fromVersion} is newer than this app understands `
      + `(${CURRENT_CIRCADIAN_SCHEMA_VERSION}). Update Lightkeeper.`,
    );
  }

  let version = fromVersion;
  while (version < CURRENT_CIRCADIAN_SCHEMA_VERSION) {
    const migration = CIRCADIAN_MIGRATIONS[version];
    if (!migration) throw new Error(`No circadian migration registered from version ${version}`);
    working = migration(working);
    steps.push(version);
    const next = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
    if (next <= version) throw new Error(`Circadian migration from ${version} did not advance the version`);
    version = next;
  }

  return {
    plan: working as unknown as CircadianPlan,
    migrated: steps.length > 0,
    fromVersion,
    steps,
  };
}
