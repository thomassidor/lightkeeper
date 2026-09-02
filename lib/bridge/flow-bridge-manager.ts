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
import { FlowFolderManager, type FlowFolderInfo } from './flow-folder-manager';
import { FlowCardCatalogue, NO_CACHE } from '../flow-card-catalogue';
import { isNotFound } from '../support/homey-errors';
import { randomUUID } from 'node:crypto';

import { KeyedMutex, SingleFlight } from '../support/keyed-mutex';

/**
 * Compiles bindings into generated flows and reconciles
 * their lifecycle.
 *
 * All writes go through the API-key client; reads use the app client. Creation
 * is idempotent, keyed on binding key plus variant key.
 *
 * Where the generated flows LIVE — one folder per device, nested under the
 * app's own — is FlowFolderManager's business, not this file's. Folders are
 * presentation: nothing here may treat one as evidence that a flow is ours.
 */

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
  /**
   * The name of the SOURCE — the remote a controller listens to. Feeds the
   * generated flow's title, and is not the same thing as `deviceName`.
   */
  sourceName: string;
  /**
   * The name of the Lightkeeper device itself, which names its flow folder.
   * For a schedule the two are the same; for a controller they are not.
   */
  deviceName: string;
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
  /**
   * Generated flows this pass wanted GONE and could not remove, so they are
   * still live and still firing.
   *
   * Two sources, and they are the same failure from either side: a replacement
   * whose old flow could not be deleted (the new one exists and is correct, but
   * the previous behaviour is still running beside it), and a binding that is no
   * longer wanted at all whose flow would not delete. `deleteFlow` reports a
   * 401, a 403 and an unreachable Homey identically — "we could not tell" — so
   * either can happen on a perfectly healthy install with a dead key.
   *
   * Not an error, and not a repair: nothing is broken and a remap would not
   * help. But it must not pass for a clean run either, so callers report it —
   * both runtimes log it and carry it in their diagnostics, which is the only
   * place a user or a bug report can see it. The abandonment case additionally
   * keeps its reference, so the next pass retries the delete.
   */
  staleReplacements: string[];
}

/** One generated flow as found on the Homey, with what it can be cleaned up by. */
export interface ManagedFlowSummary {
  flowId: string;
  name: string;
  /**
   * Which Lightkeeper device owns this flow — a controller OR a schedule.
   *
   * Named `ownerDeviceId` INTERNALLY only. The flow argument it is read from is
   * still `args.controller`, and that name is persisted in every generated Flow
   * on every installed Homey: renaming the argument would make every existing
   * flow unattributable, so the wire name stays and the boundary that reads it
   * says so (see `ownerDeviceIdOf`).
   */
  ownerDeviceId: string;
  /** Carried so a sweep can remove the device folder it empties. */
  folder: string | null;
  /**
   * Whether the flow matches the template this app generates, in full.
   *
   * Calling one of our bridge cards is enough to ATTRIBUTE a flow; it is not
   * enough to justify DELETING it. The cards are ordinary action cards in the
   * user's Flow editor, so a flow somebody built by hand around one — as a
   * shortcut to trigger their own controller from a different condition, say —
   * carries a controller id and reads as ours. The sweep deletes only flows
   * that are `true` here.
   */
  generated: boolean;
}

/**
 * The shape of a Lightkeeper device id.
 *
 * TWO shapes, and both must keep matching forever:
 *
 *  - `lk-<kind>-<uuid>` — what `mintDeviceId()` produces now;
 *  - `lk-<kind>-<timestamp>-<random>` — what earlier versions produced.
 *
 * The legacy form is not deprecated, it is PERMANENT: a device id is baked into
 * the `controller` argument of every Flow that device owns, and into the device's
 * own `data`, neither of which can be rewritten. A pattern that stopped matching
 * it would make every existing device's Flows unattributable — which the sweep
 * reads as orphaned.
 *
 * One exported constant because two things must agree on it and they live apart:
 * the drivers that mint ids, and the sweep's proof that a flow's `controller`
 * argument was written by us rather than typed in by hand. `circ` is included for
 * completeness — as is `curv` — even though neither a circadian nor a curve light
 * owns any flows. An id of either kind turning up in a flow's arguments would be
 * evidence of something we would want to SEE rather than delete.
 */
export const LIGHTKEEPER_DEVICE_ID =
  /^lk-(ctrl|sched|circ|curv)-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+-\d+)$/i;

