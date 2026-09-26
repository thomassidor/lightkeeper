import Homey from 'homey';

import {
  DeviceLifecycle,
  type DeviceOwner,
  type DeviceRegistry,
  type DeviceRuntime,
  type PlanMigration,
} from './device-lifecycle';
import type { ControllerState } from '../profiles/controller-profile';
import { CONTROL_CAPABILITY, type ControlMode } from '../pairing/control-choice';
import { translatorFor } from '../support/i18n';

/**
 * The `Homey.Device` half of a Lightkeeper virtual device: the SDK entry points,
 * and nothing else.
 *
 * Everything with behaviour lives in `DeviceLifecycle`, which takes its host as
 * an argument. The split is not taste — `require('homey')` resolves only on a
 * Homey, so anything in a class that extends `Homey.Device` cannot be imported
 * by a test at all, and the transaction ordering this phase is about would have
 * been provable on hardware only. This file is thin enough to read instead.
 *
 * A subclass supplies its data (`storeKey`, `missingKey`, migration, registry)
 * and its real differences; the defaults below are the common answers.
 */
export type { DeviceRegistry, DeviceRuntime, PlanMigration } from './device-lifecycle';

export abstract class LightkeeperDevice<
  TPlan,
  // No default on TRuntime: a default here could not reference TRuntimePlan,
  // which is declared after it, and every subclass names its runtime anyway.
  TRuntime extends DeviceRuntime<TRuntimePlan>,
  TRuntimePlan = TPlan,
> extends Homey.Device implements DeviceOwner<TPlan, TRuntime, TRuntimePlan> {

  abstract readonly storeKey: string;
  abstract readonly missingKey: string;
  readonly availableWhenDisabled: boolean = false;
  readonly withPauseSwitch: boolean = false;
  /**
   * Empty here and overridden by the four device types that compute something.
   *
   * A Light Remote is the one that keeps the default: it has no desired state to
   * publish, only the last thing somebody pressed. See `DeviceOwner` for why the
   * list exists at all when `driver.compose.json` already names them.
   */
  readonly valueCapabilities: readonly string[] = [];
  /**
   * Empty here, and overridden by the three engine device types — the only ones
   * with a "How Lightkeeper controls your lights" choice to put on the tile.
   */
  readonly controlModes: readonly ControlMode[] = [];

  abstract migrate(raw: unknown): PlanMigration<TPlan>;
  abstract registry(): DeviceRegistry<TPlan, TRuntime>;
  abstract planOf(runtime: TRuntime, base: TPlan | null): TPlan;

  /**
   * Identity, which is right for every device type whose store and runtime agree
   * on a shape — three of the four. A circadian light overrides it; see
   * `DeviceRuntime` for the bug that the absence of this hook shipped.
   *
   * The cast is the price of the default: `TRuntimePlan` defaults to `TPlan`, and
   * a subclass that widens it must override this, which the generic constraint on
   * `TRuntime` is what forces.
   */
  planForRuntime(plan: TPlan): TRuntimePlan { return plan as unknown as TRuntimePlan; }

  planEnabled(_plan: TPlan): boolean { return true; }
  withEnabled(plan: TPlan, _enabled: boolean): TPlan { return plan; }
  /** Overridden by the two types that own Flows. See DeviceOwner.rawFlowRefs. */
  rawFlowRefs(): unknown { return []; }
  async prepareApply(_previous: TPlan | null, incoming: TPlan): Promise<TPlan> { return incoming; }
  /** Overridden by the controller only. See DeviceOwner.afterApply. */
  async afterApply(_previous: TPlan | null, _committed: TPlan): Promise<void> { /* nothing to finish */ }

  /** Constructed here rather than in a subclass so every type gets it. */
  protected readonly lifecycle = new DeviceLifecycle<TPlan, TRuntime, TRuntimePlan>(this);

  protected get app(): any {
    return this.homey.app;
  }

  get deviceId(): string {
    return this.lifecycle.deviceId;
  }

  // ---- the two SDK spellings lib/ cannot reach on its own -------------------

  /** Plural-aware: a counted StateDetail picks its form here (lib/support/i18n.ts). */
  translate(key: string, tokens?: Record<string, string | number>): string {
    return translatorFor(this.homey)(key, tokens);
  }

  async removeFlows(refs: unknown[]): Promise<number> {
    return this.app.bridge.removeAll(refs);
  }

  forgetFlowJournal(): void {
    this.app.bridge.forgetOwner(this.deviceId);
  }

  // ---- SDK entry points ----------------------------------------------------

  override async onInit(): Promise<void> {
    if (this.withPauseSwitch) {
      this.registerCapabilityListener('onoff', async (value: boolean) => this.lifecycle.setEnabled(value));
    }
    try {
      await this.lifecycle.init();
    } finally {
      // AFTER init, because init is what adds this capability to a device paired
      // before it existed (platform §18) — and the SDK throws on a listener for a
      // capability the device does not have, which failed `onInit` on every
      // engine device paired before 0.6.6. `finally`, so a device whose plan
      // could not be registered still answers its own picker; the guard, so one
      // whose row could not be added still starts.
      if (this.controlModes.length > 0 && this.hasCapability(CONTROL_CAPABILITY)) {
        this.registerCapabilityListener(CONTROL_CAPABILITY, async (value: unknown) => this.lifecycle.setControlMode(value));
      }
    }
  }

  /**
   * The picker's `values` for THIS device type: the capability's own, from the
   * generated manifest, narrowed to `controlModes`. What `capabilitiesOptions`
   * gives a device the driver pairs, rebuilt for one `addCapability` added.
   */
  controlPickerValues(): unknown[] {
    const values: unknown = this.homey.manifest?.capabilities?.[CONTROL_CAPABILITY]?.values;
    if (!Array.isArray(values)) return [];
    return values.filter(value => this.controlModes.includes((value as { id?: unknown })?.id as ControlMode));
  }

  /** Called by the pair/repair session when the user saves. */
  async applyPlan(plan: TPlan): Promise<void> {
    return this.lifecycle.apply(plan);
  }

  override async onRenamed(): Promise<void> {
    return this.lifecycle.renamed();
  }

  override async onDeleted(): Promise<void> {
    return this.lifecycle.deleted();
  }

  override async onUninit(): Promise<void> {
    return this.lifecycle.uninit();
  }

  /** Exposed for the diagnostics path, which reports a device's own verdict. */
  availabilityFor(state: ControllerState): boolean {
    return this.lifecycle.availabilityFor(state);
  }
}
