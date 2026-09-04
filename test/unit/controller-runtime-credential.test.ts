import { test, describe } from 'node:test';
import { ownsNothing, zoneLights } from '../support/fake-catalog';
import assert from 'node:assert/strict';

import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { DeviceCatalog, CatalogDevice } from '../../lib/device-catalog';
import type { SourceDiscoveryService } from '../../lib/source-discovery-service';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { ControllerProfile, ControllerState } from '../../lib/profiles/controller-profile';
import type { SelectableInput } from '../../lib/inputs/selectable-input';

/**
 * What happens to a live controller when the API key comes back.
 *
 * A key holds a single session and dies routinely (platform §2), so
 * "re-enter a key" is an ordinary path, not an edge case. Reconciling the flows
 * on the new key is only half of it: the controller has already been marked
 * needs_credential and its device made unavailable, and setState is
 * change-gated, so without an explicit re-check it stays unavailable until the
 * app restarts. From the outside that is indistinguishable from the new key
 * being bad too.
 *
 * assessHealth() deliberately never declares a controller ready. These tests pin
 * down the one exception — recovery out of needs_credential — and that it still
 * defers to the monitor when something else is genuinely wrong.
 */

const SOURCE_ID = 'remote-1';
const LIGHT_ID = 'light-1';
const FINGERPRINT = 'fp-1';
const BINDING_KEY = 'n2_on|press';

function input(): SelectableInput {
  return {
    key: BINDING_KEY,
    controlId: 'up',
    label: 'Higher brightness — Press',
    action: 'press',
    carriesMagnitude: false,
    binding: {
      kind: 'flow_fixed',
      cardId: `homey:device:${SOURCE_ID}:n2_on`,
      cardOwnerUri: `homey:flowcardtrigger:homey:device:${SOURCE_ID}:n2_on`,
      fixedArgs: {},
    },
  };
}

function device(id: string, capabilities: string[]): CatalogDevice {
  return {
    id,
    name: id,
    class: 'light',
    virtualClass: null,
    zone: 'zone-1',
    zoneName: 'Kitchen',
    driverId: 'driver-1',
    ownerUri: 'homey:app:com.ikea.tradfri',
    ownerName: 'IKEA',
    available: true,
    capabilities,
    capabilitiesObj: Object.fromEntries(capabilities.map(c => [c, { value: c === 'onoff' ? true : 0.5 }])),
  };
}

function profile(): ControllerProfile {
  return {
    schemaVersion: 1,
    enabled: true,
    source: {
      deviceId: SOURCE_ID,
      driverId: 'driver-1',
      ownerAppId: 'homey:app:com.ikea.tradfri',
      eventSurfaceFingerprint: FINGERPRINT,
      name: 'Kitchen STYRBAR',
    },
    target: { kind: 'devices', deviceIds: [LIGHT_ID] },
    mappings: [{ id: 'r1', function: 'toggle', inputKey: BINDING_KEY, target: null }],
    behavior: { ...DEFAULT_BEHAVIOR },
    // Non-empty: the health monitor only reports needs_credential for a
    // controller that actually has flows to maintain.
    managedFlows: [{
      flowId: 'flow-1', bindingKey: BINDING_KEY, variantKey: 'fixed',
      fingerprint: FINGERPRINT, managedVersion: 1, createdAt: 1,
    }],
    catalogue: [input()],
  };
}

/**
 * The runtime's five dependencies, faked at their own interfaces. The health
 * monitor is the REAL one, so the needs_credential rule under test is the
 * shipping rule rather than a restatement of it.
 */
