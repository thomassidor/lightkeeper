import { CURRENT_SCHEMA_VERSION, type ControllerProfile } from './controller-profile';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';

/**
 * Every profile carries schemaVersion and migrates
 * deterministically at startup. Every historical schema
 * fixture migrates without data loss, so each step is a pure function and the
 * chain is exhaustive.
 */

export type Migration = (profile: Record<string, unknown>) => Record<string, unknown>;

/**
 * Keyed by the version being migrated FROM. Add a new entry, never edit an
 * existing one — an installed base is already carrying the old shape.
 */
export const MIGRATIONS: Record<number, Migration> = {
  // 0 → 1: profiles written before schemaVersion existed. Fill in the defaults
  // that later code assumes are present.
  0: profile => ({
    ...profile,
    schemaVersion: 1,
    enabled: profile.enabled ?? true,
    behavior: { ...DEFAULT_BEHAVIOR, ...(profile.behavior ?? {}) },
    managedFlows: profile.managedFlows ?? [],
    mappings: profile.mappings ?? [],
  }),
};

export interface MigrationResult {
  profile: ControllerProfile;
  migrated: boolean;
  fromVersion: number;
  steps: number[];
}

export function migrateProfile(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Cannot migrate a profile that is not an object');
  }

  let working = { ...(raw as Record<string, unknown>) };
  const fromVersion = typeof working.schemaVersion === 'number' ? working.schemaVersion : 0;
  const steps: number[] = [];

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    // Downgrade is not something we can do safely; refusing beats corrupting.
    throw new Error(
      `Profile schema version ${fromVersion} is newer than this app understands `
      + `(${CURRENT_SCHEMA_VERSION}). Update Lightkeeper.`,
    );
  }

  let version = fromVersion;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(`No migration registered from schema version ${version}`);
    }
    working = migration(working);
    steps.push(version);
    const next = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
    if (next <= version) throw new Error(`Migration from ${version} did not advance the version`);
    version = next;
  }

  return {
    profile: working as unknown as ControllerProfile,
    migrated: steps.length > 0,
    fromVersion,
    steps,
  };
}
