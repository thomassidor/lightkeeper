import type { HomeyApiService, Unsubscribe } from '../homey-api-service';
import type { Capability, WriteValue } from './intent-planner';
import type { TargetStateCache } from './target-state-cache';
import { liveValuesOf } from './target-state-cache';
import { fireAndForget } from '../support/async';
import { withDefaults, type Timers } from '../support/timers';
import { BoundedLog } from '../support/bounded-log';
import { KeyedMutex } from '../support/keyed-mutex';
import { NO_CACHE } from '../flow-card-catalogue';
import { messageOf } from '../support/homey-errors';

/**
 * Executes intents against targets and reconciles external changes.
 *
 * Failure policy: target writes are independent and results aggregated.
 * One light failing must not prevent updates to the others, and routine
 * transient failures are recorded rather than surfaced as blocking UI.
 */

export interface TargetFailure {
  deviceId: string;
  capability: Capability;
  message: string;
  at: number;
}

/**
 * One attempted write and what became of it.
 *
 * **On the `onWriteResult` sink every runtime and manager declares.** It is ONE
 * app-wide log of every write attempted by ANY runtime. Optional, so the
 * pairing screens' ephemeral rigs (which have no app) still work unchanged. Its
 * consumer is the settings page: "did anything reach a light" is a question
 * about the whole Homey, and answering it from the FIRST controller's log —
 * which is what `api.ts` did — made it permanently empty for a household that
 * runs only schedules, and permanently misleading for one that runs both.
 *
 * That paragraph lived in full on all four runtimes and all four managers. It is
 * one rationale, not eight, so it lives here on the type they all name and the
 * eight declarations point at it.
 */
export interface WriteRecord {
  at: number;
  deviceId: string;
  capability: Capability;
  value: WriteValue;
  ok: boolean;
  ms: number;
  error?: string;
  /**
   * Present and true only on a pre-stage write. Emitted rather than always
   * carried so the settings page's write log stays narrow — and it is here at
   * all so that somebody reading a diagnostics dump can see WHY a run of
   * failures did not move the health verdict. See `noteWriteHealth()`.
   */
  preStage?: boolean;
}

export class LightTargetAdapter {
  private readonly recentFailures = new BoundedLog<TargetFailure>(50);
  /** Rate-limit repeated transient errors from the same target. */
  private readonly lastLoggedAt = new Map<string, number>();

  /**
   * Live capability subscriptions, per device.
   *
   * Keyed so re-subscribing REPLACES rather than stacks. `refreshTargets()`
   * calls subscribe() again for every target on every catalog change, and our
   * own profile writes emit device.update — which lands back in
   * onCatalogChange. Without this map each pass added another instance per
   * capability per light: unbounded growth, and applyExternalChange firing N
   * times for one real change.
   */
  private readonly subscriptions = new Map<string, Unsubscribe[]>();

  /**
   * Pending post-write onoff checks (see verifyCameOn), keyed BY DEVICE.
   *
   * Tracked so stop() can cancel them — a timer that fires after teardown
   * would switch a light on 1.5 s after the controller was told to stand
   * down. Keyed rather than a flat set so ONE device'''s probe can be cancelled
   * too: by a newer write, and by the device ceasing to be a target, which
   * previously there was no way to reach.
   */
  private readonly pendingChecks = new Map<string, unknown>();

  /** See setImpliedOnFallback. */
  private onImpliedOnFallback: ((deviceId: string) => Promise<void>) | null = null;

  /**
   * The clock and the timer, injectable.
   *
   * This was the last thing in the write path reading the wall clock directly:
   * nine bare `this.timers.now()` calls and a bare `setTimeout` driving the implied-on
   * probe, which can switch a lamp ON 1.5 s after somebody switched it off. That
   * is a safety-relevant path and it could only be tested by waiting 1.6 real
   * seconds — `isUnwritable()` and `unwritableTargets()` had even grown a `now`
   * PARAMETER as a way around it, which is the shape of a workaround rather than
   * a design.
   *
   * Optional, so every existing caller — the four runtimes and three test rigs —
   * is unchanged and gets the real clock.
   */
  private readonly timers: Timers;

  constructor(
    private readonly api: HomeyApiService,
    private readonly cache: TargetStateCache,
    private readonly log: (...args: unknown[]) => void,
    timers?: Partial<Timers>,
  ) {
    this.timers = withDefaults(timers);
  }

