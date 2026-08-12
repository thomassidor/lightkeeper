import type { HomeyApiService, Unsubscribe } from '../homey-api-service';
import type { Capability } from './intent-planner';
import type { TargetStateCache } from './target-state-cache';

/**
 * Spec §4 — executes intents against targets and reconciles external changes.
 *
 * Failure policy (§7.9): target writes are independent and results aggregated.
 * One light failing must not prevent updates to the others, and routine
 * transient failures are recorded rather than surfaced as blocking UI.
 */

export interface TargetFailure {
  deviceId: string;
  capability: Capability;
  message: string;
  at: number;
}

export class LightTargetAdapter {
  private readonly recentFailures: TargetFailure[] = [];
  /** Rate-limit repeated transient errors from the same target (§9.5). */
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
   * Pending post-write onoff checks (see verifyCameOn). Tracked so stop() can
   * cancel them — a timer that fires after teardown would switch a light on
   * 1.5 s after the controller was told to stand down.
   */
  private readonly pendingChecks = new Set<ReturnType<typeof setTimeout>>();

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
        const client = await this.api.read();
        return client.devices.getDevice({ id: deviceId });
      })();
      this.handles.set(deviceId, handle);
    }
    return handle;
  }

  /**
   * Every write actually attempted, with its outcome. "Planned N writes" told
   * us nothing about whether any reached a light — this does.
   */
  private readonly recentWrites: Array<{
    at: number; deviceId: string; capability: Capability;
    value: boolean | number; ok: boolean; ms: number; error?: string;
  }> = [];

  writes(): ReadonlyArray<Record<string, unknown>> {
    return this.recentWrites;
  }

  private noteWriteResult(entry: {
    deviceId: string; capability: Capability; value: boolean | number;
    ok: boolean; ms: number; error?: string;
  }): void {
    this.recentWrites.unshift({ at: Date.now(), ...entry });
    if (this.recentWrites.length > 30) this.recentWrites.pop();
  }

  async write(
    deviceId: string,
    capability: Capability,
    value: boolean | number,
    options: { impliesOn?: boolean } = {},
  ): Promise<void> {
    // Record the intended value first so the resulting echo is recognised as
    // ours rather than as an external change (§7.5).
    this.cache.noteWrite(deviceId, capability, value);
    const startedAt = Date.now();

    try {
      const device = await this.deviceHandle(deviceId);
      await device.setCapabilityValue({ capabilityId: capability, value });
      this.noteWriteResult({ deviceId, capability, value, ok: true, ms: Date.now() - startedAt });

      if (options.impliesOn) this.verifyCameOn(deviceId);
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
  private verifyCameOn(deviceId: string): void {
    const timer = setTimeout(() => {
      this.pendingChecks.delete(timer);
      void (async () => {
        if (this.cache.state(deviceId).actualOn === true) return;
        try {
          const device = await this.deviceHandle(deviceId);
          await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
          this.log(`${deviceId} did not switch on from a dim write; sent onoff explicitly`);
        } catch (error) {
          this.recordFailure(deviceId, 'onoff', error);
        }
      })();
    }, 1500);
    this.pendingChecks.add(timer);
  }

  /**
   * Subscribe to a target's capability changes so external changes — someone
   * using the vendor app, or a wall switch — reconcile into desired state.
   */
  async subscribe(deviceId: string, capabilities: Capability[]): Promise<void> {
    // Replace, never stack. See the `subscriptions` field for why.
    await this.unsubscribe(deviceId);

    const client = await this.api.read();
    const device = await client.devices.getDevice({ id: deviceId });

    const created: Unsubscribe[] = [];
    for (const capability of capabilities) {
      if (!this.cache.supports(deviceId, capability)) continue;
      try {
        const instance = device.makeCapabilityInstance(capability, (value: unknown) => {
          this.cache.applyExternalChange(deviceId, capability, value);
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
   * outlives the controller that created it (§12).
   */
  async unsubscribeAll(): Promise<void> {
    for (const timer of this.pendingChecks) clearTimeout(timer);
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
      this.cache.initialise(deviceId, {
        onoff: device.capabilitiesObj?.onoff?.value,
        dim: device.capabilitiesObj?.dim?.value,
        light_temperature: device.capabilitiesObj?.light_temperature?.value,
      });
    } catch (error) {
      this.recordFailure(deviceId, 'onoff', error);
    }
  }

  private recordFailure(deviceId: string, capability: Capability, error: unknown): void {
    const message = (error as Error)?.message ?? String(error);
    this.recentFailures.push({ deviceId, capability, message, at: Date.now() });
    if (this.recentFailures.length > 50) this.recentFailures.shift();

    const key = `${deviceId}:${capability}`;
    const now = Date.now();
    const last = this.lastLoggedAt.get(key) ?? 0;
    if (now - last > 60_000) {
      this.lastLoggedAt.set(key, now);
      this.log(`Write failed for ${deviceId} (${capability}): ${message}`);
    }
  }

  failures(): TargetFailure[] {
    return [...this.recentFailures];
  }
}
