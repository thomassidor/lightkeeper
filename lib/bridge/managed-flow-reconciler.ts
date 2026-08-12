import type { HomeyApiService } from '../homey-api-service';
import type { ManagedFlowReference } from '../profiles/controller-profile';

/**
 * Spec §6.5 — reconciliation.
 *
 * Runs on app start, controller start, repair, and relevant source or
 * integration change. Verifies existence and whether each flow is broken.
 *
 * Recreate missing flows ONLY where the binding schema is still compatible. If
 * the event surface changed, invalidate the binding and require remapping
 * rather than guessing — with the one exception in §9.4.
 */

export interface ReconcileReport {
  total: number;
  present: number;
  missing: ManagedFlowReference[];
  broken: ManagedFlowReference[];
  /** Fingerprint no longer matches — must NOT be silently recreated. */
  stale: ManagedFlowReference[];
  safeToRecreate: ManagedFlowReference[];
}

export class ManagedFlowReconciler {
  constructor(private readonly api: HomeyApiService) {}

  async inspect(
    references: ManagedFlowReference[],
    currentFingerprint: string,
  ): Promise<ReconcileReport> {
    const client = await this.api.read();
    const liveFlows = await client.flow.getFlows();

    const report: ReconcileReport = {
      total: references.length,
      present: 0,
      missing: [],
      broken: [],
      stale: [],
      safeToRecreate: [],
    };

    for (const reference of references) {
      const live = liveFlows[reference.flowId];

      if (!live) {
        report.missing.push(reference);
      } else {
        report.present += 1;
        // isBroken is async and needs flow + flowtoken connected; a failure to
        // determine brokenness is not itself brokenness.
        if (await isBroken(live)) report.broken.push(reference);
      }

      const compatible = reference.fingerprint === currentFingerprint;
      if (!compatible) {
        report.stale.push(reference);
      } else if (!live || report.broken.includes(reference)) {
        report.safeToRecreate.push(reference);
      }
    }

    return report;
  }
}

/**
 * Whether Homey considers a flow broken.
 *
 * Free-standing rather than a method so it can be called against any flow
 * object, including ones read through either API client. Requires the flow and
 * flowtoken managers to be connected, or the call throws.
 */
export async function isBroken(flow: any): Promise<boolean> {
  if (!flow || typeof flow.isBroken !== 'function') return false;
  try {
    return Boolean(await flow.isBroken());
  } catch {
    // Unknown is not broken — marking a controller for repair on a transient
    // connection problem would be worse than missing one broken flow.
    return false;
  }
}