  /**
   * Device handles, cached.
   *
   * getDevice() is a round trip to the Homey API. Doing it on every write put
   * a full request in front of every single light change — the largest
   * avoidable source of press-to-light latency. The handle stays valid; only
   * its values change, and those arrive over the capability subscription.
   */
  private readonly handles = new Map<string, Promise<any>>();

  private deviceHandle(deviceId: string): Promise<any> {
    let handle = this.handles.get(deviceId);
    if (!handle) {
      handle = (async () => {
        try {
          const client = await this.api.read();
          return await client.devices.getDevice({ id: deviceId });
        } catch (error) {
          // The handle is already dropped by the callers' own catch blocks. What
          // was missing is the CLIENT: a socket that has gone away answers every
          // later handle fetch identically, so every light on the Homey stays
          // unreachable until the app restarts.
          this.api.reportReadFailure(error);
          throw error;
        }
      })();
      this.handles.set(deviceId, handle);
    }
    return handle;
  }

  /**
   * Every write actually attempted, with its outcome. "Planned N writes" told
   * us nothing about whether any reached a light — this does.
   */
  private readonly recentWrites = new BoundedLog<WriteRecord>(30);

  writes(): readonly WriteRecord[] {
    return this.recentWrites.entries();
  }

  /**
   * A sink shared by every runtime in the app, so the settings page can show
   * "did anything reach a light" across all of them.
   *
   * Optional: the pairing screen's ephemeral rigs have no app to report to,
   * and the per-runtime log below is unaffected either way.
   */
  private onWriteResult: ((entry: WriteRecord) => void) | null = null;

  setWriteSink(sink: (entry: WriteRecord) => void): void {
    this.onWriteResult = sink;
  }

  private noteWriteResult(entry: {
    deviceId: string; capability: Capability; value: WriteValue;
    ok: boolean; ms: number; error?: string; preStage?: boolean;
  }): void {
    const record = { at: this.timers.now(), ...entry };
    this.recentWrites.add(record);
    this.onWriteResult?.(record);
    this.noteWriteHealth(entry.deviceId, entry.capability, entry.ok, entry.preStage === true);
  }

  /**
   * Which targets have stopped taking writes — the signal the app had no way
   * to see.
   *
   * Measured on hardware (probe run, 3 September 2026): a Hue bulb reported
   * `available: true` for eighteen minutes while 93 of 113 writes to it failed
   * with "The device could not be reached. Is it powered on?".
   *
   * The failure was never HIDDEN — the scheduler's `onError` logs every one and
   * `recentWrites` below carries each attempt with its outcome. What was missing
   * is that none of it became a state anybody could see without reading
   * `homey app run --remote`: `assessTargets()` asks the catalog's `available`
   * flag, which does not track reachability at all (platform §6), so a circadian
   * light goes on writing to that lamp every minute for ever behind a green tile.
   *
   * Kept here rather than in `recordFailure()` on purpose: `refresh()` calls
   * that one with a hardcoded `'onoff'` for a failed READ, and a failed prime
   * is not a lamp refusing to be driven.
   */
  private readonly failureStreaks = new Map<string,
  { since: number; count: number; announced: boolean }>();

  /**
   * A count AND a time floor, because a count alone is the trap.
   *
   * A ramp is ten seconds at five writes a second per capability
   * (`HARD_STOP_MS` in ramp-engine, the 200 ms floor in DEFAULT_BEHAVIOR), so
   * one bad ramp on a briefly flaky lamp produces around fifty consecutive
   * failures in ten seconds — a count-only threshold trips on it and a
   * household's tiles go yellow because somebody held a dim button. A
   * circadian light writes once a minute, so a time-only threshold says
   * nothing about how many attempts stood behind it.
   *
   * Three failed writes AND a five-minute-old streak: no ramp can reach it,
   * a circadian light reaches it after five ticks, and a twice-a-day schedule
   * needs two windows. Slow rather than wrong, which is the right way round
   * for something that marks a user's device.
   */
  static readonly UNWRITABLE_AFTER_WRITES = 3;

  static readonly UNWRITABLE_AFTER_MS = 5 * 60_000;

