import type { HomeyApiService } from '../homey-api-service';
import { classifyReconcileError } from '../runtime/reconcile-failure';
import type { CredentialStatus } from '../credential-service';
import type { DeviceCatalog } from '../device-catalog';
import type { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import { CommandScheduler } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type PlannedWrite } from '../outputs/intent-planner';
import { toDevice } from '../outputs/light-intent';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { sameDetail } from '../profiles/controller-profile';
import { assessTargets } from '../runtime/target-health';
import {
  diffTargets, releaseTarget, resolveSnapshot, type TargetSnapshot,
} from '../outputs/target-snapshot';
import { describeClock, localNowResolved, type LocalClock } from '../time/local-clock';
import { bindingsForPlan, eventKeyFor, parseEventKey } from './schedule-bindings';
import {
  activeEntries, activeWindowStartDay, boundaryDayMatches, offMinuteOf,
} from './schedule-window';
import type { TimeCardDiscovery } from './time-card-discovery';
import { fireAndForget } from '../support/async';
import { sameManagedFlows } from '../support/same';
import { BoundedLog } from '../support/bounded-log';
import {
  formatMinutes,
  type ScheduleBoundary,
  type ScheduleEntry,
  type SchedulePlan,
} from './schedule-types';

/**
 * One light schedule, live.
 *
 * There is deliberately NO timer in here. The generated Flows are the clock: the
 * Homey's own Flow engine fires them, which means DST, clock changes, restarts
 * and re-arming are all its problem rather than ours, and a schedule is
 * inspectable in the Flow list like everything else this app builds. What the
 * runtime owns is the half a Flow cannot express — whether today is one of this
 * schedule's days, whether it is paused, and what "on" means for lights that may
 * not all support dimming.
 *
 * Everything reached from here is shared with the remote controller: the same
 * target resolver, capability cache, write planner and write queue.
 */

export interface ScheduleRuntimeDeps {
  /**
   * One app-wide log of every write attempted by ANY runtime.
   *
   * Optional so the pairing screen's ephemeral rigs (which have no app) still
   * work unchanged. Its consumer is the settings page: "did anything reach a
   * light" is a question about the whole Homey, and answering it from the
   * FIRST controller's log — which is what api.ts did — made it permanently
   * empty for a household that runs only schedules, and permanently
   * misleading for one that runs both.
   */
  onWriteResult?: (entry: WriteRecord) => void;
  api: HomeyApiService;
  catalog: DeviceCatalog;
  bridge: FlowBridgeManager;
  /** Memoised by the manager: one enumeration per app run, not per schedule. */
  timeCard: () => Promise<TimeCardDiscovery>;
  /** The Homey's IANA timezone, or undefined to fall back to process-local. */
  timezone: () => string | undefined;
  /** The device's name, which appears in the generated Flows' titles. */
  displayName: () => string;
  now?: () => number;
  log: (...args: unknown[]) => void;
  onStateChange: (state: ControllerState, detail?: StateDetail) => void;
  /**
   * Separate from onStateChange for the same reason the controller keeps them
   * apart: reconciliation can learn new managed-flow references while the state
   * never changes, and unpersisted references leak Flows on every restart.
   */
  onPlanChange: (plan: SchedulePlan) => Promise<void>;
}

export interface ScheduleAction {
  at: number;
  entryId: string;
  boundary: ScheduleBoundary;
  writes: number;
  skipped: number;
  note?: string;
}

/**
 * What `diagnostics()` returns. See ControllerDiagnostics for why it is typed.
 *
 * Carries no key material — the export is meant to be attached to a bug report —
 * and deliberately DOES carry device and zone names: a schedule quietly pointed
 * at the wrong room looks identical to a broken one.
 */
