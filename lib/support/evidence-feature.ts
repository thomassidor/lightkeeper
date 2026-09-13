/**
 * The seven-day recorder, as ONE module — and the only one `app.ts` or `api.ts`
 * may name.
 *
 * ## Why this file exists at all
 *
 * The recorder is a development tool. It is genuinely useful — a single 3.83-day
 * archive found five defects that reading the code had not, and
 * `docs/evidence-findings.md` is that read — and it has no business in the app a
 * household installs: it writes an encrypted archive to `/userdata`, exposes six
 * Web API routes, and puts a "Start seven-day recording" button on the settings
 * page. None of that is for them, and all of it is surface an App Store reviewer
 * would reasonably ask about.
 *
 * So it is built out of the launch app entirely, and back in on request.
 * `scripts/build.mjs` is the switch and `.dev-build` is what flips it; this file
 * is what makes the switch a one-file substitution rather than surgery:
 *
 *  - **A launch build** replaces the compiled `evidence-feature.js` with the
 *    compiled `evidence-feature-disabled.js`, then deletes `evidence-recorder.js`
 *    and `evidence-sampler.js` outright. Nothing else in the tree changes,
 *    because nothing else imports them.
 *  - **A dev build** leaves this file in place and the recorder works.
 *
 * That is also why the feature's Web API routes live down here rather than in
 * `api.ts` where routes belong. A route defined in `api.ts` would have to be
 * *removed* from generated JavaScript by string surgery; a route defined here
 * disappears because `evidenceRoutes()` returns `{}` in the twin. `api.ts`
 * spreads whatever it is handed and never knows which build it is in.
 *
 * ## The contract with the twin
 *
 * `evidence-feature-disabled.ts` must export the same names with the same
 * shapes, or a launch build fails at runtime rather than at compile time —
 * exactly the failure mode a file substitution invites.
 * `test/unit/evidence-feature-surface.test.ts` holds that line in both
 * directions, and `scripts/build.mjs` verifies after stripping that no
 * reference to the recorder survives anywhere in `.homeybuild`.
 *
 * ## What does NOT change between the two builds
 *
 * Every producer. The runtimes, their managers, the lux service and the control
 * history all depend on `EvidenceSink` — a type, alone in a file, whose docblock
 * has always said the recorder "can be absent". They are handed `undefined` in a
 * launch build and an optional call short-circuits before its argument is even
 * built. That seam is why this is one new file and three small edits rather than
 * a refactor.
 */
import { EvidenceRecorder, type EvidenceDeps, type EvidenceStatus } from './evidence-recorder';
import { EvidenceSampler, memoryUsage, type EvidenceRuntime } from './evidence-sampler';
import type { EvidenceSink } from './evidence-sink';
import { messageOf } from './homey-errors';

/** Is the recorder built into THIS build? Read it rather than assuming. */
export const EVIDENCE_ENABLED = true;

/** Where the archive lives. Named once, so the twin can name it too. */
const EVIDENCE_DIRECTORY = '/userdata/lightkeeper-evidence';

/** The buffer is flushed every tick; every fourth tick also takes a sample. */
const FLUSH_MS = 15_000;
const TICKS_PER_SAMPLE = 4;

export interface EvidenceSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
}

/**
 * What the feature needs from the app, and nothing more.
 *
 * Deliberately not `LightkeeperApp`: the twin has to satisfy this too, and an
 * interface naming four registries would make the disabled build depend on the
 * shape of things it never touches.
 */
export interface EvidenceHost {
  readonly settings: EvidenceSettings;
  /** App version, node version, timezone, uptime — on every record carrying context. */
  context(): unknown;
  /** Everything one per-minute health sample is made of. */
  sample(): {
    runtimes: Array<{ kind: string; runtime: EvidenceRuntime; configuration: unknown }>;
    sensors: unknown;
    credential: unknown;
  };
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
  log(...args: unknown[]): void;
}

export class EvidenceFeature {
  private recorder!: EvidenceRecorder;
  private sampler!: EvidenceSampler;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;

  /**
   * `makeRecorder` is a test seam, and the same one `memoryUsage()` and the
   * `Timers` interface already are: everything this class does to a recorder —
   * the note rules, the flush-before-report, the sample on `begin()` — is
   * reachable no other way, because `init()` is what builds the recorder and a
   * test cannot reach inside it. Default it and production never sees it.
   */
  constructor(
    private readonly host: EvidenceHost,
    private readonly makeRecorder: (deps: EvidenceDeps) => EvidenceRecorder =
    deps => new EvidenceRecorder(deps),
  ) {}

