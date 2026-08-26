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

  /**
   * 1 → 2: the binding shape becomes canonical.
   *
   * Two changes, both in `catalogue[].binding`, which is where the persisted
   * bindings live:
   *
   *  - `args` becomes `fixedArgs`, and every kind has it. `flow_range` never had
   *    anywhere to put a selector or a direction, so its compiled flows set only
   *    the magnitude and fired on every control of the remote.
   *  - `flow_range`'s `valueRange: [from, to]` becomes `values: number[]`, the
   *    card's exact set. A contiguous integer range expands to the same values it
   *    always did, so the compiled `range:<value>` variant keys are unchanged and
   *    no installed controller's Flows churn. A sparse set stored by an older
   *    version was already producing flows for values the card never accepted —
   *    those legitimately change, and Phase 1's replacement machinery swaps them.
   *
   * `values` is derived from the stored endpoints rather than from the live card
   * on purpose: a migration must be a pure function of what is on disk. The next
   * discovery pass reads the card and corrects a sparse set; the fingerprint
   * check is what notices it moved.
   */
  1: profile => ({
    ...profile,
    schemaVersion: 2,
    catalogue: Array.isArray(profile.catalogue)
      ? (profile.catalogue as Array<Record<string, unknown>>).map(migrateCatalogueEntry)
      : profile.catalogue,
  }),
};

function migrateCatalogueEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const binding = entry?.binding;
  if (!binding || typeof binding !== 'object') return entry;
  return { ...entry, binding: migrateBinding(binding as Record<string, unknown>) };
}

function migrateBinding(binding: Record<string, unknown>): Record<string, unknown> {
  // `direct_capability` has no trigger arguments at all and is left alone.
  if (binding.kind === 'direct_capability') return binding;

  const { args, valueRange, ...rest } = binding;
  const fixedArgs = isRecord(binding.fixedArgs)
    ? binding.fixedArgs
    : (isRecord(args) ? args : {});

  const migrated: Record<string, unknown> = { ...rest, fixedArgs };

  if (binding.kind === 'flow_range' && !Array.isArray(binding.values)) {
    migrated.values = expandStoredRange(valueRange);
  }

  return migrated;
}

/**
 * A stored `[from, to]` becomes the integers it always expanded to.
 *
 * A pair that is not two finite numbers becomes an empty list rather than a
 * guess: `compileRange` refuses an empty one through `InvalidRangeError`, which
 * marks the control unsupported and names it — far better than a control that
 * looks configured and compiles to nothing.
 */
function expandStoredRange(valueRange: unknown): number[] {
  if (!Array.isArray(valueRange) || valueRange.length !== 2) return [];
  const [from, to] = valueRange.map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];

  const values: number[] = [];
  for (let value = Math.round(from); value <= Math.round(to); value += 1) values.push(value);
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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