export interface ScheduleDiagnostics {
  controllerId: string;
  kind: 'schedule';
  name: string;
  state: ControllerState;
  enabled: boolean;
  /** The Homey's own clock, echoed back. "It fired an hour late" is usually this. */
  timezone: string;
  /**
   * Whether that zone was actually USED. A named zone the ICU build cannot
   * resolve falls back silently, and this device type refuses to fire on a clock
   * it does not trust — so the flag is the first thing to read.
   */
  timezoneResolved: boolean;
  localTime: string;
  entries: Array<{
    id: string;
    on: string;
    off: string;
    days: readonly number[] | 'every day';
    brightness?: number;
    temperature?: number;
    active: boolean;
    /**
     * How the window's end was actually SET, not only where it lands.
     *
     * `off` is computed, so "until 22:00" and "for two hours from 20:00" render
     * identically — and they are not the same thing to the person who typed one
     * of them. A bug report about a window ending at the wrong time reads very
     * differently depending on which it was.
     *
     * It is also what makes the plan round-trippable: anything that reads a
     * schedule and writes it back — `scripts/verify-hardware.mjs schedule` puts
     * a household's real windows back after retiming them — would otherwise
     * have to guess, and would quietly rewrite every duration as a time.
     */
    end: ScheduleEntry['end'];
  }>;
  targetIds: string[];
  targetNames: string[];
  managedFlows: SchedulePlan['managedFlows'];
  lastAction: ScheduleAction | null;
  lastRejection: { at: number; eventKey: string; reason: string } | null;
  /**
   * Catch-ups this runtime declined, and why. Catch-up is the one path that
   * switches lights on without a Flow having fired, so its refusals are what a
   * "why did nothing happen at 22:01" report needs.
   */
  catchUpRefusals: readonly { at: number; entryId: string; reason: string }[];
  unsupported: Array<{ bindingKey: string; reason: string }>;
  /**
   * Generated Flows this device wanted removed and could not remove, from the
   * last reconcile — so they are still live and still firing.
   *
   * Empty on a healthy device. Non-empty is the ONLY place this is visible from
   * outside the app log: `SyncResult.staleReplacements` says callers must
   * surface it rather than proceed as though the pass were clean, and both
   * runtimes only logged it — so a bug-report export could not show a schedule
   * that had started firing at two times. Same reasoning as `unsupported`
   * directly above.
   */
  staleReplacements: string[];
  /** See ControllerDiagnostics.stateRevision. */
  stateRevision: number;
  recentFailures: readonly unknown[];
  recentWrites: readonly WriteRecord[];
  schedulerReady: boolean;
  credential: CredentialStatus;
}

export class ScheduleRuntime {
  private readonly cache = new TargetStateCache();
  private readonly adapter: LightTargetAdapter;
  private readonly resolver: TargetResolver;
  private scheduler: CommandScheduler | null = null;
  private targetIds: string[] = [];
  private targetNames: string[] = [];
  private state: ControllerState = 'disabled';
  private lastAction: ScheduleAction | null = null;
  private lastRejection: { at: number; eventKey: string; reason: string } | null = null;
  /**
   * Whether the last reconciliation left the Flows in a state worth trusting.
   *
   * assessHealth() only knows about targets, so without this it cheerfully
   * reported 'ready' straight over the top of a "no time trigger card on this
   * Homey" or a dead-key verdict that reconciliation had just set — the schedule
   * looked healthy and never fired. Same reasoning as the controller runtime's
   * refusal to let a health check declare a failed runtime ready.
   */
  private flowsHealthy = true;
  /**
   * Catch-ups this runtime declined, and why.
   *
   * Catch-up is the one path that switches lights ON without a Flow having
   * fired, so its refusals are the ones a "why did nothing happen at 22:01"
   * report needs — and a refusal that is only logged is invisible from the
   * settings page. Ten is plenty: they arrive at start and on resume, not
   * continuously.
   */
  private readonly catchUpRefusals = new BoundedLog<{ at: number; entryId: string; reason: string }>(10);

