import Homey from 'homey';

import {
  DeviceLifecycle,
  type DeviceOwner,
  type DeviceRegistry,
  type DeviceRuntime,
  type PlanMigration,
} from './device-lifecycle';
import type { ControllerState, ManagedFlowReference } from '../profiles/controller-profile';

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
  TRuntime extends DeviceRuntime = DeviceRuntime,
> extends Homey.Device implements DeviceOwner<TPlan, TRuntime> {

  abstract readonly storeKey: string;
  abstract readonly missingKey: string;
  readonly availableWhenDisabled: boolean = false;
  readonly withPauseSwitch: boolean = false;

  abstract migrate(raw: unknown): PlanMigration<TPlan>;
  abstract registry(): DeviceRegistry<TPlan, TRuntime>;
  abstract planOf(runtime: TRuntime): TPlan;

  planEnabled(_plan: TPlan): boolean { return true; }
  withEnabled(plan: TPlan, _enabled: boolean): TPlan { return plan; }
  flowRefs(_plan: TPlan): ManagedFlowReference[] { return []; }
  async prepareApply(_previous: TPlan | null, incoming: TPlan): Promise<TPlan> { return incoming; }

  /** Constructed here rather than in a subclass so every type gets it. */
  protected readonly lifecycle = new DeviceLifecycle<TPlan, TRuntime>(this);

  protected get app(): any {
    return this.homey.app;
  }

  get deviceId(): string {
    return this.lifecycle.deviceId;
  }

  // ---- the two SDK spellings lib/ cannot reach on its own -------------------

  translate(key: string, tokens?: Record<string, string | number>): string {
    return this.homey.__(key, tokens ?? {});
  }

  async removeFlows(refs: ManagedFlowReference[]): Promise<number> {
    return this.app.bridge.removeAll(refs);
  }

  // ---- SDK entry points ----------------------------------------------------

  override async onInit(): Promise<void> {
    if (this.withPauseSwitch) {
      this.registerCapabilityListener('onoff', async (value: boolean) => this.lifecycle.setEnabled(value));
    }
    await this.lifecycle.init();
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
