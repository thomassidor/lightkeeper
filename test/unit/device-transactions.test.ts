import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceLifecycle,
  type DeviceOwner,
  type DeviceRegistry,
  type DeviceRuntime,
  type PlanMigration,
} from '../../lib/devices/device-lifecycle';
import type { ControllerState, ManagedFlowReference, StateDetail } from '../../lib/profiles/controller-profile';
import { deferred, settle } from '../support/deferred';

/**
 * The device layer's transactions.
 *
 * These are the tests that could not exist while this logic lived in a class
 * extending `Homey.Device`: `require('homey')` resolves only on a Homey, so the
 * ordering below was previously provable on hardware alone. The host here is a
 * Map and four counters.
 */

interface Plan {
  enabled: boolean;
  value: string;
  refs?: ManagedFlowReference[];
}

interface FakeRuntime extends DeviceRuntime {
  plan: Plan;
  stopped: boolean;
  reconciles: number;
}

const REF: ManagedFlowReference = {
  flowId: 'flow-1',
  bindingKey: 'k',
  variantKey: '',
  fingerprint: 'fp',
  managedVersion: 1,
  createdAt: 0,
};

class FakeRegistry implements DeviceRegistry<Plan, FakeRuntime> {
  readonly live = new Map<string, FakeRuntime>();
  /** Set to reject the NEXT register only. */
  failNext: Error | null = null;
  /** Held open by a test that needs to observe the mid-register window. */
  gate: Promise<void> | null = null;
  registers: Plan[] = [];
  /** Verdicts a register should emit through onStateChange before resolving. */
  emitOnRegister: Array<[ControllerState, StateDetail | undefined]> = [];
  /** Whether a register reports a plan change (reconciliation learning). */
  learnsRefs = true;
  /** What a newly started runtime settles on. */
  settlesOn: [ControllerState, StateDetail | undefined] = ['ready', undefined];

  async register(
    id: string,
    plan: Plan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onPlanChange: (plan: Plan) => Promise<void>,
    _displayName: () => string,
  ): Promise<FakeRuntime> {
    this.registers.push(plan);
    if (this.gate) await this.gate;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    const runtime: FakeRuntime = {
      plan,
      stopped: false,
      reconciles: 0,
      currentState: this.settlesOn[0],
      currentDetail: this.settlesOn[1],
      destroy: async () => { runtime.stopped = true; },
      updatePlan: async (next: Plan) => { runtime.plan = next; },
      reconcileFlows: async () => { runtime.reconciles += 1; },
    };
    // Only what is running goes into the map — the managers' own rule.
    this.live.set(id, runtime);

    for (const [state, detail] of this.emitOnRegister) onStateChange(state, detail);
    if (this.learnsRefs) {
      // Reconciliation learning something about its own plan, as the real
      // runtimes do from inside start().
      runtime.plan = { ...plan, refs: [REF] };
      await onPlanChange(runtime.plan);
    }
    return runtime;
  }

  async unregister(id: string): Promise<void> {
    this.live.delete(id);
  }

  get(id: string): FakeRuntime | undefined {
    return this.live.get(id);
  }
}

class FakeOwner implements DeviceOwner<Plan, FakeRuntime> {
  readonly store = new Map<string, unknown>();
  readonly logs: string[] = [];
  available: boolean | null = null;
  unavailableText: string | null = null;
  capability: unknown = null;
  removedFlows: ManagedFlowReference[][] = [];
  /** Set to make the NEXT store write fail. */
  failStoreWrite: Error | null = null;
  migrateResult: PlanMigration<Plan> | Error | null = null;

  readonly storeKey = 'plan';
  readonly missingKey = 'state.noConfiguration';
  availableWhenDisabled = false;
  withPauseSwitch = true;

  constructor(readonly registryImpl: FakeRegistry) {}

  getData(): any { return { id: 'lk-test-1' }; }
  getName(): string { return 'Test device'; }
  getStoreValue(key: string): any { return this.store.get(key); }

  async setStoreValue(key: string, value: unknown): Promise<unknown> {
    if (this.failStoreWrite) {
      const error = this.failStoreWrite;
      this.failStoreWrite = null;
      throw error;
    }
    this.store.set(key, value);
    return value;
  }

  async setAvailable(): Promise<void> {
    this.available = true;
    this.unavailableText = null;
  }

  async setUnavailable(message?: string): Promise<void> {
    this.available = false;
    this.unavailableText = message ?? null;
  }

  async setCapabilityValue(_id: string, value: unknown): Promise<void> {
    this.capability = value;
  }

  log(...args: unknown[]): void { this.logs.push(args.join(' ')); }
  error(...args: unknown[]): void { this.logs.push(`ERROR ${args.join(' ')}`); }
  translate(key: string): string { return key; }

  async removeFlows(refs: ManagedFlowReference[]): Promise<number> {
    this.removedFlows.push(refs);
    return refs.length;
  }

  migrate(raw: unknown): PlanMigration<Plan> {
    if (this.migrateResult instanceof Error) throw this.migrateResult;
    if (this.migrateResult) return this.migrateResult;
    return { plan: raw as Plan, migrated: false, fromVersion: 1 };
  }

