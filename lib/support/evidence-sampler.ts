import type { EvidenceSink } from './evidence-sink';

/**
 * `process.memoryUsage()`, or null — because on a Homey it THROWS.
 *
 * Measured on Homey Pro 2023, firmware 13.5.0 (platform §17): every call raises
 * `ENOENT: no such file or directory, uv_resident_set_memory`. The app sandbox
 * does not expose the `/proc` entry libuv reads for RSS, and Node surfaces that
 * as a plain ENOENT rather than as anything resembling a permission problem.
 * `process.uptime()` and `process.version` are both fine, so the failure is
 * specific to the resident-set read.
 *
 * **The trap is not the throw, it is where the throw lands.** This was called
 * bare inside the object literal handed to `record()`, and a literal is
 * evaluated in full before the call it is an argument to — so one throwing
 * property took the WHOLE health sample with it: the timezone, the sensor ages,
 * the credential status, none of which have anything to do with memory. The
 * surrounding catch then wrote a `sampling_error` in its place, once per
 * sample, for the life of the recording. The first archive this feature ever
 * produced held eight identical errors and zero health samples.
 *
 * It lives HERE rather than in `app.ts` so that it can be tested at all: a file
 * containing `extends Homey.App` cannot be imported by a test (platform §13),
 * and a guard nobody can exercise is a guard nobody can trust.
 *
 * The app's own footprint is readable from OUTSIDE — `apps.getAppUsage`'s `pss`,
 * which `scripts/verify-hardware.mjs memory` reads — so nothing that mattered
 * is lost; it simply cannot be read from in here.
 */
export function memoryUsage(
  read: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): NodeJS.MemoryUsage | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export interface EvidenceRuntime {
  controllerId: string;
  diagnostics(): unknown;
}

/** Sample only cached app state. Never enumerate Homey's cards or poll lamps
 * just because recording is enabled. Full configurations are saved on change;
 * historical buffers are excluded so the same events are not saved 60 times. */
export class EvidenceSampler {
  private readonly configurations = new Map<string, string>();
  constructor(private readonly record: EvidenceSink) {}

  sample(runtimes: Array<{ kind: string; runtime: EvidenceRuntime; configuration: unknown }>): void {
    const present = new Set<string>();
    for (const { kind, runtime, configuration } of runtimes) {
      const id = runtime.controllerId;
      present.add(id);
      const encoded = JSON.stringify(configuration);
      if (this.configurations.get(id) !== encoded) {
        this.record('configuration', { controllerId: id, kind, configuration });
        this.configurations.set(id, encoded);
      }
      const diagnostic = runtime.diagnostics() as Record<string, unknown>;
      const sample: Record<string, unknown> = { controllerId: id, kind };
      for (const key of ['name', 'state', 'stateRevision', 'enabled', 'timezone', 'localTime', 'now',
        'targetIds', 'targetNames', 'targets', 'schedulerReady', 'feedbackRisk', 'sensors',
        'lastAction', 'lastIntent', 'preStageDisabled']) {
        if (diagnostic[key] !== undefined) sample[key] = diagnostic[key];
      }
      this.record('runtime_sample', sample);
    }
    for (const id of this.configurations.keys()) {
      if (!present.has(id)) {
        this.record('runtime_removed', { controllerId: id });
        this.configurations.delete(id);
      }
    }
  }
}