  /**
   * Deliberately message-blind.
   *
   * The two integrations in that run phrase the same thing differently — Hue's
   * "The device could not be reached. Is it powered on?" against IKEA's "Could
   * not reach device. Is it powered on?" — and `isTransportFailure()` is the
   * wrong instrument by design: it asks whether we reached the HOMEY, which we
   * did. A rejection is a rejection, and staying blind to its wording is what
   * makes this work on an integration nobody here has seen.
   *
   * `light_mode` is excluded in BOTH directions. It is written to make a value
   * land, never as a value in itself (`WRITE_ORDER`), and the Hue app satisfies
   * it locally without reaching the bulb: on the reference lamp it was the ONLY
   * capability that acked, twenty times, while every value write failed. Let a
   * `light_mode` success clear the streak and a dead lamp looks healthy forever.
   *
   * A pre-stage FAILURE is excluded too, and unlike `light_mode` the exclusion
   * runs one way only.
   *
   * Measured on 4 September 2026 across 13 Philips Hue bulbs behind one bridge:
   * 4 rejected a colour write to a lamp that was off — `is "soft off", command
   * (.color_temperature.mirek) may not have effect`, platform §6's third
   * outcome — while 9 took the same write and stayed off, and the two bulbs
   * that were genuinely dead rejected every axis including `dim`. From the
   * rejection alone a soft-off lamp and a dead one are the same event, so it is
   * evidence of nothing. Counted, it marked healthy lamps as not responding for
   * as long as the household had them switched off: a curve retries a failed
   * write every tick by design (`noteOutcomes`), and a coloured point books two
   * countable failures a minute.
   *
   * One-directional because a pre-stage SUCCESS is real evidence, which is
   * exactly what a `light_mode` ack is not: the mode write never left the
   * phone, while this one reached the bridge and the bridge did not refuse it.
   * Excluding successes too would rebuild the bug from the other side — a lamp
   * that failed three lit writes at nine and is then pre-staged happily all
   * night would stay "not responding" until morning, with nothing left able to
   * clear it.
   *
   * A caller's flag rather than a look at `cache.state(id).actualOn`, and that
   * is not fussiness. A schedule turning a window on submits `onoff`, `dim` and
   * `light_temperature` in one batch; `actualOn` only flips when the ECHO
   * lands, so the temperature write executes while the lamp is still cached as
   * off. Reading the cache here would throw that failure away on the one path
   * where the lamp really is dead. The flag means one thing — the plan chose to
   * write to a lamp it knew was off — and nothing else in the app sets it.
   *
   * What it costs, stated rather than left to be discovered: a lamp that is
   * dead, is reported off, AND is only ever written to speculatively builds no
   * streak. Bounded, because the usual dead lamp (cut at the wall, bridge still
   * reporting `onoff: true`) is treated as lit and gets ordinary writes, and
   * because accounting resumes in full the moment anything real is written to
   * it. Nothing is hidden either way: the failure is still in `recentWrites`,
   * still in `recentFailures`, and still logged by the scheduler's `onError`.
   * Only the verdict changes.
   */
  private noteWriteHealth(
    deviceId: string,
    capability: Capability,
    ok: boolean,
    preStage = false,
  ): void {
    if (capability === 'light_mode') return;
    // `!ok &&`, never a bare `preStage`: a success has to go on clearing the
    // streak, or the paragraph above about nine o'clock becomes the behaviour.
    if (!ok && preStage) return;

    if (ok) {
      this.failureStreaks.delete(deviceId);
      return;
    }

    const streak = this.failureStreaks.get(deviceId);
    if (!streak) {
      this.failureStreaks.set(deviceId, { since: this.timers.now(), count: 1, announced: false });
      return;
    }

    streak.count += 1;
    /**
     * Once, on the first write AFTER the threshold is met. Every individual
     * failure is already logged by the scheduler's onError; what that stream
     * cannot say is "this one has now been failing long enough to count",
     * which is the line worth finding when somebody asks why a tile went
     * yellow.
     *
     * Best-effort, and it is the health verdict rather than this line that is
     * the mechanism: a target written to twice a day meets the threshold on
     * the clock, and nothing announces it until the next write arrives.
     * Announcing from `unwritableTargets()` instead would put a side effect
     * inside a query that a health timer calls, which is worse than a missing
     * log line.
     */
    if (!streak.announced && this.isUnwritable(streak)) {
      streak.announced = true;
      this.log(`${deviceId} has failed ${streak.count} writes since `
        + `${new Date(streak.since).toISOString()} — treating it as not responding`);
    }
  }

