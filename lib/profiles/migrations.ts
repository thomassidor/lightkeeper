import { CURRENT_SCHEMA_VERSION, type ControllerProfile } from './controller-profile';
import { runMigrationChain, type MigrationResult, type MigrationStep } from '../support/migrations';
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
 *
 * **The table is empty, and that is a deliberate reset rather than an omission.**
 * The pairing rewrite changed this stored shape in ways no honest step could
 * carry an old plan across. Nothing had shipped, so the installed base was one
 * Homey and its owner chose the clean slate over a migration inventing values
 * nobody had chosen.
 *
 * A device carrying an older plan needs no step here — that case is already
 * built: `runMigrationChain` refuses a `schemaVersion` higher than it knows and
 * `DeviceLifecycle` quarantines the device with its store untouched, so it comes
 * up unavailable with a reason rather than running on a plan nobody can vouch
 * for. Delete it and add it again.
 */

export type Migration = MigrationStep;

/**
 * Keyed by the version being migrated FROM. Add a new entry, never edit an
 * existing one — an installed base is already carrying the old shape.
 */
/** Keyed by the version being migrated FROM. Empty: see the header. */
const MIGRATIONS: Record<number, Migration> = {};

export function migrateProfile(raw: unknown): MigrationResult<ControllerProfile> {
  return runMigrationChain(raw, {
    label: 'Profile',
    current: CURRENT_SCHEMA_VERSION,
    table: MIGRATIONS,
    validate: validateControllerProfile,
  });
}