  constructor(
    readonly controllerId: string,
    private plan: SchedulePlan,
    private readonly deps: ScheduleRuntimeDeps,
  ) {
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    if (deps.onWriteResult) this.adapter.setWriteSink(deps.onWriteResult);
    this.resolver = new TargetResolver(deps.catalog);
  }

  get currentState(): ControllerState { return this.state; }
  /** The reason for that state, so the device layer can report it verbatim. */
  get currentDetail(): StateDetail | undefined { return this.lastDetail; }
  get currentPlan(): SchedulePlan { return this.plan; }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * The Homey's wall clock, and whether it really is the Homey's.
   *
   * A schedule's generated Flows fire on the Homey's clock. Validating their day
   * against a DIFFERENT clock is only harmless in the middle of the day: around
   * midnight the two disagree about which day it is, and the refusal that
   * follows means a window that simply never happens. So an unresolved timezone
   * blocks this device type, while a circadian light degrades on the same
   * fallback quite happily (platform §12).
   */
  private clock(): { clock: LocalClock; resolved: boolean } {
    return localNowResolved(this.deps.timezone(), this.now());
  }

  async start(): Promise<void> {
    await this.buildRuntime();
    // Reconciled even while paused: pausing is "do not act", not "throw the
    // Flows away". Deleting and recreating two Flows per schedule on every pause
    // would churn the user's Flow list and lose any folder they moved them to.
    await this.reconcileFlows();
    await this.assessHealth();
    await this.catchUp();
  }

  /** Targets, capability cache and write queue. No flows, for the Test control. */
  async startWithoutFlows(): Promise<void> {
    await this.buildRuntime();
  }