  registry(): DeviceRegistry<Plan, FakeRuntime> { return this.registryImpl; }
  planOf(runtime: FakeRuntime): Plan { return runtime.plan; }
  planEnabled(plan: Plan): boolean { return plan.enabled; }
  withEnabled(plan: Plan, enabled: boolean): Plan { return { ...plan, enabled }; }
  flowRefs(plan: Plan): ManagedFlowReference[] { return plan.refs ?? []; }
  async prepareApply(_previous: Plan | null, incoming: Plan): Promise<Plan> { return incoming; }
}

function harness() {
  const registry = new FakeRegistry();
  const owner = new FakeOwner(registry);
  const lifecycle = new DeviceLifecycle<Plan, FakeRuntime>(owner);
  /** The queued verdicts are fire-and-forget; tests need them settled. */
  const drain = () => settle(4);
  return { registry, owner, lifecycle, drain };
}

describe('apply is transactional', () => {
  test('the candidate plan reaches the store only once the runtime is running', async () => {
    const { registry, owner, lifecycle } = harness();
    const gate = deferred();
    registry.gate = gate.promise;

    const applying = lifecycle.apply({ enabled: true, value: 'new' });
    await settle();

    assert.equal(owner.store.get('plan'), undefined, 'nothing may be stored mid-register');

    registry.gate = null;
    gate.resolve();
    await applying;

    assert.equal((owner.store.get('plan') as Plan).value, 'new');
  });

  test('a failed start leaves the previous plan stored and running', async () => {
    const { registry, owner, lifecycle } = harness();
    owner.store.set('plan', { enabled: true, value: 'old' });
    registry.failNext = new Error('start blew up');

    await assert.rejects(lifecycle.apply({ enabled: true, value: 'new' }), /start blew up/);

    assert.equal((owner.store.get('plan') as Plan).value, 'old');
    assert.equal(registry.get('lk-test-1')?.plan.value, 'old', 'the old runtime is back');
  });

  test('a failed start is not dispatchable', async () => {
    const { registry, lifecycle } = harness();
    registry.failNext = new Error('nope');

    await assert.rejects(lifecycle.apply({ enabled: true, value: 'new' }), /nope/);

    assert.equal(registry.get('lk-test-1'), undefined, 'nothing half-built is reachable');
  });

  test('a failed FIRST save says the device is unconfigured', async () => {
    const { registry, owner, lifecycle } = harness();
    registry.failNext = new Error('nope');

    await assert.rejects(lifecycle.apply({ enabled: true, value: 'new' }), /nope/);

    assert.equal(owner.available, false);
    assert.equal(owner.unavailableText, 'state.noConfiguration');
  });

  test('the apply keeps what reconciliation learned', async () => {
    const { owner, lifecycle } = harness();
    await lifecycle.apply({ enabled: true, value: 'new' });

    // The registry's onPlanChange adds a flow reference during start; the apply
    // must not write the merged candidate back over the top of it.
    assert.deepEqual((owner.store.get('plan') as Plan).refs, [REF]);
  });
});

describe('verdict ordering', () => {
  test('a late state callback cannot flip an unavailable device to available', async () => {
    const { registry, owner, lifecycle, drain } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });

    // The register emits the stale 'ready' verdict; the apply's own publish of
    // the runtime's settled state comes after it and must win.
    registry.settlesOn = ['needs_repair', { key: 'state.sourceGone' }];
    registry.emitOnRegister = [['ready', undefined]];
    await lifecycle.apply({ enabled: true, value: 'v2' });
    await drain();

    assert.equal(owner.available, false, 'the newest verdict wins');
    assert.equal(owner.unavailableText, 'state.sourceGone');
  });

  test('a verdict arriving after a newer one is dropped', async () => {
    const { registry, owner, lifecycle, drain } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });

    lifecycle.onRuntimeState('ready', undefined);
    lifecycle.onRuntimeState('needs_repair', { key: 'state.needsRepair' });
    await drain();
    assert.equal(owner.available, false);

    // The reverse order, to show it is order and not severity that decides.
    lifecycle.onRuntimeState('needs_repair', { key: 'state.needsRepair' });
    lifecycle.onRuntimeState('ready', undefined);
    await drain();
    assert.equal(owner.available, true);
    assert.equal(registry.get('lk-test-1')?.stopped, false);
  });

  test('a partial device stays available and says which lights are missing', async () => {
    const { owner, lifecycle, drain } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });

    lifecycle.onRuntimeState('partial', { key: 'state.someTargets', tokens: { count: 1, total: 3 } });
    await drain();

    assert.equal(owner.available, true);
    assert.ok(owner.logs.some(line => line.includes('Partial: state.someTargets')));
  });
});