  private isUnwritable(
    streak: { since: number; count: number },
    now: number = this.timers.now(),
  ): boolean {
    return streak.count >= LightTargetAdapter.UNWRITABLE_AFTER_WRITES
      && now - streak.since >= LightTargetAdapter.UNWRITABLE_AFTER_MS;
  }

  /**
   * The device ids a health check should treat as not working, whatever the
   * catalog says about them.
   */
  unwritableTargets(now: number = this.timers.now()): Set<string> {
    const out = new Set<string>();
    for (const [deviceId, streak] of this.failureStreaks) {
      if (this.isUnwritable(streak, now)) out.add(deviceId);
    }
    return out;
  }

  async write(
    deviceId: string,
    capability: Capability,
    value: WriteValue,
    options: { impliesOn?: boolean; preStage?: boolean } = {},
  ): Promise<void> {
    // The echo registration goes BEFORE dispatch: a fast integration can call
    // back before setCapabilityValue resolves, and an unrecognised echo reads
    // as somebody using the Hue app.
    const seq = this.cache.noteEcho(deviceId, capability, value);
    const startedAt = this.timers.now();

    try {
      const device = await this.deviceHandle(deviceId);
      await device.setCapabilityValue({ capabilityId: capability, value });
      // The desired value goes AFTER, and only on success. Committing it up
      // front left the app believing a lamp was at a level it had never
      // reached whenever a write failed — and the next relative step planned
      // from the fiction, so "a bit brighter" moved from a number nothing in
      // the room had ever shown.
      this.cache.commitDesired(deviceId, capability, value, seq);
      this.noteWriteResult({
        deviceId, capability, value, ok: true, ms: this.timers.now() - startedAt,
        ...(options.preStage ? { preStage: true } : {}),
      });

      if (options.impliesOn) this.verifyCameOn(deviceId, startedAt);
    } catch (error) {
      this.noteWriteResult({
        deviceId, capability, value, ok: false, ms: this.timers.now() - startedAt,
        error: messageOf(error),
        ...(options.preStage ? { preStage: true } : {}),
      });
      // A stale handle (device re-paired, app restarted) must not wedge writes.
      this.handles.delete(deviceId);
      this.recordFailure(deviceId, capability, error);
      throw error;
    }
  }

  /**
   * We skipped the separate onoff write because a dim write turns the lamp on
   * (measured on Hue). Not every integration need behave that way, so check
   * afterwards and write onoff only if the lamp really did stay dark. Costs
   * nothing in the normal case and cannot leave a light stuck off.
   */
  private verifyCameOn(deviceId: string, writtenAt: number): void {
    // Per device, so a burst does not stack probes and a newer write cancels
    // the older one's. The set of loose timers it replaced could not be
    // cancelled per device at all, which is what made removing a target
    // unable to release its pending work.
    this.cancelPending(deviceId);

    const timer = this.timers.setTimeout(() => {
      this.pendingChecks.delete(deviceId);
      fireAndForget((async () => {
        if (this.cache.state(deviceId).actualOn === true) return;

        /**
         * Stand down if this lamp's power has been touched since our write.
         *
         * 1.5 s is long enough for a person to reach a wall switch, and
         * without this the app corrected them: dim with impliesOn, user
         * decides against it and switches the lamp off, and a second and a
         * half later the app switched it back on. Nothing about that is
         * recoverable from the user's side except doing it again and hoping.
         *
         * A TIMESTAMP, not a value, and both alternatives are wrong for a
         * reason worth keeping:
         *
         *  - `desiredOn === false` would stand down on the normal case. The
         *    lamp being off is the STARTING state of every dim-with-impliesOn;
         *    that is what impliesOn means.
         *  - `actualOn` cannot see it either: switched off and on again leaves
         *    the lamp exactly where our write wanted it, while the user has
         *    very much spoken.
         */
        const changedAt = this.cache.lastOnOffChangeAt(deviceId);
        if (changedAt !== undefined && changedAt > writtenAt) {
          this.log(`${deviceId} had its power changed after the dim write; leaving it alone`);
          return;
        }

        // Through the runtime's own scheduler where one is wired, so the
        // corrective write inherits ordering, the rate cap, outcomes and the
        // noteEcho/commitDesired pairing rather than going around all four.
        if (this.onImpliedOnFallback) {
          this.log(`${deviceId} did not switch on from a dim write; sending onoff`);
          await this.onImpliedOnFallback(deviceId);
          return;
        }

        try {
          const device = await this.deviceHandle(deviceId);
          await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
          this.log(`${deviceId} did not switch on from a dim write; sent onoff explicitly`);
        } catch (error) {
          this.recordFailure(deviceId, 'onoff', error);
        }
      })(), this.log, `Implied-on check for ${deviceId}`);
    }, 1500);
    this.pendingChecks.set(deviceId, timer);
  }

