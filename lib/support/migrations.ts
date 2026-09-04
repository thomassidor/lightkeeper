/**
 * The migration chain, once.
 *
 * Three stores, three schemas, three chains — and that separation is deliberate
 * (folding schedules into the controller's version number would mean a
 * controller-only change bumping a schedule's schema, and every step guessing
 * which shape it was handed). What was NOT deliberate is three copies of the
 * RUNNER: the object check, the version read, the refuse-newer, the step loop
 * and the non-advancing guard were byte-identical apart from the noun in each
 * error message.
 *
 * The historical steps stay where they are, verbatim and immutable, in the three
 * feature modules. **Add an entry, never edit one** — an installed base is
 * already carrying the old shape, and rewriting a step rewrites history for
 * everyone who has not upgraded yet.
 *
 * One thing this adds beyond the three copies, and it is the point of extracting
 * them: a REQUIRED validator. Every chain now ends in a check that the value is
 * actually the shape the app is about to act on. Persisted data is not trusted
 * data: it is JSON in a device store that a downgrade, a partial write or a
 * hand-edit can leave in any shape at all, and the code downstream reads
 * `plan.entries.map(...)` without asking.
 */

export interface MigrationResult<T> {
  /**
   * Named `plan` rather than `value` because every one of the five chains
   * renamed it on the way out — four to `plan` and the controller's to
   * `profile` — each through a ~20-line adapter and a result interface with no
   * consumer outside its own file. `PlanMigration` in the device layer is now
   * satisfied structurally, so a chain can be returned straight to it.
   */
  plan: T;
  migrated: boolean;
  fromVersion: number;
  /** The versions stepped THROUGH, in order. Diagnostics only. */
  steps: number[];
}

export type MigrationStep = (raw: Record<string, unknown>) => Record<string, unknown>;

export interface MigrationChain<T> {
  /** What this chain is about, for every error message. e.g. 'Schedule'. */
  label: string;
  current: number;
  /** Keyed by the version being migrated FROM. */
  table: Record<number, MigrationStep>;
  /**
   * The last word. Returns the typed value or throws with a reason.
   *
   * Required rather than optional: an optional validator is one nobody adds.
   */
  validate: (value: unknown) => T;
}

/**
 * A generous cap on how many steps one chain may take.
 *
 * The loop is already guarded against a step that fails to advance the version,
 * but not against a table that advances in a cycle — 1 → 2 → 1 — which would spin
 * forever inside a device's `onInit` and take the app down with it. Fifty is far
 * above any plausible schema history and far below a hang.
 */
const MAX_STEPS = 50;

export function runMigrationChain<T>(raw: unknown, chain: MigrationChain<T>): MigrationResult<T> {
  const { label, current, table, validate } = chain;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Cannot migrate a ${label.toLowerCase()} that is not an object`);
  }

  let working = { ...(raw as Record<string, unknown>) };
  const fromVersion = readVersion(working.schemaVersion, label);
  const steps: number[] = [];

  if (fromVersion > current) {
    // Refusing beats corrupting: the newer shape is one this build cannot know.
    throw new Error(
      `${label} schema version ${fromVersion} is newer than this app understands `
      + `(${current}). Update Lightkeeper.`,
    );
  }

  let version = fromVersion;
  while (version < current) {
    if (steps.length >= MAX_STEPS) {
      throw new Error(`${label} migration did not terminate after ${MAX_STEPS} steps`);
    }
    const step = table[version];
    if (!step) throw new Error(`No ${label.toLowerCase()} migration registered from version ${version}`);

    working = step(working);
    steps.push(version);

    const next = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
    if (next <= version) {
      throw new Error(`${label} migration from ${version} did not advance the version`);
    }
    version = next;
  }

  return {
    plan: validate(working),
    migrated: steps.length > 0,
    fromVersion,
    steps,
  };
}

/**
 * An ABSENT version is 0 — that is what data written before `schemaVersion`
 * existed looks like, and the 0 → 1 step is what handles it.
 *
 * A version that is PRESENT and not a non-negative integer is different: it is
 * not old data, it is corrupt data, and reading `"1"` or `1.5` or `NaN` as 0
 * would replay every historical step over a shape that has already been through
 * them. Refuse, and let the device report that it has no usable configuration.
 */
function readVersion(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} schema version is malformed`);
  }
  return value;
}