describe('awaited persistence', () => {
  test('a persistence failure reports repair rather than a clean save', async () => {
    const { registry, owner, lifecycle, drain } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });

    owner.failStoreWrite = new Error('store full');
    lifecycle.onRuntimeState('ready', undefined);
    await drain();

    assert.equal(owner.available, false);
    assert.equal(owner.unavailableText, 'state.persistFailed');
    assert.ok(registry.get('lk-test-1'), 'the runtime keeps running');
  });

  test('a migrated plan is written before the device is registered', async () => {
    const { registry, owner, lifecycle } = harness();
    owner.store.set('plan', { enabled: true, value: 'old-shape' });
    owner.migrateResult = {
      plan: { enabled: true, value: 'migrated' }, migrated: true, fromVersion: 0,
    };

    await lifecycle.init();

    assert.equal((owner.store.get('plan') as Plan).value, 'migrated');
    assert.equal(registry.registers[0]?.value, 'migrated');
  });

  test('a plan that cannot be migrated does not become defaults', async () => {
    const { registry, owner, lifecycle } = harness();
    owner.store.set('plan', { enabled: true, value: 'corrupt' });
    owner.migrateResult = new Error('unknown schema 99');

    await lifecycle.init();

    assert.equal(registry.registers.length, 0);
    assert.equal(owner.available, false);
    assert.equal(owner.unavailableText, 'state.noConfiguration');
  });
});

describe('pause, rename and delete', () => {
  test('interleaved pause calls apply in order', async () => {
    const { registry, owner, lifecycle } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });

    const gate = deferred();
    registry.gate = gate.promise;
    // Both queue behind the same per-device FIFO.
    const first = lifecycle.setEnabled(false);
    const second = lifecycle.setEnabled(true);
    registry.gate = null;
    gate.resolve();
    await Promise.all([first, second]);

    assert.equal((owner.store.get('plan') as Plan).enabled, true, 'the last call wins');
    assert.equal(registry.get('lk-test-1')?.plan.enabled, true);
  });

  test('a paused device keeps the switch when its type allows it', async () => {
    const { owner, lifecycle, drain } = harness();
    owner.availableWhenDisabled = true;
    await lifecycle.apply({ enabled: true, value: 'v' });

    lifecycle.onRuntimeState('disabled', undefined);
    await drain();
    assert.equal(owner.available, true, 'an unavailable device cannot be un-paused');

    owner.availableWhenDisabled = false;
    lifecycle.onRuntimeState('ready', undefined);
    await drain();
    lifecycle.onRuntimeState('disabled', undefined);
    await drain();
    assert.equal(owner.available, false, 'a controller has nothing on its tile');
    assert.equal(owner.unavailableText, 'state.disabled');
  });

  test('a rename reconciles a runtime with Flows and no-ops one without', async () => {
    const { registry, lifecycle } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });
    await lifecycle.renamed();
    assert.equal(registry.get('lk-test-1')?.reconciles, 1);

    delete (registry.get('lk-test-1') as any).reconcileFlows;
    await lifecycle.renamed();
    assert.equal(registry.get('lk-test-1')?.reconciles, 1, 'no Flows, nothing to reach');
  });

  test('deleting a never-registered device still removes its Flows', async () => {
    const { registry, owner, lifecycle } = harness();
    owner.store.set('plan', { enabled: true, value: 'v', refs: [REF] });
    assert.equal(registry.get('lk-test-1'), undefined);

    await lifecycle.deleted();

    assert.deepEqual(owner.removedFlows, [[REF]]);
  });

  test('deleting a running device destroys the runtime and unregisters it', async () => {
    const { registry, owner, lifecycle } = harness();
    await lifecycle.apply({ enabled: true, value: 'v' });
    const runtime = registry.get('lk-test-1')!;

    await lifecycle.deleted();

    assert.equal(runtime.stopped, true);
    assert.equal(registry.get('lk-test-1'), undefined);
    assert.deepEqual(owner.removedFlows, [], 'the runtime owns its own cleanup');
  });
});

describe('availability mapping and state text', () => {
  test('availability per state per device type', () => {
    const { owner, lifecycle } = harness();

    for (const state of ['ready', 'partial'] as ControllerState[]) {
      assert.equal(lifecycle.availabilityFor(state), true);
    }
    for (const state of ['needs_repair', 'needs_credential'] as ControllerState[]) {
      assert.equal(lifecycle.availabilityFor(state), false);
    }

    owner.availableWhenDisabled = false;
    assert.equal(lifecycle.availabilityFor('disabled'), false);
    owner.availableWhenDisabled = true;
    assert.equal(lifecycle.availabilityFor('disabled'), true);
  });

  test('describe prefers a locale key, then verbatim text, then the fallback', () => {
    const { lifecycle } = harness();
    const describe = (detail: StateDetail | undefined) =>
      lifecycle.describe(detail, 'state.needsRepair');

    assert.equal(describe({ key: 'state.sourceGone' }), 'state.sourceGone');
    assert.equal(describe({ text: '404 Not Found: FlowCardAction' }), '404 Not Found: FlowCardAction');
    assert.equal(describe({ key: 'state.sourceGone', text: 'raw' }), 'state.sourceGone');
    assert.equal(describe(undefined), 'state.needsRepair');
  });
});
