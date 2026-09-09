import type { EvidenceSink } from './evidence-sink';

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