  async init(): Promise<void> {
    this.recorder = this.makeRecorder({
      directory: EVIDENCE_DIRECTORY,
      settings: this.host.settings,
    });
    this.sampler = new EvidenceSampler(this.recorder.record);
    await this.recorder.init(this.host.context());
  }

  /**
   * What every producer is handed as its `onEvidence`.
   *
   * A getter rather than a field because `init()` builds the recorder and the
   * managers that take this are constructed after it. `undefined` in the twin,
   * which is the entire mechanism by which a launch build records nothing.
   */
  get sink(): EvidenceSink | undefined {
    return this.recorder.record;
  }

  record(type: string, data: unknown): void {
    this.recorder.record(type, data);
  }

  /** The flush-and-sample timer. Started once, at the end of `onInit`. */
  startTimer(): void {
    this.takeSample();
    this.timer = this.host.setInterval(() => {
      if (++this.ticks % TICKS_PER_SAMPLE === 0) this.takeSample();
      this.recorder.flush().catch(error => this.host.log('Evidence flush', messageOf(error)));
    }, FLUSH_MS);
  }

  stopTimer(): void {
    if (this.timer !== null) this.host.clearInterval(this.timer);
    this.timer = null;
  }

  private takeSample(): void {
    if (this.recorder.status().state !== 'recording') return;
    try {
      const { runtimes, sensors, credential } = this.host.sample();
      this.sampler.sample(runtimes);
      this.recorder.record('health_sample', {
        ...(this.host.context() as object),
        memory: memoryUsage(), sensors, credential, recorder: this.recorder.status(),
      });
    } catch (error) {
      this.recorder.record('sampling_error', { message: messageOf(error) });
    }
  }

  /** For `getDiagnostics`, which reports the recorder's state beside everything else. */
  status(): EvidenceStatus | null {
    return this.recorder.status();
  }

  async close(): Promise<void> {
    await this.recorder.close();
  }

  // ---- what the six Web API routes call, and the only way in from outside ----

  /** Flush first, so the page never shows a count the buffer has already passed. */
  async refresh(): Promise<EvidenceStatus> {
    await this.recorder.flush();
    return this.recorder.status();
  }

  /**
   * Begin a run, and take the first sample immediately.
   *
   * The sampler is rebuilt because a run following a previous one must not
   * inherit the cached configuration encodings that suppress an unchanged
   * `configuration` record — the new archive has never seen them.
   */
  async begin(): Promise<EvidenceStatus> {
    const status = await this.recorder.start(this.host.context());
    this.sampler = new EvidenceSampler(this.recorder.record);
    this.takeSample();
    await this.recorder.flush();
    return { ...status, ...this.recorder.status() };
  }

  async end(): Promise<EvidenceStatus> {
    return this.recorder.stop();
  }

  async note(text: unknown): Promise<EvidenceStatus> {
    const status = this.recorder.status();
    if (status.state !== 'recording' || Date.now() >= (status.endsAt ?? 0)) throw new Error('No active recording.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Enter an observation of at most 1000 characters.');
    this.recorder.record('observation', { text: text.trim() });
    return this.refresh();
  }

  async clear(id: string): Promise<EvidenceStatus> {
    return this.recorder.clear(id);
  }

  async read(id: string, offset: number, end: number): Promise<{ text: string; next: number }> {
    return this.recorder.read(id, offset, end);
  }
}

/**
 * The feature's six Web API routes, or — in the twin — none of them.
 *
 * `appOf` is passed in rather than imported so this module never depends on
 * `api.ts`, which imports it. Route names must match the `api` block in
 * `.homeycompose/app.json`; `scripts/build.mjs` strips those six declarations
 * from the packaged manifest, so a launch build does not advertise handlers it
 * does not have.
 */
export function evidenceRoutes(
  appOf: (homey: any) => { evidence: EvidenceFeature },
): Record<string, (args: any) => Promise<unknown>> {
  const feature = (homey: any) => appOf(homey).evidence;
  return {
    async getEvidence({ homey }: any) { return feature(homey).refresh(); },
    async noteEvidence({ homey, body }: any) { return feature(homey).note(body?.text); },
    async startEvidence({ homey }: any) { return feature(homey).begin(); },
    async stopEvidence({ homey }: any) { return feature(homey).end(); },
    async clearEvidence({ homey, params }: any) { return feature(homey).clear(String(params.id)); },
    async readEvidence({ homey, params }: any) {
      return feature(homey).read(String(params.id), Number(params.offset), Number(params.end));
    },
  };
}
