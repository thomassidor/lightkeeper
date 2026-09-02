import type { HomeyApiService, Unsubscribe } from '../homey-api-service';
import type { Capability, WriteValue } from './intent-planner';
import type { TargetStateCache } from './target-state-cache';
import { fireAndForget } from '../support/async';
import { BoundedLog } from '../support/bounded-log';
import { KeyedMutex } from '../support/keyed-mutex';

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

/** One attempted write and what became of it. */
export interface WriteRecord {
  at: number;
  deviceId: string;
  capability: Capability;
  value: WriteValue;
  ok: boolean;
  ms: number;
  error?: string;
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
  private readonly pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();

  /** See setImpliedOnFallback. */
  private onImpliedOnFallback: ((deviceId: string) => Promise<void>) | null = null;

  constructor(
    private readonly api: HomeyApiService,
    private readonly cache: TargetStateCache,
    private readonly log: (...args: unknown[]) => void,
  ) {}

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
    ok: boolean; ms: number; error?: string;
  }): void {
    const record = { at: Date.now(), ...entry };
    this.recentWrites.add(record);
    this.onWriteResult?.(record);
  }

  async write(
    deviceId: string,
    capability: Capability,
    value: WriteValue,
    options: { impliesOn?: boolean } = {},
  ): Promise<void> {
    // The echo registration goes BEFORE dispatch: a fast integration can call
    // back before setCapabilityValue resolves, and an unrecognised echo reads
    // as somebody using the Hue app.
    const seq = this.cache.noteEcho(deviceId, capability, value);
    const startedAt = Date.now();

    try {
      const device = await this.deviceHandle(deviceId);
      await device.setCapabilityValue({ capabilityId: capability, value });
      // The desired value goes AFTER, and only on success. Committing it up
      // front left the app believing a lamp was at a level it had never
      // reached whenever a write failed — and the next relative step planned
      // from the fiction, so "a bit brighter" moved from a number nothing in
      // the room had ever shown.
      this.cache.commitDesired(deviceId, capability, value, seq);
      this.noteWriteResult({ deviceId, capability, value, ok: true, ms: Date.now() - startedAt });

      if (options.impliesOn) this.verifyCameOn(deviceId, startedAt);
    } catch (error) {
      this.noteWriteResult({
        deviceId, capability, value, ok: false, ms: Date.now() - startedAt,
        error: (error as Error)?.message ?? String(error),
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

    const timer = setTimeout(() => {
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
    clearTimeout(timer);
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
            this.log(`Capability listener for ${capability} on ${deviceId} threw:`, (error as Error)?.message);
          }
        });
        // track() hands back a wrapper that also removes itself from the
        // service's teardown set, so tearing down here does not leave a stale
        // entry behind for destroy() to call a second time.
        created.push(this.api.track(() => instance.destroy()));
      } catch (error) {
        this.log(`Could not subscribe to ${capability} on ${deviceId}:`, (error as Error)?.message);
      }
    }

    if (created.length > 0) this.subscriptions.set(deviceId, created);
  }

  /** Drop every capability subscription for one target. */
  async unsubscribe(deviceId: string): Promise<void> {
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
    for (const timer of this.pendingChecks.values()) clearTimeout(timer);
    this.pendingChecks.clear();

    for (const deviceId of [...this.subscriptions.keys()]) {
      await this.unsubscribe(deviceId);
    }
    this.handles.clear();
  }

  /** Refresh cached state from live values — used at startup, never persisted. */
  async refresh(deviceId: string): Promise<void> {
    const client = await this.api.read();
    try {
      const device = await client.devices.getDevice({ id: deviceId });
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
      this.cache.initialise(deviceId, {
        onoff: device.capabilitiesObj?.onoff?.value,
        dim: device.capabilitiesObj?.dim?.value,
        light_temperature: device.capabilitiesObj?.light_temperature?.value,
        light_hue: device.capabilitiesObj?.light_hue?.value,
        light_saturation: device.capabilitiesObj?.light_saturation?.value,
      });
    } catch (error) {
      this.recordFailure(deviceId, 'onoff', error);
    }
  }

  private recordFailure(deviceId: string, capability: Capability, error: unknown): void {
    const message = (error as Error)?.message ?? String(error);
    // Newest first, like every other diagnostic log — this one was the odd
    // one out (push/shift), so the settings page rendered it backwards.
    this.recentFailures.add({ deviceId, capability, message, at: Date.now() });

    const key = `${deviceId}:${capability}`;
    const now = Date.now();
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