/**
 * A new device id.
 *
 * `crypto.randomUUID()` rather than `Date.now()` plus `Math.random()`: two
 * devices created in the same millisecond had a real, if small, chance of
 * colliding, and a collision is not a cosmetic problem — the id is what
 * attributes a Flow to a device, so two devices sharing one means each can delete
 * the other's Flows.
 *
 * The prefix stays, because it is what tells a human reading a Flow's arguments
 * what they are looking at.
 */
export function mintDeviceId(kind: 'ctrl' | 'sched' | 'circ' | 'curv'): string {
  return `lk-${kind}-${randomUUID()}`;
}

/**
 * Does this flow match, in full, the template `compileBinding` produces?
 *
 * Four things, and all four must hold:
 *
 *   - exactly ONE action. Every generated flow has one; a user who added a
 *     second has made it theirs, and `hasBeenUserEdited` agrees.
 *   - that action is one of our three bridge cards.
 *   - its `controller` argument is a well-formed Lightkeeper device id. This
 *     is the load-bearing one: it is what separates an id we minted from
 *     anything a person could type into the argument field.
 *   - its `event_key` argument is non-empty. A generated flow always carries
 *     one; the dispatcher refuses an event without it, so a flow that has none
 *     could never have been ours.
 *
 * Deliberately says nothing about the TRIGGER. A re-attach repoints a flow's
 * trigger at a new device and the flow stays ours; requiring a particular
 * trigger would make every re-attached flow unmanaged and undeletable.
 */
export function looksGenerated(flow: any, cardIds: Set<string>): boolean {
  const actions = (flow?.actions ?? []) as any[];
  if (actions.length !== 1) return false;

  const action = actions[0];
  if (!cardIds.has(String(action?.id ?? ''))) return false;

  const controller = String(action?.args?.controller ?? '');
  if (!LIGHTKEEPER_DEVICE_ID.test(controller)) return false;

  return String(action?.args?.event_key ?? '') !== '';
}

/** What countOrphans reports, and what a sweep must be handed back. */
export interface OrphanPreview {
  total: number;
  orphans: number;
  /** Attributed to a dead device but NOT matching our template. Never deleted. */
  unmanaged: number;
  /**
   * How many Lightkeeper devices that can own a Flow are live — controllers AND
   * schedules. The KEY keeps its old name because the settings page consumes it;
   * see `liveDeviceIds` in api.ts for why the union is load-bearing.
   */
  liveControllers: number;
  /** The exact candidates. Handed back to sweepOrphans as the approval. */
  flowIds: string[];
  examples: string[];
  /** Pins (candidates, live set). A sweep with a stale one is refused. */
  token: string;
  refused?: string;
}

export interface SweepResult {
  deleted: number;
  kept: number;
  failed: number;
  /** Counted inside `kept`: found, attributed, deliberately left alone. */
  unmanaged: number;
  refused?: string;
}

export class FlowBridgeManager {
  private cardRefs: BridgeCardRefs | null = null;
  private readonly folders: FlowFolderManager;

  /**
   * App-wide, one instance, deliberately owned here.
   *
   * There is one FlowBridgeManager per app and every runtime shares it, so
   * this is the only place a folder lock can be app-wide — which is the only
   * width at which it serialises anything. See FlowFolderManager.
   */
  private readonly folderMutex = new KeyedMutex();

  /**
   * One reconciliation per device at a time, latest state wins.
   *
   * Shared here rather than held per runtime for the same reason: `sync()` is
   * the thing being serialised, and it lives here. Runtimes route their
   * reconcile through `reconcile()` below.
   */
  private readonly reconciles = new SingleFlight();

  private readonly cards: FlowCardCatalogue;

  /**
   * `cards` is optional so the app can hand in the ONE catalogue it shares with
   * source discovery (platform §15), while every test and every ephemeral rig
   * still builds a manager from an api, an app id and a log.
   */
  constructor(
    private readonly api: HomeyApiService,
    private readonly appId: string,
    private readonly log: (...args: unknown[]) => void,
    cards?: FlowCardCatalogue,
  ) {
    this.folders = new FlowFolderManager(api, log, this.folderMutex);
    this.cards = cards ?? new FlowCardCatalogue(api);
  }