function harness(options: { sourcePresent?: boolean } = {}) {
  let credentialValid = false;
  let sourcePresent = options.sourcePresent ?? true;
  const states: Array<{ state: ControllerState; detail?: unknown }> = [];
  const syncCalls: unknown[] = [];

  const devices = () => [
    ...(sourcePresent ? [device(SOURCE_ID, ['onoff'])] : []),
    device(LIGHT_ID, ['onoff', 'dim']),
  ];

  const catalog = {
    device: async (id: string) => devices().find(d => d.id === id),
    allDevices: async () => devices(),
    devicesInZone: async () => devices(),
    lightsInZone: zoneLights(async () => devices()),
    isOwnDevice: ownsNothing,
  } as unknown as DeviceCatalog;

  const discovery = {
    discover: async () => ({ inputs: [input()], fingerprint: FINGERPRINT, rejected: [] }),
  } as unknown as SourceDiscoveryService;

  const bridge = {
    /**
     * The real one single-flights per device (see FlowBridgeManager). Straight
     * through here on purpose: coalescing has its own tests against the real
     * class, and a double that reimplemented it would be testing the double.
     */
    reconcile: async (_deviceId: string, pass: () => Promise<unknown>) => pass(),
    sync: async (request: unknown) => {
      syncCalls.push(request);
      // Flow writes are the only thing the key gates.
      if (!credentialValid) throw new Error('403 Missing Scopes');
      return {
        references: profile().managedFlows,
        created: 0, reused: 1, deleted: 0, userEdited: [], staleReplacements: [],
        unsupported,
      };
    },
  } as unknown as FlowBridgeManager;

  const api = {
    read: async () => ({
      devices: {
        getDevice: async () => ({
          makeCapabilityInstance: () => ({ destroy: () => { /* nothing to release */ } }),
        }),
      },
    }),
    track: (fn: () => void) => fn,
    credentials: {
      getStatus: () => ({ present: true, valid: credentialValid, ...(credentialValid ? {} : { failure: 'session_expired' as const }) }),
    },
  } as unknown as HomeyApiService;

  let unsupported: Array<{ bindingKey: string; reason: string }> = [];

  const health = new HealthMonitor(catalog, discovery, () => credentialValid);

  const manager = new ControllerRuntimeManager({
    api, catalog, discovery, bridge, health, log: () => { /* quiet */ },
  });

  return {
    manager,
    states,
    syncCalls,
    declineControl: (bindingKey: string, reason: string) => { unsupported = [{ bindingKey, reason }]; },
    acceptEveryControl: () => { unsupported = []; },
    grantCredential: () => { credentialValid = true; },
    loseCredential: () => { credentialValid = false; },
    loseSource: () => { sourcePresent = false; },
    register: async () => manager.register(
      'ctrl-1',
      profile(),
      (state, detail) => { states.push({ state, ...(detail ? { detail } : {}) }); },
    ),
  };
}

