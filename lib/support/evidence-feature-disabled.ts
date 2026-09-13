/**
 * The recorder, absent — and this file IS the launch app.
 *
 * `scripts/build.mjs` compiles the whole tree, then for a launch build copies
 * this module's output over `evidence-feature.js` and deletes the recorder and
 * the sampler. So every name here is reached under the OTHER file's name: read
 * it as "what `evidence-feature.ts` does when the feature is not built in", and
 * read that file's header for why the substitution exists.
 *
 * **Three rules, and each one has already been the bug waiting to happen:**
 *
 *  1. **Nothing here may import a value from `evidence-recorder` or
 *     `evidence-sampler`.** Those files are deleted from a launch build, so a
 *     value import is a `MODULE_NOT_FOUND` at app start. `import type` is fine
 *     and is used below — a type is erased and emits no `require`.
 *  2. **Every export must match its twin's shape**, or the substitution fails at
 *     runtime rather than at compile time.
 *     `test/unit/evidence-feature-surface.test.ts` compares the two in both
 *     directions and is the only thing that can catch a name added to one file
 *     and not the other.
 *  3. **`sink` must be `undefined`, not a no-op function.** A no-op would be
 *     called once per event by every producer, and each call site builds its
 *     payload object as an argument. `undefined` makes `onEvidence?.(…)`
 *     short-circuit before the argument is evaluated, so an app with no recorder
 *     pays nothing at all for having had one.
 *
 * The methods that a Web API route would have called are kept rather than
 * dropped, and they throw. Nothing can reach them — `evidenceRoutes()` returns
 * no routes and the settings page's section is stripped from the built HTML —
 * but "kept and loud" beats "absent and a TypeError" if some future caller
 * appears, and it keeps rule 2 mechanical.
 */
import type { EvidenceDeps, EvidenceRecorder, EvidenceStatus } from './evidence-recorder';
import type { EvidenceRuntime } from './evidence-sampler';
import type { EvidenceSink } from './evidence-sink';

/** Is the recorder built into THIS build? Read it rather than assuming. */
export const EVIDENCE_ENABLED = false;

export interface EvidenceSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
}

export interface EvidenceHost {
  readonly settings: EvidenceSettings;
  context(): unknown;
  sample(): {
    runtimes: Array<{ kind: string; runtime: EvidenceRuntime; configuration: unknown }>;
    sensors: unknown;
    credential: unknown;
  };
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
  log(...args: unknown[]): void;
}

const ABSENT = 'The evidence recorder is not part of this build.';

export class EvidenceFeature {
  // Accepted and ignored: `app.ts` builds the same host object either way, and
  // a constructor that differed would make the substitution visible upstream.
  // The second parameter is the twin's half of the test seam described in
  // `evidence-feature.ts` — there is no recorder here to make.
  constructor(_host: EvidenceHost, _makeRecorder?: (deps: EvidenceDeps) => EvidenceRecorder) {}

  async init(): Promise<void> {}

  /** See rule 3 above: `undefined`, never a no-op. */
  get sink(): EvidenceSink | undefined {
    return undefined;
  }

  record(_type: string, _data: unknown): void {}

  startTimer(): void {}

  stopTimer(): void {}

  /** `null`, which is what `getDiagnostics` already reported before a run began. */
  status(): EvidenceStatus | null {
    return null;
  }

  async close(): Promise<void> {}

  async refresh(): Promise<EvidenceStatus> { throw new Error(ABSENT); }
  async begin(): Promise<EvidenceStatus> { throw new Error(ABSENT); }
  async end(): Promise<EvidenceStatus> { throw new Error(ABSENT); }
  async note(_text: unknown): Promise<EvidenceStatus> { throw new Error(ABSENT); }
  async clear(_id: string): Promise<EvidenceStatus> { throw new Error(ABSENT); }
  async read(_id: string, _offset: number, _end: number): Promise<{ text: string; next: number }> {
    throw new Error(ABSENT);
  }
}

/** No routes at all, which is what removes them from the app's Web API. */
export function evidenceRoutes(
  _appOf: (homey: any) => { evidence: EvidenceFeature },
): Record<string, (args: any) => Promise<unknown>> {
  return {};
}