  /**
   * Run one device's reconciliation, coalescing overlapping requests.
   *
   * Three things kick a reconcile off and at boot they all happen at once: the
   * runtime starting, the catalogue settling, and the credential status
   * flipping to valid — which the reconcile's own first write is what causes.
   * Two passes for one device then interleave over the same stored references,
   * and both create: the loser's flows are live with nothing pointing at them.
   *
   * Coalescing, not sharing (see SingleFlight): a request that arrives
   * mid-pass exists because the desired state just changed, so it must be
   * answered by a pass that reads the NEW state, never by the in-flight one's
   * result.
   */
  async reconcile<T>(deviceId: string, pass: () => Promise<T>): Promise<T> {
    return this.reconciles.coalesce(deviceId, pass);
  }

  /**
   * Resolve this app's own bridge cards by enumeration. A card's uri
   * embeds its id and is not `homey:app:<appId>` — constructing it yields a 404
   * that reads like a permission refusal.
   */
  async bridgeCards(): Promise<BridgeCardRefs> {
    if (this.cardRefs) return this.cardRefs;

    const wanted = ['bridge_event', 'bridge_numeric_event', 'bridge_token_event'] as const;

    /**
     * Ask for the three by name first. Reading the whole action catalogue to
     * find three cards is ~12 MB of allocation the app never gets back
     * (platform §15), and it is the only reason this method was expensive.
     */
    const ownerUri = `homey:app:${this.appId}`;
    const direct = await Promise.all(wanted.map(name => this.cards.actionCardRef(ownerUri, name)));

    if (direct.every((ref): ref is { id: string; uri: string } => ref !== null)) {
      this.cardRefs = { event: direct[0]!, numeric: direct[1]!, token: direct[2]! };
      return this.cardRefs;
    }

    /**
     * The FALLBACK, and the reason the direct path is allowed to be optimistic.
     *
     * Enumerate and echo — platform §3's rule, and what this method used to do
     * unconditionally. It costs the full catalogue read, which is why it is no
     * longer the first thing tried, but it is the path that still answers when
     * the direct lookup cannot: a card id shaped differently from what we
     * expect, or a Homey that answers the collection and not the item.
     */
    this.log('Falling back to enumerating every action card to find our own');
    const actions = await this.cards.actionCardRefs();

    const find = (shortId: string) => {
      const exact = `${this.appId}:${shortId}`;
      const card = actions.find(c => c.id === exact)
        ?? actions.find(c => c.id.endsWith(`:${shortId}`) && c.id.includes(this.appId));
      if (!card) {
        throw new Error(`Lightkeeper's own action card "${shortId}" is not registered on this Homey.`);
      }
      return { id: card.id, uri: card.uri };
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
    // The reads come first and they are the ones that can fail on a dead socket
    // rather than a dead key. Reported, so the next pass rebuilds the client
    // instead of every reconcile for the rest of the app run failing the same
    // way and reading as a credential problem.
    let liveFlows: Record<string, any>;
    try {
      const client = await this.api.read();
      liveFlows = await client.flow.getFlows(NO_CACHE);
    } catch (error) {
      this.api.reportReadFailure(error);
      throw error;
    }

    // One folder read per reconcile, alongside the flow read that already
    // happens. Deliberately not cached across reconciles: a folder the user
    // deleted in the meantime would otherwise be written to forever.
    const view = await this.folders.load();
    const flowInfos = flowFolderInfos(Object.values(liveFlows) as any[], ourCardIds(cards));

    /**
     * A pass that wants NO flows must not create a folder to put them in.
     *
     * `resolveForDevice` creates the device folder when it cannot find one,
     * which is right for every pass that is about to write something and wrong
     * for the one that is about to delete everything — it would make an empty
     * folder immediately before `cleanUpEmpty` had to remove it, and on a
     * Homey that refuses folder writes it would log a failure about a folder
     * nothing needed. Cleanup still works: the per-flow folder ids come from
     * `flowInfos`, which is read either way.
     */
    const folder = request.mapped.length === 0
      ? undefined
      : await this.folders.resolveForDevice(
        view, flowInfos, request.controllerId, request.deviceName,
      );
    if (folder) {
      await this.folders.renameIfOurs(
        view, flowInfos, folder, request.controllerId, request.deviceName,
      );
    }

    const result: SyncResult = {
      references: [], created: 0, deleted: 0, reused: 0, unsupported: [], userEdited: [],
      staleReplacements: [],
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

    const abandoned = new Set<string>();

    /**
     * Every flow THIS pass created, in creation order.
     *
     * The journal is what makes a half-finished pass recoverable. `sync()`
     * creates sequentially, and a failure part-way through used to throw the
     * result away — so the flows created before it stayed live with nothing
     * referencing them, and the next retry created a second set beside them.
     * Duplicated automation, invisible from every screen in the app.
     *
     * Only CREATIONS go in. A reused flow existed before this pass and is not
     * this pass's to remove.
     */
    const createdThisPass: string[] = [];

    try {
      for (const [key, { flow, bindingKey }] of wanted) {
        const existing = existingByKey.get(key);
        const live = existing ? liveFlows[existing.flowId] : undefined;
        let supersedes: ManagedFlowReference | null = null;

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
          // Same key, different fingerprint: the flow we are about to create
          // REPLACES this one. Remembered rather than deleted first, so a
          // failed create cannot leave the binding with no flow at all.
          supersedes = existing;
        }

        // Missing, or the event surface moved under it — recreate.
        if (existing && !live) this.log(`Managed flow ${existing.flowId} has vanished; recreating`);

        const created = await this.createFlow(flow, folder);
        createdThisPass.push(created.id);
        result.created += 1;
        result.references.push({
          flowId: created.id,
          bindingKey,
          variantKey: flow.variantKey,
          fingerprint: request.fingerprint,
          managedVersion: MANAGED_VERSION,
          createdAt: Date.now(),
        });

        if (supersedes) {
          /**
           * The old flow, deleted EXPLICITLY.
           *
           * It used to be left live: the abandonment loop below skips any key
           * that is still wanted, and this key is, so nothing removed it —
           * while its reference was overwritten by the new one above. A
           * schedule retimed from 22:00 to 23:00 therefore kept firing at
           * 22:00 as well, with no screen in the app admitting the old flow
           * existed.
           */
          const superseded: ManagedFlowReference = supersedes;
          const folderOf = flowInfos.find(f => f.id === superseded.flowId)?.folder;
          if (await this.deleteFlow(superseded.flowId)) {
            result.deleted += 1;
            if (folderOf) abandoned.add(folderOf);
          } else {
            // Both are live now. Name both ids: the user has to be able to
            // find the stale one, and the new one is what tells them which.
            this.log(
              `Replaced flow ${superseded.flowId} with ${created.id}, but could not delete the old one — `
              + 'it is still live and still firing',
            );
            result.staleReplacements.push(superseded.flowId);
          }
        }
      }

      // Anything we own that is no longer wanted.
      for (const [key, ref] of existingByKey) {
        if (wanted.has(key)) continue;
        if (result.references.some(r => r.flowId === ref.flowId)) continue;
        const folderOf = flowInfos.find(f => f.id === ref.flowId)?.folder;
        if (await this.deleteFlow(ref.flowId)) {
          result.deleted += 1;
          if (folderOf) abandoned.add(folderOf);
        } else {
          /**
           * A delete we could not make stick, KEPT rather than forgotten.
           *
           * `deleteFlow` returns false for a 401, a 403 and an unreachable
           * Homey alike — all of which mean "we could not tell", never "it is
           * gone". Dropping the reference here made the flow unreachable by
           * every other path in the app: it is still live, still calls our
           * bridge card, and its `controller` argument still names a device
           * that IS live, so the orphan sweep does not see an orphan and never
           * will. A row in the user's Flow list, forever, that nothing in this
           * app admits to owning.
           *
           * So the reference survives — the next reconcile finds it un-wanted
           * again and retries the delete — and the id is reported alongside the
           * supersede path's own undeletable flows, which is the same failure
           * from the other direction.
           */
          result.references.push(ref);
          result.staleReplacements.push(ref.flowId);
          this.log(
            `Could not delete flow ${ref.flowId}, which is no longer wanted — `
            + 'keeping its reference so the next pass tries again',
          );
        }
      }

      // Flows that were reused rather than created still carry whatever folder
      // they were made with — which, on an install that predates per-device
      // folders, is the flat app folder. Move them; a flow the user filed
      // somewhere of their own is left where they put it.
      if (folder) {
        // A flow we decided not to touch is not touched, filing included.
        const edited = new Set(result.userEdited);
        await this.folders.placeExisting(
          view,
          flowInfos,
          new Set(result.references.map(r => r.flowId).filter(id => !edited.has(id))),
          folder,
        );
      }
    } catch (error) {
      // Compensate: this pass's creations are unreferenced the moment we
      // rethrow, so remove them. Deletes are idempotent (see deleteFlow), which
      // is what makes a retry after a partial compensation safe too.
      await this.compensate(createdThisPass);
      throw error;
    }

    // A binding that lost its last flow can empty a folder — a remote swapped
    // for one with fewer buttons, say. Never the device's current folder.
    abandoned.delete(folder ?? '');
    await this.folders.cleanUpEmpty(view, abandoned);

    return result;
  }

  /**
   * Best-effort removal of flows a failed pass created.
   *
   * Never throws: the caller is already rethrowing the failure that caused
   * this, and that failure is the one the user needs to see. What cannot be
   * removed is named in the log, because it is now a live flow nothing
   * references — the one case where the app genuinely has left something
   * behind and the user has to be able to find it.
   */
  private async compensate(flowIds: string[]): Promise<void> {
    if (flowIds.length === 0) return;
    const leftBehind: string[] = [];
    for (const flowId of flowIds) {
      try {
        if (!await this.deleteFlow(flowId)) leftBehind.push(flowId);
      } catch {
        leftBehind.push(flowId);
      }
    }
    if (leftBehind.length > 0) {
      this.log(
        `A failed reconcile left ${leftBehind.length} flow(s) behind that could not be removed: `
        + leftBehind.join(', '),
      );
    } else {
      this.log(`Rolled back ${flowIds.length} flow(s) created by a reconcile that failed`);
    }
  }

  /**
   * Find every Flow that calls one of OUR bridge cards, grouped by the
   * controller id in its arguments. That id is what makes a flow provably ours
   * and provably attributable. Nothing else may be touched.
   */
  async findManagedFlows(): Promise<ManagedFlowSummary[]> {
    const cards = await this.bridgeCards();
    const ids = ourCardIds(cards);

    const client = await this.api.read();
    const flows = Object.values(await client.flow.getFlows(NO_CACHE)) as any[];

    const found: ManagedFlowSummary[] = [];
    for (const flow of flows) {
      const ownerDeviceId = ownerDeviceIdOf(flow, ids);
      if (ownerDeviceId === null) continue;
      found.push({
        flowId: String(flow.id),
        name: flow.name ?? '',
        ownerDeviceId,
        folder: flow.folder ?? null,
        generated: looksGenerated(flow, ids),
      });
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
  /**
   * The candidates a sweep would delete, with a token that pins them.
   *
   * The preview and the delete are two round trips with a person in between,
   * so the set can move underneath: a device finishes registering, a repair
   * completes, the user deletes another controller. The token is a hash of
   * exactly what the preview was computed from, and `sweepOrphans` refuses a
   * request carrying a stale one — the user approved a count, and a count that
   * has changed is not the one they approved.
   */
  async countOrphans(liveDeviceIds: Set<string>): Promise<OrphanPreview> {
    const managed = await this.findManagedFlows();
    const orphans = orphansAmong(managed, liveDeviceIds);
    const unmanaged = managed.filter(flow => !flow.generated).length;

    return {
      total: managed.length,
      orphans: orphans.length,
      unmanaged,
      liveControllers: liveDeviceIds.size,
      flowIds: orphans.map(flow => flow.flowId),
      examples: orphans.slice(0, 5).map(flow => flow.name),
      token: previewToken(orphans.map(flow => flow.flowId), liveDeviceIds),
      ...(liveDeviceIds.size === 0 && managed.length > 0 ? { refused: 'no_live_controllers' } : {}),
    };
  }

  /**
   * Delete generated Flows whose device no longer exists.
   *
   * Offered from app settings rather than run automatically: a bulk delete the
   * user did not ask for is not something to do on a heuristic, and the count
   * is always shown first (countOrphans above).
   *
   * Three refusals, each of which used to be a way to delete something the
   * user owns:
   *
   *  1. No live device at all — every managed flow then LOOKS orphaned, which
   *     is indistinguishable from "the runtimes have not registered yet".
   *  2. A stale preview token — the set moved between the count and the click.
   *  3. A flow that does not match the generated template — see looksGenerated.
   *     Those are reported as `unmanaged`: found, attributed, left alone.
   */
  async sweepOrphans(
    liveDeviceIds: Set<string>,
    approved?: { token: string; flowIds: string[] },
  ): Promise<SweepResult> {
    const managed = await this.findManagedFlows();
    const orphans = orphansAmong(managed, liveDeviceIds);

    if (liveDeviceIds.size === 0 && managed.length > 0) {
      this.log(`Refusing to sweep ${managed.length} managed flow(s): no devices are running`);
      return {
        deleted: 0, kept: managed.length, failed: 0, unmanaged: 0,
        refused: 'no_live_controllers',
      };
    }

    if (approved) {
      const current = previewToken(orphans.map(flow => flow.flowId), liveDeviceIds);
      if (current !== approved.token) {
        this.log('Refusing to sweep: the set of orphans changed since it was shown');
        return {
          deleted: 0, kept: managed.length, failed: 0, unmanaged: 0,
          refused: 'stale_preview',
        };
      }
    }

    // Only ids that are BOTH approved and still orphaned. The intersection is
    // belt and braces behind the token — the token proves the set is
    // unchanged, this makes an id that was never shown undeleteable regardless.
    const approvedIds = approved ? new Set(approved.flowIds) : null;

    let deleted = 0;
    let kept = 0;
    let failed = 0;
    let unmanaged = 0;
    const emptied = new Set<string>();

    for (const flow of managed) {
      if (flow.ownerDeviceId && liveDeviceIds.has(flow.ownerDeviceId)) {
        kept += 1;
        continue;
      }
      if (!flow.generated) {
        // Attributed to a device that is gone, but not something we made.
        // Reported, never deleted.
        unmanaged += 1;
        kept += 1;
        continue;
      }
      if (approvedIds && !approvedIds.has(flow.flowId)) {
        kept += 1;
        continue;
      }
      if (await this.deleteFlow(flow.flowId)) {
        deleted += 1;
        if (flow.folder) emptied.add(flow.folder);
      } else failed += 1;
    }

    if (deleted > 0) await this.folders.cleanUpEmpty(await this.folders.load(), emptied);

    this.log(
      `Orphan sweep: ${deleted} deleted, ${kept} kept, ${failed} failed`
      + (unmanaged > 0 ? `, ${unmanaged} left alone (not generated by this app)` : ''),
    );
    return { deleted, kept, failed, unmanaged };
  }

  /**
   * Remove ONLY flows provably managed by this controller, and the device
   * folder they leave behind.
   *
   * The folders are read BEFORE the deletes, because afterwards the flows that
   * knew which folder they were in are gone.
   */
  async removeAll(references: ManagedFlowReference[]): Promise<number> {
    const emptied = new Set<string>();
    try {
      const client = await this.api.read();
      const live = (await client.flow.getFlows(NO_CACHE)) as Record<string, any>;
      for (const ref of references) {
        const folder = live[ref.flowId]?.folder;
        if (folder) emptied.add(String(folder));
      }
    } catch (error) {
      // Losing the folder names only means an empty folder is left behind.
      this.log('Could not read flow folders before deleting:',
        redactKeyMaterial(String((error as Error)?.message ?? '')));
    }

    let deleted = 0;
    for (const ref of references) {
      if (await this.deleteFlow(ref.flowId)) deleted += 1;
    }

    if (deleted > 0) await this.folders.cleanUpEmpty(await this.folders.load(), emptied);
    return deleted;
  }

  private async createFlow(flow: CompiledFlow, folder: string | undefined): Promise<{ id: string }> {
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

  /**
   * Delete a flow, idempotently.
   *
   * `true` means the flow is GONE, not that a delete call succeeded — so a
   * flow the user already removed by hand counts as success, because the
   * desired end state holds. It used to return `false` there, and every caller
   * counts that as a failure: a user who tidied up their Flow list before
   * deleting the device saw "12 flows could not be removed" and went looking
   * for a broken API key.
   *
   * Everything else stays `false`. A 401, a 403 or an unreachable Homey all
   * mean "we could not tell", and reading "could not tell" as "it is gone" is
   * how a reference is dropped while the Flow it names goes on firing.
   */
  private async deleteFlow(flowId: string): Promise<boolean> {
    try {
      await this.api.withWriteClient(async client => client.flow.deleteFlow({ id: flowId }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      // Redacted as well as sanitised upstream: this line goes to the app log.
      this.log(`Could not delete flow ${flowId}:`, redactKeyMaterial(String((error as Error)?.message ?? '')));
      return false;
    }
  }

}

/**
 * The orphans among a set of managed flows: attributed to a device that is not
 * live. Used by BOTH the preview and the sweep, so the two can never disagree
 * about what an orphan is.
 */
function orphansAmong(
  managed: ManagedFlowSummary[],
  liveDeviceIds: Set<string>,
): ManagedFlowSummary[] {
  return managed.filter(flow =>
    flow.generated && (!flow.ownerDeviceId || !liveDeviceIds.has(flow.ownerDeviceId)));
}

/**
 * A stable fingerprint of "these candidates, against this live set".
 *
 * Both halves matter. The candidate ids catch a flow appearing or vanishing;
 * the live set catches the case the ids alone would miss — a device finishing
 * its registration between the count and the click leaves the SAME orphan ids
 * (its own flows were never in the list) while changing what the user is
 * actually approving.
 *
 * Not a cryptographic hash: this defends against a set that moved, not against
 * a person constructing a collision. There is no attacker here — the same user
 * is on both ends of the round trip.
 */
function previewToken(flowIds: string[], liveDeviceIds: Set<string>): string {
  const canonical = [
    [...flowIds].sort().join(','),
    [...liveDeviceIds].sort().join(','),
  ].join('|');

  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0;
  }
  return `${flowIds.length}-${liveDeviceIds.size}-${hash.toString(36)}`;
}

function ourCardIds(cards: BridgeCardRefs): Set<string> {
  return new Set([cards.event.id, cards.numeric.id, cards.token.id]);
}

/**
 * The controller id a flow is attributed to, or null when the flow is not ours.
 *
 * That id — carried in our own bridge action's arguments — is the ONLY thing
 * that makes a flow provably ours. Not its name, and emphatically not its
 * folder: the user may move a generated flow anywhere.
 */
function ownerDeviceIdOf(flow: any, cardIds: Set<string>): string | null {
  for (const action of (flow?.actions ?? []) as any[]) {
    if (!cardIds.has(String(action?.id ?? ''))) continue;
    return String(action?.args?.controller ?? '');
  }
  return null;
}

/** Every live flow reduced to what folder decisions need. */
function flowFolderInfos(flows: any[], cardIds: Set<string>): FlowFolderInfo[] {
  return flows.map(flow => ({
    id: String(flow?.id ?? ''),
    folder: flow?.folder ?? null,
    ownerDeviceId: ownerDeviceIdOf(flow, cardIds) ?? '',
  }));
}

/**
 * Never overwrite a flow that appears materially user-edited.
 *
 * "Material" means the parts we generated: the trigger, our own bridge action
 * with its arguments, and the two things we always generate the same way —
 * `enabled: true` and `conditions: []`. A flow given extra actions counts as
 * edited; so does one switched off, and one given a condition.
 *
 * A flow the user merely RENAMED or MOVED does not: neither is compared here,
 * so such a flow is reused in place. That is deliberate and now load-bearing —
 * it is what lets placeExisting() distinguish "still where we left it" from
 * "the user filed this somewhere", and it is why a rename never drags a flow
 * back into our folder.
 */
export function hasBeenUserEdited(live: any, expected: CompiledFlow): boolean {
  if (!live) return false;

  /**
   * A DISABLED flow is an edit, and one of the clearest there is.
   *
   * Every flow we create is created enabled and nothing here ever disables
   * one, so `enabled: false` can only have come from a person switching it off
   * in the Flow editor — which is exactly how somebody says "not this one" for
   * a gesture they do not want. Reconciliation used to read it as untouched
   * and reuse it, so the mapping stayed in the app while the flow stayed off:
   * a gesture the app said was configured and that did nothing at all, which
   * is the precise failure this app exists to prevent.
   *
   * Explicitly `=== false`: Homey may omit the field, and an absent one is not
   * a disabled flow.
   */
  if (live.enabled === false) return true;

  /**
   * A CONDITION is an edit too.
   *
   * We generate `conditions: []` — always, for every flow. A condition is
   * therefore something the user added, and it is the most common
   * customisation there is: "only when I'm home", "only after sunset". Reusing
   * such a flow is harmless the first time and destroys their work the moment
   * the binding changes and the flow is replaced.
   */
  if (((live.conditions ?? []) as unknown[]).length > 0) return true;

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