describe('recovering from needs_credential', () => {
  test('a controller with no usable key reports needs_credential', async () => {
    const h = harness();
    const runtime = await h.register();

    assert.equal(runtime.currentState, 'needs_credential');
    assert.equal(h.states.at(-1)?.state, 'needs_credential');

    await h.manager.destroyAll();
  });

  test('a valid key returns it to ready without a restart', async () => {
    const h = harness();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'needs_credential');

    h.grantCredential();
    await h.manager.onCredentialChange();

    assert.equal(runtime.currentState, 'ready', 'the device would otherwise stay unavailable');
    assert.equal(h.states.at(-1)?.state, 'ready');

    await h.manager.destroyAll();
  });

  test('the mappings and managed flows survive the recovery', async () => {
    const h = harness();
    const runtime = await h.register();

    h.grantCredential();
    await h.manager.onCredentialChange();

    assert.equal(runtime.currentProfile.mappings.length, 1);
    assert.equal(runtime.currentProfile.mappings[0].inputKey, BINDING_KEY);
    assert.equal(runtime.currentProfile.managedFlows.length, 1);

    await h.manager.destroyAll();
  });

  test('recovery reconciles the flows the failed attempt could not create', async () => {
    const h = harness();
    await h.register();
    const before = h.syncCalls.length;

    h.grantCredential();
    await h.manager.onCredentialChange();

    assert.equal(h.syncCalls.length > before, true, 'a recovered key must re-sync');

    await h.manager.destroyAll();
  });

  test('a genuinely broken controller is NOT declared ready', async () => {
    const h = harness();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'needs_credential');

    // The remote was unpaired while the key was dead. A good key does not fix
    // that, and the recovery must take the monitor's word for it.
    h.loseSource();
    h.grantCredential();
    await h.manager.onCredentialChange();

    assert.equal(runtime.currentState, 'needs_repair');

    await h.manager.destroyAll();
  });

  test('an invalid credential is never reconciled against', async () => {
    const h = harness();
    const runtime = await h.register();
    const before = h.syncCalls.length;

    await h.manager.onCredentialChange();

    assert.equal(runtime.currentState, 'needs_credential');
    assert.equal(h.syncCalls.length, before, 'no point writing flows with a dead key');

    await h.manager.destroyAll();
  });

  test('losing the key marks a ready controller straight away', async () => {
    const h = harness();
    h.grantCredential();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'ready');

    // The mirror of the recovery above: a controller that goes on reporting
    // ready while its Flow maintenance is dead is telling the user something
    // untrue, and would do so until the next restart.
    h.loseCredential();
    await h.manager.onCredentialChange();

    assert.equal(runtime.currentState, 'needs_credential');

    await h.manager.destroyAll();
  });

  test('a credential change does not churn the state of a healthy controller', async () => {
    const h = harness();
    h.grantCredential();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'ready');

    const states = h.states.length;
    await h.manager.onCredentialChange();

    assert.equal(runtime.currentState, 'ready');
    assert.equal(h.states.length, states, 'no state churn on an already-ready controller');

    await h.manager.destroyAll();
  });
});

/**
 * A control the compiler declined, at RECONCILE rather than at save.
 *
 * The save-time preflight catches the ordinary case, but a profile that
 * compiled once can stop compiling: a re-attach onto a device whose card
 * exposes a wider range, or a firmware that widened one under an unchanged
 * device. The mapping row still reads as configured; the gesture does nothing.
 * Before this it was one line in the app log and nothing else.
 */
describe('a control the compiler declines', () => {
  test('puts the controller in repair and names the control', async () => {
    const h = harness();
    h.grantCredential();
    h.declineControl('wheel|turn', 'Range expansion would need 18 flow variants, above the ceiling of 12');

    const runtime = await h.register();
    await runtime!.reconcileFlows();

    const repair = h.states.filter(entry => entry.state === 'needs_repair').at(-1);
    assert.ok(repair, 'the device must not sit there looking ready');
    assert.equal((repair!.detail as any)?.key, 'state.unsupportedMapping');
    assert.equal((repair!.detail as any)?.tokens?.controls, 'wheel|turn');
  });

  test('and it shows up in diagnostics', async () => {
    const h = harness();
    h.grantCredential();
    h.declineControl('wheel|turn', 'above the ceiling of 12');

    const runtime = await h.register();
    await runtime!.reconcileFlows();

    const declined = runtime!.diagnostics().unsupported as Array<{ bindingKey: string }>;
    assert.deepEqual(declined.map(item => item.bindingKey), ['wheel|turn']);
  });

  test('a later reconcile that compiles clean clears it', async () => {
    const h = harness();
    h.grantCredential();
    h.declineControl('wheel|turn', 'above the ceiling of 12');

    const runtime = await h.register();
    await runtime!.reconcileFlows();
    assert.equal((runtime!.diagnostics().unsupported as unknown[]).length, 1);

    h.acceptEveryControl();
    await runtime!.reconcileFlows();
    assert.deepEqual(runtime!.diagnostics().unsupported, [], 'the repair took');
  });

  test('a clean reconcile never mentions it', async () => {
    const h = harness();
    h.grantCredential();
    const runtime = await h.register();
    await runtime!.reconcileFlows();

    assert.deepEqual(runtime!.diagnostics().unsupported, []);
    assert.equal(
      h.states.some(entry => (entry.detail as any)?.key === 'state.unsupportedMapping'), false,
    );
  });
});