  /**
   * Drop any outstanding implied-on probe for one device.
   *
   * Called when a device stops being a target, and by a newer write to the
   * same device. Before this the probes were a flat Set with no way to reach
   * one by device, so a light removed from a plan could still be switched on
   * a second and a half later by a probe nobody could cancel.
   */
  cancelPending(deviceId: string): void {
    const timer = this.pendingChecks.get(deviceId);
    if (timer === undefined) return;
    this.timers.clearTimeout(timer);
    this.pendingChecks.delete(deviceId);
  }

  /**
   * Route the corrective on-write through the runtime that owns this adapter.
   *
   * Optional: the pairing screen's ephemeral rigs have no scheduler, and the
   * direct write above is the honest fallback there.
   */
  setImpliedOnFallback(fallback: (deviceId: string) => Promise<void>): void {
    this.onImpliedOnFallback = fallback;
  }

  /**
   * Serialised PER DEVICE, because "replace, never stack" is a read-then-write.
   *
   * The `set` at the end of `subscribe()` lands after two awaits, so two
   * overlapping calls for one device both saw "nothing subscribed", both built a
   * full set of capability instances, and the second `set` overwrote the first —
   * orphaning a live array of listeners on somebody's lamp with nothing left
   * holding a handle to destroy them. `KeyedMutex` is a plain per-key FIFO and
   * exists in this repo for exactly this shape ("a read-then-create is only safe
   * if two callers cannot both read absent").
   */
  private readonly subscriptionLock = new KeyedMutex();

  /**
   * Subscribe to a target's capability changes so external changes — someone
   * using the vendor app, or a wall switch — reconcile into desired state.
   *
   * `onChange` is optional and additive. The cache already decides whether a
   * change is genuinely external or the echo of our own write, and until the
   * circadian runtime needed it that verdict was computed and thrown away —
   * which is why this hands it on rather than making every caller re-derive it.
   * A controller does not care (it reacts to remotes, not to lights); a
   * circadian light cares about both edges of `onoff` and about someone
   * overriding its colour by hand.
   */
  async subscribe(
    deviceId: string,
    capabilities: Capability[],
    onChange?: (
      deviceId: string, capability: Capability, value: unknown, external: boolean,
    ) => void,
  ): Promise<void> {
    return this.subscriptionLock.run(deviceId, () =>
      this.subscribeNow(deviceId, capabilities, onChange));
  }

  private async subscribeNow(
    deviceId: string,
    capabilities: Capability[],
    onChange?: (
      deviceId: string, capability: Capability, value: unknown, external: boolean,
    ) => void,
  ): Promise<void> {
    // Replace, never stack. See the `subscriptions` field for why.
    await this.unsubscribeNow(deviceId);

    const client = await this.api.read();
    const device = await client.devices.getDevice({ id: deviceId });

    const created: Unsubscribe[] = [];
    for (const capability of capabilities) {
      if (!this.cache.supports(deviceId, capability)) continue;
      try {
        const instance = device.makeCapabilityInstance(capability, (value: unknown) => {
          const external = this.cache.applyExternalChange(deviceId, capability, value);
          // Never let a listener's failure take the subscription down with it:
          // this callback runs inside Homey's own event dispatch.
          try {
            onChange?.(deviceId, capability, value, external);
          } catch (error) {
            this.log(`Capability listener for ${capability} on ${deviceId} threw:`, messageOf(error));
          }
        });
        // track() hands back a wrapper that also removes itself from the
        // service's teardown set, so tearing down here does not leave a stale
        // entry behind for destroy() to call a second time.
        created.push(this.api.track(() => instance.destroy()));
      } catch (error) {
        this.log(`Could not subscribe to ${capability} on ${deviceId}:`, messageOf(error));
      }
    }

    if (created.length > 0) this.subscriptions.set(deviceId, created);
  }

