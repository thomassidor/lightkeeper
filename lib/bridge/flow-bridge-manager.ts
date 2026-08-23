import type { HomeyApiService } from '../homey-api-service';
import { redactKeyMaterial } from '../credential-service';
import type { ManagedFlowReference } from '../profiles/controller-profile';
import {
  compileBinding,
  managedKey,
  RangeExpansionTooLargeError,
  type BridgeCardRefs,
  type CompiledFlow,
  type CompileRequest,
} from './flow-binding-compiler';
import type { LogicalSourceBinding } from '../inputs/selectable-input';

/**
 * Compiles bindings into generated flows and reconciles
 * their lifecycle.
 *
 * All writes go through the API-key client; reads use the app client. Creation
 * is idempotent, keyed on binding key plus variant key.
 */

export const MANAGED_FOLDER_NAME = 'Lightkeeper';
const MANAGED_VERSION = 1;

/**
 * The minimum this manager needs to compile one flow.
 *
 * Deliberately narrower than `SelectableInput` (which satisfies it structurally,
 * so no controller call site changed): a light schedule has no physical control,
 * no action and no magnitude, but it does have a key, a label and a binding. The
 * flow lifecycle — idempotency, attribution, user-edit detection, orphan
 * sweeping, deletion — is identical for both, and duplicating it for the second
 * device type would have been the wrong kind of symmetry.
 */
export interface BindableInput {
  key: string;
  label: string;
  binding: LogicalSourceBinding;
  /** See CompileRequest.variantKey. Only meaningful for fixed bindings. */
  variantKey?: string;
}

export interface SyncRequest {
  controllerId: string;
  sourceName: string;
  fingerprint: string;
  /** Only the inputs actually mapped — never every discovered event. */
  mapped: BindableInput[];
  existing: ManagedFlowReference[];
}

export interface SyncResult {
  references: ManagedFlowReference[];
  created: number;
  deleted: number;
  reused: number;
  /** Controls that could not be compiled, e.g. range expansion over ceiling. */
  unsupported: Array<{ bindingKey: string; reason: string }>;
  /** Flows a user has visibly edited — left alone, controller marked for repair. */
  userEdited: string[];
}

export class FlowBridgeManager {
  private cardRefs: BridgeCardRefs | null = null;
  private folderId: string | null = null;

