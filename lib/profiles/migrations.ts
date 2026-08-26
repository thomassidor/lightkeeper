import { CURRENT_SCHEMA_VERSION, type ControllerProfile } from './controller-profile';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import { runMigrationChain, type MigrationStep } from '../support/migrations';
import { validateControllerProfile } from '../validation/plans';
/**
 * Every profile carries schemaVersion and migrates
 * deterministically at startup. Every historical schema
 * fixture migrates without data loss, so each step is a pure function and the
 * chain is exhaustive.
 *
 * The RUNNER lives in `lib/support/migrations.ts` — the object check, the
 * version read, the refuse-newer and the step loop were three byte-identical
 * copies. The table below stays here, verbatim and immutable: add an entry,
 * never edit one, because an installed base is already carrying the old shape.
 *
 * What the shared runner adds is the validator at the end. A migration chain
 * ending in a cast is a chain ending in a hope: persisted data is JSON in a
 * device store, and the code downstream reads it without asking.
 */

export type Migration = MigrationStep;

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
  const result = runMigrationChain(raw, {
    label: 'Profile',
    current: CURRENT_SCHEMA_VERSION,
    table: MIGRATIONS,
    validate: validateControllerProfile,
  });
  // `profile` rather than `value`: the name predates the shared runner and half
  // the app destructures it.
  return {
    profile: result.value,
    migrated: result.migrated,
    fromVersion: result.fromVersion,
    steps: result.steps,
  };
}