  /** Drop every capability subscription for one target. */
  async unsubscribe(deviceId: string): Promise<void> {
    // A device that has stopped being a target takes its failure streak with
    // it. Cleared HERE and not in unsubscribeNow(), which subscribeNow() calls
    // to replace an existing subscription — and refreshTargets() re-subscribes
    // on every catalog change, so clearing there would wipe the streak
    // repeatedly and nothing would ever reach the threshold.
    this.failureStreaks.delete(deviceId);
    // Through the same per-device lock, or an unsubscribe can interleave with a
    // subscribe and leave the instances it was meant to remove behind.
    return this.subscriptionLock.run(deviceId, () => this.unsubscribeNow(deviceId));
  }

  private async unsubscribeNow(deviceId: string): Promise<void> {
    const existing = this.subscriptions.get(deviceId);
    if (!existing) return;
    this.subscriptions.delete(deviceId);
    for (const off of existing) {
      try {
        await off();
      } catch { /* teardown is best effort */ }
    }
  }

  /**
   * Release everything this adapter holds: subscriptions, pending onoff checks
   * and cached device handles. Called from ControllerRuntime.stop() so nothing
   * outlives the controller that created it.
   */
  async unsubscribeAll(): Promise<void> {
    for (const timer of this.pendingChecks.values()) this.timers.clearTimeout(timer);
    this.pendingChecks.clear();

    for (const deviceId of [...this.subscriptions.keys()]) {
      await this.unsubscribe(deviceId);
    }
    this.handles.clear();
    this.failureStreaks.clear();
  }

  /**
   * Refresh cached state from LIVE values — used at startup, never persisted.
   *
   * `NO_CACHE` is what makes that true, and without it this method did the
   * opposite of its name. `DeviceCatalog` reads `getDevices()`, and a `getAll`
   * writes every item it returns into `homey-api`'s per-manager `__cache` for
   * the life of the client (platform §15) — so this `getDevice` was served from
   * that snapshot, and primed `actualOn` with whatever the lamp was doing when
   * the catalogue was last read.
   *
   * Found on hardware, 2 September 2026, and it is user-visible: switch your
   * lights on, then pair a circadian light. Its runtime starts, reads the
   * lamp as OFF from the cached snapshot, and `applyNow()` skips it — so the
   * light does nothing at all until somebody next toggles it, at which point the
   * capability subscription corrects the cache and it starts working. The lamps
   * were demonstrably on, `getDevice` over a separate client returned
   * `onoff: true`, and the app reported `on=false` for the same device.
   */
  async refresh(deviceId: string): Promise<void> {
    const client = await this.api.read();
    try {
      const device = await client.devices.getDevice({ id: deviceId, ...NO_CACHE });
      /**
       * All five, because `initialise()` assigns all five.
       *
       * It used to pass three, and `initialise()` writes every pair
       * unconditionally — so a refresh BLANKED the hue and saturation that
       * `primeCache()` had just seeded. Only the curve-driven runtimes subscribe
       * to `light_hue`, and for each of their colour-capable lamps
       * `desiredHue` was then undefined until the first successful hue write
       * committed one. In that window a redundant hue report carrying the lamp's
       * UNCHANGED value had nothing to be compared against, so it read as
       * somebody reaching for the vendor app and stood the device down for that
       * light.
       *
       * The fields are already on the object being read; nothing extra is
       * fetched.
       */
      this.cache.initialise(deviceId, liveValuesOf(device));
    } catch (error) {
      this.recordFailure(deviceId, 'onoff', error);
    }
  }

  private recordFailure(deviceId: string, capability: Capability, error: unknown): void {
    const message = messageOf(error);
    // Newest first, like every other diagnostic log — this one was the odd
    // one out (push/shift), so the settings page rendered it backwards.
    this.recentFailures.add({ deviceId, capability, message, at: this.timers.now() });

    const key = `${deviceId}:${capability}`;
    const now = this.timers.now();
    const last = this.lastLoggedAt.get(key) ?? 0;
    if (now - last > 60_000) {
      this.lastLoggedAt.set(key, now);
      this.log(`Write failed for ${deviceId} (${capability}): ${message}`);
    }
  }

  failures(): TargetFailure[] {
    return [...this.recentFailures.entries()];
  }
}
