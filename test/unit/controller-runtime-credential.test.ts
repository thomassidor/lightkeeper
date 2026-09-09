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

  let lightAvailable = true;
  let userEdited: string[] = [];

  const devices = () => [
    ...(sourcePresent ? [device(SOURCE_ID, ['onoff'])] : []),
    { ...device(LIGHT_ID, ['onoff', 'dim']), available: lightAvailable },
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
        created: 0, reused: 1, deleted: 0, userEdited, staleReplacements: [],
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
    /** Somebody changed a generated Flow in the Flow editor. */
    editFlow: () => { userEdited = ['flow-1']; },
    restoreFlow: () => { userEdited = []; },
    /** A lamp switched off at the wall, or one that has gone unreachable. */
    loseLight: () => { lightAvailable = false; },
    regainLight: () => { lightAvailable = true; },
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

/**
 * The two things that can be wrong are composed, not overwritten.
 *
 * A controller learns about its health from two independent places, on two
 * different triggers: reconciliation (a Flow was edited, a control would not
 * compile, a reference could not be stored) and the lights themselves (how
 * many resolved, how many are unwritable). Both used to be written straight
 * to the visible state by whichever ran last, and `start()`'s order is
 * buildRuntime → reconcileFlows → assessHealth — so the monitor always spoke
 * last.
 *
 * The consequence was silent and bad. A controller told "a Flow was edited,
 * open repair" had that replaced by "1 of 3 lights unavailable": a different
 * problem, a less actionable one, and `partial` also flips the device back to
 * AVAILABLE, so the repair prompt disappears from the tile. One lamp switched
 * off at the wall was enough to trigger it, and it recurred on every
 * `refreshTargets()` and every credential change.
 */
describe('composing a reconcile verdict with a target verdict', () => {
  test('an edited Flow outranks a partial target set', async () => {
    const h = harness();
    h.grantCredential();
    h.editFlow();
    const runtime = await h.register();

    assert.equal(runtime.currentState, 'needs_repair');
    assert.deepEqual(runtime.currentDetail, { key: 'state.flowEdited' });

    // A lamp goes off at the wall. This is the pass that used to overwrite it.
    h.loseLight();
    await runtime.refreshTargets();

    assert.equal(
      runtime.currentState, 'needs_repair',
      'a lost lamp replaced the repair prompt with a lamp count',
    );
    assert.deepEqual(
      runtime.currentDetail, { key: 'state.flowEdited' },
      'and it must still say WHICH problem to act on',
    );

    await h.manager.destroyAll();
  });

  test('and a credential failure outranks the edited Flow', async () => {
    // Repair WRITES Flows (platform §1), so a repair prompt on a dead key
    // sends the user into a flow that cannot possibly complete.
    const h = harness();
    h.editFlow();
    const runtime = await h.register();

    assert.equal(runtime.currentState, 'needs_credential');

    await h.manager.destroyAll();
  });

  test('a new key does not clear a repair the same pass found', async () => {
    const h = harness();
    h.editFlow();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'needs_credential');

    h.grantCredential();
    await h.manager.onCredentialChange();

    assert.equal(
      runtime.currentState, 'needs_repair',
      'the key came back but the edited Flow did not fix itself',
    );
    assert.deepEqual(runtime.currentDetail, { key: 'state.flowEdited' });

    await h.manager.destroyAll();
  });

  test('a lost lamp IS reported once nothing worse is standing', async () => {
    // Nothing wrong with the Flows, so the target verdict is the only one
    // there is and it must reach the user unmodified. One target and it is
    // gone, which is `needs_repair` rather than `partial`: a controller with
    // no usable light left is not partly working.
    const h = harness();
    h.grantCredential();
    h.loseLight();
    const runtime = await h.register();

    assert.equal(runtime.currentState, 'needs_repair');
    assert.notDeepEqual(
      runtime.currentDetail, { key: 'state.flowEdited' },
      'and it says the lamps, because that is what is wrong',
    );

    await h.manager.destroyAll();
  });

  test('and a repair verdict clears when the pass that set it stops finding it', async () => {
    // The other half of ranking: a verdict is assigned EVERY pass, including
    // to nothing. A boolean gate could stop `ready` being declared but could
    // not clear the sentence, so a restored Flow left the tile in repair until
    // the app restarted.
    const h = harness();
    h.grantCredential();
    h.editFlow();
    const runtime = await h.register();
    assert.equal(runtime.currentState, 'needs_repair');

    h.restoreFlow();
    await runtime.reconcileFlows();

    assert.equal(runtime.currentState, 'ready');
    assert.equal(runtime.currentDetail, undefined);

    await h.manager.destroyAll();
  });
});