  constructor(
    private readonly api: HomeyApiService,
    private readonly appId: string,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /**
   * Resolve this app's own bridge cards by enumeration. A card's uri
   * embeds its id and is not `homey:app:<appId>` — constructing it yields a 404
   * that reads like a permission refusal.
   */
  async bridgeCards(): Promise<BridgeCardRefs> {
    if (this.cardRefs) return this.cardRefs;

    const client = await this.api.read();
    const actions = Object.values(await client.flow.getFlowCardActions()) as any[];

    const find = (shortId: string) => {
      const wanted = `${this.appId}:${shortId}`;
      const card = actions.find(c => String(c.id ?? '') === wanted)
        ?? actions.find(c => String(c.id ?? '').endsWith(`:${shortId}`) && String(c.id).includes(this.appId));
      if (!card) {
        throw new Error(`Lightkeeper's own action card "${shortId}" is not registered on this Homey.`);
      }
      return { id: String(card.id), uri: String(card.uri) };
    };

    this.cardRefs = {
      event: find('bridge_event'),
      numeric: find('bridge_numeric_event'),
      token: find('bridge_token_event'),
    };
    return this.cardRefs;
  }

  /**
   * Bring generated flows into line with the mapped inputs. Idempotent: an
   * unchanged binding reuses its existing flow rather than recreating it.
   */
  async sync(request: SyncRequest): Promise<SyncResult> {
    const cards = await this.bridgeCards();
    const client = await this.api.read();
    const liveFlows = await client.flow.getFlows();

    const result: SyncResult = {
      references: [], created: 0, deleted: 0, reused: 0, unsupported: [], userEdited: [],
    };

    const wanted = new Map<string, { flow: CompiledFlow; bindingKey: string }>();
    for (const input of request.mapped) {
      const compileRequest: CompileRequest = {
        controllerId: request.controllerId,
        bindingKey: input.key,
        binding: input.binding,
        cards,
        label: input.label,
        sourceName: request.sourceName,
        ...(input.variantKey !== undefined ? { variantKey: input.variantKey } : {}),
      };

      try {
        for (const flow of compileBinding(compileRequest)) {
          wanted.set(managedKey(request.controllerId, input.key, flow.variantKey), {
            flow, bindingKey: input.key,
          });
        }
      } catch (error) {
        if (error instanceof RangeExpansionTooLargeError) {
          // Mark the control unsupported and log, rather than flooding the
          // user's Flow list.
          this.log(`Declining "${input.label}": ${error.message}`);
          result.unsupported.push({ bindingKey: input.key, reason: error.message });
          continue;
        }
        throw error;
      }
    }

    const existingByKey = new Map(
      request.existing.map(ref => [managedKey(request.controllerId, ref.bindingKey, ref.variantKey), ref]),
    );

    for (const [key, { flow, bindingKey }] of wanted) {
      const existing = existingByKey.get(key);
      const live = existing ? liveFlows[existing.flowId] : undefined;

      if (existing && live) {
        if (hasBeenUserEdited(live, flow)) {
          // Never overwrite a flow that appears materially user-edited.
          this.log(`Flow ${existing.flowId} looks user-edited; leaving it alone`);
          result.userEdited.push(existing.flowId);
          result.references.push(existing);
          continue;
        }
        if (existing.fingerprint === request.fingerprint) {
          result.reused += 1;
          result.references.push(existing);
          continue;
        }
      }

      // Missing, or the event surface moved under it — recreate.
      if (existing && !live) this.log(`Managed flow ${existing.flowId} has vanished; recreating`);

      const created = await this.createFlow(flow);
      result.created += 1;
      result.references.push({
        flowId: created.id,
        bindingKey,
        variantKey: flow.variantKey,
        fingerprint: request.fingerprint,
        managedVersion: MANAGED_VERSION,
        createdAt: Date.now(),
      });
    }

    // Anything we own that is no longer wanted.
    for (const [key, ref] of existingByKey) {
      if (wanted.has(key)) continue;
      if (result.references.some(r => r.flowId === ref.flowId)) continue;
      if (await this.deleteFlow(ref.flowId)) result.deleted += 1;
    }

    return result;
  }

  /**
   * Find every Flow that calls one of OUR bridge cards, grouped by the
   * controller id in its arguments. That id is what makes a flow provably ours
   * and provably attributable. Nothing else may be touched.
   */
  async findManagedFlows(): Promise<Array<{ flowId: string; name: string; controllerId: string }>> {
    const cards = await this.bridgeCards();
    const ourCardIds = new Set([cards.event.id, cards.numeric.id, cards.token.id]);

    const client = await this.api.read();
    const flows = Object.values(await client.flow.getFlows()) as any[];

    const found: Array<{ flowId: string; name: string; controllerId: string }> = [];
    for (const flow of flows) {
      for (const action of (flow.actions ?? []) as any[]) {
        if (!ourCardIds.has(String(action?.id ?? ''))) continue;
        found.push({
          flowId: flow.id,
          name: flow.name ?? '',
          controllerId: String(action?.args?.controller ?? ''),
        });
        break;
      }
    }
    return found;
  }

  /**
   * Delete generated Flows whose controller no longer exists.
   *
   * Offered from app settings rather than run automatically: a bulk delete the
   * user did not ask for is not something to do on a heuristic, and the count
   * is always shown first (see countOrphans in api.ts).
   */
  async sweepOrphans(
    liveControllerIds: Set<string>,
  ): Promise<{ deleted: number; kept: number; failed: number; refused?: string }> {
    const managed = await this.findManagedFlows();

    // With no live controllers, EVERY managed flow looks orphaned — which is
    // indistinguishable from "the runtimes have not registered yet", or from
    // every controller being temporarily unavailable. Deleting the user's whole
    // generated set on that reading is not recoverable, so refuse instead.
    if (liveControllerIds.size === 0 && managed.length > 0) {
      this.log(`Refusing to sweep ${managed.length} managed flow(s): no controllers are running`);
      return { deleted: 0, kept: managed.length, failed: 0, refused: 'no_live_controllers' };
    }

    let deleted = 0;
    let kept = 0;
    let failed = 0;

    for (const flow of managed) {
      if (flow.controllerId && liveControllerIds.has(flow.controllerId)) {
        kept += 1;
        continue;
      }
      if (await this.deleteFlow(flow.flowId)) deleted += 1;
      else failed += 1;
    }

    this.log(`Orphan sweep: ${deleted} deleted, ${kept} kept, ${failed} failed`);
    return { deleted, kept, failed };
  }

  /** Remove ONLY flows provably managed by this controller. */
  async removeAll(references: ManagedFlowReference[]): Promise<number> {
    let deleted = 0;
    for (const ref of references) {
      if (await this.deleteFlow(ref.flowId)) deleted += 1;
    }
    return deleted;
  }

  private async createFlow(flow: CompiledFlow): Promise<{ id: string }> {
    const folder = await this.ensureFolder();
    return this.api.withWriteClient(async client => client.flow.createFlow({
      flow: {
        name: flow.name,
        ...(folder ? { folder } : {}),
        enabled: true,
        trigger: flow.trigger,
        conditions: [],
        actions: flow.actions,
      },
    }));
  }

  private async deleteFlow(flowId: string): Promise<boolean> {
    try {
      await this.api.withWriteClient(async client => client.flow.deleteFlow({ id: flowId }));
      return true;
    } catch (error) {
      // A flow the user already deleted is not an error worth surfacing.
      // Redacted as well as sanitised upstream: this line goes to the app log.
      this.log(`Could not delete flow ${flowId}:`, redactKeyMaterial(String((error as Error)?.message ?? '')));
      return false;
    }
  }

  /** Keep all managed flows in a clearly named app-managed folder. */
  private async ensureFolder(): Promise<string | undefined> {
    if (this.folderId) return this.folderId;
    try {
      const client = await this.api.read();
      const folders = Object.values(await client.flow.getFlowFolders()) as any[];
      const existing = folders.find(f => f.name === MANAGED_FOLDER_NAME);
      if (existing) {
        this.folderId = existing.id;
        return existing.id;
      }
      const created = await this.api.withWriteClient(async write =>
        write.flow.createFlowFolder({ flowfolder: { name: MANAGED_FOLDER_NAME } }));
      this.folderId = created.id;
      return created.id;
    } catch (error) {
      // Folders are organisational only — never let one block the real work.
      this.log(
        'Could not create the Lightkeeper folder; continuing without it:',
        redactKeyMaterial(String((error as Error)?.message ?? '')),
      );
      return undefined;
    }
  }
}

/**
 * Never overwrite a flow that appears materially user-edited.
 *
 * "Material" means the parts we generated: the trigger, and our own bridge
 * action with its arguments. A renamed flow, or one moved to another folder or
 * given extra actions, is left alone too — the user clearly took ownership.
 */
export function hasBeenUserEdited(live: any, expected: CompiledFlow): boolean {
  if (!live) return false;

  if (String(live.trigger?.id ?? '') !== expected.trigger.id) return true;

  // The trigger's ARGUMENTS count as ours too. Without this, a schedule whose
  // time the user changed in the Flow itself read as untouched — the trigger id
  // and our action arguments were still exactly what we wrote — so the app
  // silently kept a flow that fires at a time no screen in the app admits to.
  // Only the keys we generated are compared: Homey may echo back more than it
  // was given, and a superset is not an edit.
  for (const [key, value] of Object.entries(expected.trigger.args)) {
    if (String((live.trigger?.args ?? {})[key] ?? '') !== String(value)) return true;
  }

  const liveActions = (live.actions ?? []) as any[];
  const ours = liveActions.find(a => String(a?.id ?? '') === expected.actions[0]!.id);
  if (!ours) return true;

  if (liveActions.length !== expected.actions.length) return true;

  const expectedArgs = expected.actions[0]!.args;
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (String(ours.args?.[key] ?? '') !== String(value)) return true;
  }

  if ((expected.actions[0]!.droptoken ?? null) !== (ours.droptoken ?? null)) return true;

  return false;
}