  private async buildRuntime(): Promise<void> {
    /**
     * `resolveSnapshot`, and the snapshot is RECORDED here.
     *
     * It used to be written only by `refreshTargets()`, which meant the field
     * did not mean what its own doc says. Two consequences: the first catalogue
     * change of a runtime's life diffed against `null`, so `removed` was empty
     * and a light that had just left the plan kept its capability subscription
     * and its cache state — the acceptance bar for that work is that switching
     * such a light on produces ZERO writes. And after `stop()`/`start()` the
     * field described the PREVIOUS plan's targets.
     */
    const resolved = await resolveSnapshot(this.resolver, this.plan.target);
    this.snapshot = resolved;
    this.targetIds = resolved.ids;
    this.targetNames = resolved.names;
    this.resolver.primeCache(resolved.devices, this.cache);

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: DEFAULT_BEHAVIOR.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, (error as Error)?.message),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, options));
  }

  /**
   * Two generated Flows per schedule, reconciled through exactly the same path a
   * remote's Flows take.
   *
   * The fingerprint is the time card's own identity: if a firmware update moves
   * the card, every schedule Flow is rebuilt against the new one instead of
   * silently pointing at a card that no longer exists.
   */
  async reconcileFlows(): Promise<void> {
    // Single-flighted per device through the bridge — see the controller
    // runtime for the boot storm this converges.
    return this.deps.bridge.reconcile(this.controllerId, () => this.reconcileFlowsNow());
  }

  private async reconcileFlowsNow(): Promise<void> {
    // Nothing scheduled AND nothing stored — see controller-runtime for why
    // the second half of that is not optional. A schedule emptied of every
    // window otherwise kept its Flows, and went on switching the lights at
    // times no screen in the app showed any more.
    if (this.plan.entries.length === 0 && this.plan.managedFlows.length === 0) return;

    try {
      this.flowsHealthy = true;

      const { card, candidates } = await this.deps.timeCard();
      if (!card) {
        this.flowsHealthy = false;
        this.deps.log(
          'No usable time trigger card on this Homey. Candidates seen:',
          candidates.map(c => `${c.id} (${c.args})`).join(' | ') || 'none',
        );
        this.setState('needs_repair', { key: 'state.noTimeCard' });
        return;
      }

      const result = await this.deps.bridge.sync({
        controllerId: this.controllerId,
        sourceName: this.deps.displayName(),
        deviceName: this.deps.displayName(),
        fingerprint: `time:${card.id}:${card.argument}`,
        mapped: bindingsForPlan(this.plan.entries, card),
        existing: this.plan.managedFlows,
      });

      const changed = !sameManagedFlows(this.plan.managedFlows, result.references);
      this.plan = { ...this.plan, managedFlows: result.references };
      // Persisting unconditionally emits device.update, which invalidates the
      // catalog, which lands back in onCatalogChange — the loop the controller
      // runtime documents at the same spot.
      //
      // AWAITED: references that never reached the store describe Flows nothing
      // will find after a restart, and this device's Flows are the only thing
      // that makes it fire at all. `flowsHealthy` false is what stops
      // assessHealth() reporting 'ready' over the top of it.
      let persistFailed = false;
      if (changed) {
        try {
          await this.deps.onPlanChange(this.plan);
        } catch (error) {
          persistFailed = true;
          this.flowsHealthy = false;
          this.deps.log('Could not persist managed Flow references:', (error as Error)?.message);
        }
      }

      if (result.userEdited.length > 0) {
        this.flowsHealthy = false;
        this.setState('needs_repair', { key: 'state.flowEdited' });
      }

      // A boundary the compiler declined. Vanishingly unlikely for a schedule
      // — its bindings are fixed and carry no range — but "unlikely" is not
      // "impossible", and a window silently not firing is the same failure it
      // is for a controller. `flowsHealthy` false is what stops assessHealth()
      // from reporting 'ready' straight over the top of it.
      if (result.unsupported.length > 0) {
        this.unsupported = result.unsupported;
        this.flowsHealthy = false;
        this.setState('needs_repair', {
          key: 'state.unsupportedMapping',
          tokens: { controls: result.unsupported.map(u => u.bindingKey).join(', ') },
        });
      } else {
        this.unsupported = [];
      }

      this.deps.log(
        `Schedule flows reconciled: ${result.created} created, ${result.reused} reused, `
        + `${result.deleted} deleted`,
      );
      // Carried as state, not only logged — see ScheduleDiagnostics. A schedule
      // firing at two times is the sharpest form of "nothing on any screen
      // admits to it", and the log was the only place it appeared.
      this.staleFlows = result.staleReplacements;
      if (result.staleReplacements.length > 0) {
        // Both the new boundary flow and the one it replaced are live, so this
        // schedule now fires at two times. See the controller runtime.
        this.deps.log(
          `${result.staleReplacements.length} superseded flow(s) could not be deleted `
          + `and are still firing: ${result.staleReplacements.join(', ')}`,
        );
      }

      // Last, so it wins over the verdicts above: whatever else this pass
      // learned, a reference we could not store is the problem to report.
      if (persistFailed) this.setState('needs_repair', { key: 'state.persistFailed' });
    } catch (error) {
      this.flowsHealthy = false;
      const { state, detail } = classifyReconcileError(
        error, this.deps.api.credentials.getStatus(),
      );
      this.setState(state, detail);
    }
  }

  /** Targets present, key still able to write — in that order of severity. */
  async assessHealth(): Promise<void> {
    if (!this.plan.enabled) {
      this.setState('disabled');
      return;
    }

    // Reconciliation knows things this check does not, so its verdict stands
    // until a later reconcile succeeds.
    if (!this.flowsHealthy) return;

    // Ahead of the credential leg: a key can be re-entered, but a schedule whose
    // day check runs on the wrong clock cannot be trusted to fire on the right
    // day at all, and that is the more serious of the two.
    if (!this.clock().resolved) {
      this.setState('needs_repair', { key: 'state.noTimezone' });
      return;
    }

    if (this.plan.managedFlows.length > 0 && !this.deps.api.credentials.getStatus().valid) {
      this.setState('needs_credential', { key: 'state.needsCredential' });
      return;
    }

    const assessment = await assessTargets(this.deps.catalog, this.plan.target);
    this.setState(assessment.state, assessment.detail);
  }

  /**
   * A window that began while the app was down.
   *
   * Its on-Flow has already fired into nothing and will not fire again until
   * tomorrow, so without this a restart at 22:01 means no evening light at all.
   * The reverse case is deliberately NOT handled: a window that ENDED while we
   * were down leaves the lights as they are. Switching a user's lights off at app
   * start, on the guess that we might once have switched them on, is a worse
   * surprise than the one it prevents — and it is stated as a limit in the README
   * rather than hidden.
   */
  async catchUp(): Promise<void> {
    if (!this.plan.enabled) return;

    const { clock, resolved } = this.clock();
    if (!resolved) {
      this.refuseCatchUp('*', 'timezone unresolved — Homey clock and app clock may disagree');
      return;
    }
    if (!this.flowsHealthy) {
      this.refuseCatchUp('*', 'the last reconcile left the Flows untrustworthy');
      return;
    }

    /**
     * Overlapping windows: apply the LATEST-STARTED one only.
     *
     * `activeEntries` sorts by elapsed, so the first is the one whose values the
     * room should be showing. Applying every active entry in array order — which
     * is what this did — meant a restart inside two overlapping windows landed on
     * whichever the user happened to have added second.
     */
    const active = activeEntries(this.plan.entries, clock);
    if (active.length === 0) return;

    const [{ entry }, ...superseded] = active;

    if (!this.hasTrustedOffBoundary(entry)) {
      // The window's OFF Flow is what will eventually switch these lights off
      // again. Without a reference to it, catching up means switching a
      // household's lights on with nothing scheduled to switch them off.
      this.refuseCatchUp(entry.id, 'no off boundary Flow is recorded for this schedule');
      return;
    }

    if (superseded.length > 0) {
      this.deps.log(
        `${superseded.length} other schedule(s) are also active; `
        + `applying ${entry.id}, the latest to have started`,
      );
    }

    this.deps.log(
      `Catching up schedule ${entry.id}: ${formatMinutes(entry.onAt)}–`
      + `${formatMinutes(offMinuteOf(entry))} contains ${describeClock(clock)}`,
    );
    await this.apply(entry, 'on', 'catch-up');
  }

  /**
   * Is there a stored reference to this entry's OFF Flow?
   *
   * The whole of catch-up's licence to switch lights on rests on something else
   * switching them off later. A missing off reference — a half-finished
   * reconcile, a Flow the user deleted, a dead key at first save — means there is
   * nothing to end the window, so catch-up declines rather than lighting a room
   * indefinitely.
   */
  private hasTrustedOffBoundary(entry: ScheduleEntry): boolean {
    const wanted = eventKeyFor(entry.id, 'off');
    return this.plan.managedFlows.some(ref => ref.bindingKey === wanted);
  }

  private refuseCatchUp(entryId: string, reason: string): void {
    this.catchUpRefusals.add({ at: this.now(), entryId, reason });
    this.deps.log(`Not catching up ${entryId === '*' ? 'any schedule' : entryId}: ${reason}`);
  }

  /**
   * Entry point for a boundary event arriving from a generated Flow.
   *
   * Fails closed with a reason for each refusal. Generated flow arguments are
   * user-editable, so "the Flow fired" is never on its own permission to write to
   * anyone's lights.
   */
  handleEvent(eventKey: string): { accepted: boolean; reason?: string } {
    const outcome = this.validate(eventKey);
    if (!outcome.accepted) {
      this.lastRejection = { at: this.now(), eventKey, reason: outcome.reason ?? 'refused' };
      return outcome;
    }

    const { entry, boundary } = outcome;
    fireAndForget(this.apply(entry, boundary), this.deps.log, `Schedule boundary ${eventKey}`);
    return { accepted: true };
  }

  private validate(eventKey: string):
  | { accepted: true; entry: ScheduleEntry; boundary: ScheduleBoundary }
  | { accepted: false; reason: string } {
    const parsed = parseEventKey(eventKey);
    if (!parsed) return { accepted: false, reason: `"${eventKey}" is not a schedule event key` };

    if (!this.plan.enabled) return { accepted: false, reason: 'this schedule is paused' };

    const entry = this.plan.entries.find(e => e.id === parsed.entryId);
    if (!entry) {
      return {
        accepted: false,
        reason: `schedule "${parsed.entryId}" is not in this device's plan of ${this.plan.entries.length}`,
      };
    }

    const { clock, resolved } = this.clock();
    if (!resolved) {
      return {
        accepted: false,
        reason: 'timezone unresolved — Homey clock and app clock may disagree',
      };
    }
    if (!boundaryDayMatches(entry, parsed.boundary, clock.isoWeekday)) {
      return {
        accepted: false,
        reason: `${describeClock(clock)} is not one of this schedule's days`,
      };
    }

    return { accepted: true, entry, boundary: parsed.boundary };
  }

  /** Run one boundary now, whatever the clock says. Used by the Test control. */
  async testEntry(entryId: string, boundary: ScheduleBoundary): Promise<{ writes: number; skipped: number; targets: number }> {
    const entry = this.plan.entries.find(e => e.id === entryId);
    if (!entry) throw new Error('That schedule is no longer in the plan.');

    const result = await this.apply(entry, boundary, 'test');
    await this.scheduler?.drain();
    return { ...result, targets: this.targetIds.length };
  }

  private async apply(
    entry: ScheduleEntry,
    boundary: ScheduleBoundary,
    note?: string,
  ): Promise<{ writes: number; skipped: number }> {
    if (this.targetIds.length === 0) {
      this.lastAction = { at: this.now(), entryId: entry.id, boundary, writes: 0, skipped: 0, note: 'no targets' };
      return { writes: 0, skipped: 0 };
    }

    // Re-read live state first. The catalog is cached and only invalidates on
    // Homey events, so planning against a stale cache is how a group action ends
    // up deciding "nothing is on" hours after the fact.
    await Promise.all(this.targetIds.map(id => this.adapter.refresh(id)));

    /**
     * An off boundary while ANOTHER window is still running.
     *
     * The save-time check refuses overlapping windows, but plans stored by
     * earlier versions already contain them and a repair is not something we can
     * demand. So: 17:00–23:00 alongside 20:00–01:00 must not go dark at 23:00.
     * The surviving window's own values are re-applied, because the room should
     * be showing them and not whatever the window that just ended left behind.
     *
     * Deliberately NOT applied to a Test, whose whole point is to do exactly
     * what was asked, and not to catch-up, which only ever plans an on.
     */
    if (boundary === 'off' && note !== 'test') {
      const survivor = this.survivingWindow(entry);
      if (survivor) {
        const kept = survivor.brightness !== undefined || survivor.temperature !== undefined
          ? this.planOn(survivor)
          : { writes: [], skipped: 0 };
        if (kept.writes.length > 0) this.scheduler?.submit(kept.writes);
        this.lastAction = {
          at: this.now(), entryId: entry.id, boundary,
          writes: kept.writes.length, skipped: 0,
          note: `kept on — schedule "${survivor.id}" still active`,
        };
        this.deps.log(
          `Not switching off for ${entry.id}: schedule ${survivor.id} is still running`,
        );
        return { writes: kept.writes.length, skipped: 0 };
      }
    }

    const plan = boundary === 'on' ? this.planOn(entry) : this.planOff();

    if (!this.scheduler) {
      // Recorded rather than swallowed: an intent counted as N writes while
      // nothing was queued looks exactly like a working app with no effect.
      this.deps.log('No scheduler: the schedule runtime is not started, so writes were dropped');
      this.lastAction = {
        at: this.now(), entryId: entry.id, boundary,
        writes: 0, skipped: plan.skipped, note: 'dropped — runtime not started',
      };
      return { writes: 0, skipped: plan.skipped };
    }

    this.scheduler.submit(plan.writes);
    this.lastAction = {
      at: this.now(), entryId: entry.id, boundary,
      writes: plan.writes.length, skipped: plan.skipped,
      ...(note ? { note } : {}),
    };
    return { writes: plan.writes.length, skipped: plan.skipped };
  }

  /**
   * Another window that is still running at the moment `firing` ends.
   *
   * The latest-started one, for the same reason catch-up picks it: it is the one
   * whose values the room should be showing. Returns nothing when the clock
   * cannot be resolved — an off event we cannot place in time is not a reason to
   * leave a household's lights on.
   */
  private survivingWindow(firing: ScheduleEntry): ScheduleEntry | null {
    const { clock, resolved } = this.clock();
    if (!resolved) return null;

    const others = this.plan.entries.filter(entry => entry.id !== firing.id);
    return activeEntries(others, clock)[0]?.entry ?? null;
  }

  /**
   * "On" is up to three intents against the same lights: power, then brightness,
   * then warmth. They are composed rather than expressed as one new intent type
   * because the planner already knows how to skip a target that cannot dim, and
   * the write queue already orders onoff before dim so the level lands on a lit
   * lamp. Brightness is stored perceptually, so it converts through toDevice()
   * here — 40% means 40% of perceived brightness, as it does everywhere else.
   */
  private planOn(entry: ScheduleEntry): { writes: PlannedWrite[]; skipped: number } {
    const plans = [planIntent({ type: 'power', value: true }, this.targetIds, this.cache, DEFAULT_BEHAVIOR)];

    if (entry.brightness !== undefined) {
      plans.push(planIntent(
        { type: 'brightness_absolute', value: toDevice(entry.brightness) },
        this.targetIds, this.cache, DEFAULT_BEHAVIOR,
      ));
    }
    if (entry.temperature !== undefined) {
      plans.push(planIntent(
        { type: 'temperature_absolute', value: entry.temperature },
        this.targetIds, this.cache, DEFAULT_BEHAVIOR,
      ));
    }

    return {
      writes: plans.flatMap(p => p.writes),
      // Only the power leg's skips are a real miss; a lamp that cannot dim is
      // not a failed schedule, it is a lamp.
      skipped: plans[0].skipped.length,
    };
  }

  private planOff(): { writes: PlannedWrite[]; skipped: number } {
    const plan = planIntent({ type: 'power', value: false }, this.targetIds, this.cache, DEFAULT_BEHAVIOR);
    return { writes: plan.writes, skipped: plan.skipped.length };
  }

  /** Devices or zones changed: re-resolve without tearing the queue down. */
  async refreshTargets(): Promise<void> {
    const next = await resolveSnapshot(this.resolver, this.plan.target);
    // See target-snapshot.ts: the id list cannot see a light re-paired under
    // the same id with a different dim range, and a schedule that clamps to
    // the old range writes the wrong level twice a day for as long as it runs.
    if (this.snapshot && this.snapshot.fingerprint === next.fingerprint) return;

    const { removed } = diffTargets(this.snapshot, next);
    for (const deviceId of removed) {
      await releaseTarget(deviceId, {
        unsubscribe: id => this.adapter.unsubscribe(id),
        cancelPending: id => this.adapter.cancelPending(id),
        cache: this.cache,
      });
    }

    this.snapshot = next;
    this.targetIds = next.ids;
    this.targetNames = next.names;
    this.resolver.primeCache(next.devices, this.cache);
    this.deps.log(`Schedule targets re-resolved: ${next.ids.length} light(s)`);

    await this.assessHealth();
  }

  async updatePlan(plan: SchedulePlan): Promise<void> {
    this.plan = plan;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = null;
    // The adapter's pending post-write checks outlive this runtime unless
    // released — one firing after teardown would switch a light on 1.5 s after
    // the schedule was told to stand down.
    await this.adapter.unsubscribeAll();
    this.cache.clear();
    this.targetIds = [];
    this.targetNames = [];
    // Or the next refresh diffs the new plan's targets against the old plan's.
    this.snapshot = null;
  }

  /** Remove only what this schedule demonstrably owns. */
  async destroy(): Promise<void> {
    await this.stop();
    await this.deps.bridge.removeAll(this.plan.managedFlows);
  }

  /**
   * Adopt a state, and tell the device layer when anything a user could SEE
   * has changed.
   *
   * The comparison used to be `state === state` alone, which is not what the
   * device layer renders: it renders the state AND its detail, and the detail
   * is where the sentence lives. So a device that went from "the API key
   * expired" to "the API key has no Flow permission" — both `needs_credential`
   * — kept showing the first message, and the user re-minted a key with the
   * same problem because the app never stopped telling them to.
   */
  private setState(state: ControllerState, detail?: StateDetail): void {
    if (this.state === state && sameDetail(this.lastDetail, detail)) return;
    this.state = state;
    this.lastDetail = detail;
    this.stateRevision += 1;
    this.deps.onStateChange(state, detail);
  }

  /** The detail last handed to the device layer, for the comparison above. */
  private lastDetail: StateDetail | undefined;
  /** Diagnostics only: how many times the visible state has actually moved. */
  private stateRevision = 0;

  /**
   * Controls the flow compiler declined, from the last reconcile.
   *
   * Kept as state rather than only logged: it is the difference between a
   * mapping row that is configured and one that is configured AND compiles,
   * and only the second one will ever move a light.
   */
  private unsupported: Array<{ bindingKey: string; reason: string }> = [];

  /**
   * Flows the last reconcile could not delete. See ScheduleDiagnostics for why
   * this is state rather than a log line.
   */
  private staleFlows: string[] = [];

  /** Never exposes secrets or unrelated Homey configuration. */

  /** The target set this runtime is built against. See the controller's. */
  private snapshot: TargetSnapshot | null = null;

  diagnostics(): ScheduleDiagnostics {
    const timezone = this.deps.timezone();
    const { clock, resolved } = this.clock();
    return {
      controllerId: this.controllerId,
      kind: 'schedule',
      name: this.deps.displayName(),
      state: this.state,
      enabled: this.plan.enabled,
      // The two facts every "it fired at the wrong time" report needs, and the
      // only place the resolved timezone is visible at all.
      timezone: timezone ?? 'process-local',
      // Whether that zone was actually USED. A named zone the ICU build cannot
      // resolve falls back silently, and this device type refuses to fire on a
      // clock it does not trust — so the flag is the first thing to read.
      timezoneResolved: resolved,
      localTime: describeClock(clock),
      entries: this.plan.entries.map(entry => ({
        id: entry.id,
        on: formatMinutes(entry.onAt),
        off: formatMinutes(offMinuteOf(entry)),
        days: entry.days ?? 'every day',
        ...(entry.brightness !== undefined ? { brightness: entry.brightness } : {}),
        ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
        active: activeWindowStartDay(entry, clock) !== null,
        end: entry.end,
      })),
      targetIds: this.targetIds,
      targetNames: this.targetNames,
      managedFlows: this.plan.managedFlows,
      lastAction: this.lastAction,
      lastRejection: this.lastRejection,
      catchUpRefusals: this.catchUpRefusals.entries(),
      unsupported: this.unsupported,
      // Still live, still firing, and nothing else can show them.
      staleReplacements: this.staleFlows,
      // How many times the VISIBLE state has moved. A device stuck on a
      // stale message with a rising revision means the device layer is not
      // rendering what it is being told.
      stateRevision: this.stateRevision,
      recentFailures: this.adapter.failures(),
      recentWrites: this.adapter.writes(),
      schedulerReady: this.scheduler !== null,
      credential: this.deps.api.credentials.getStatus(),
    };
  }
}
