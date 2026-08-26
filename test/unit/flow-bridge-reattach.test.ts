import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import { carryForwardFlows } from '../../lib/profiles/controller-profile';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { ManagedFlowReference, ControllerProfile } from '../../lib/profiles/controller-profile';
import type { SelectableInput } from '../../lib/inputs/selectable-input';

/**
 * One-tap re-attach, at the seam where it actually broke.
 *
 * On BILRESA the remote must be removed and re-added after a Homey restart, and
 * a controller's whole value is that the mapping survives that. The flows do not:
 * a trigger card id embeds the source DEVICE id, so every generated flow becomes
 * unmatchable the moment the device id changes.
 *
 * The bug these tests pin down: the old references were carried forward into the
 * re-attached profile, sync() then compared the old trigger id against the newly
 * compiled one, hasBeenUserEdited() said "a user changed this", and the flows were
 * left alone — so nothing was created for the new remote and the controller landed
 * in repair claiming an edit the user never made.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const CONTROLLER = 'ctrl-1';

const cardId = (shortId: string) => `${APP_ID}:${shortId}`;

const OLD_DEVICE = 'device-before-readd';
const NEW_DEVICE = 'device-after-readd';

/** The binding key is derived from the card SHORT id, so it survives a re-add. */
const BINDING_KEY = 'switch_initial_press_multi|press';

function inputOn(deviceId: string): SelectableInput {
  const triggerId = `homey:device:${deviceId}:switch_initial_press_multi`;
  return {
    key: BINDING_KEY,
    controlId: 'button-1',
    label: 'Button 1 — Press',
    action: 'press',
    carriesMagnitude: false,
    binding: {
      kind: 'flow_fixed',
      cardId: triggerId,
      cardOwnerUri: `homey:flowcardtrigger:${triggerId}`,
      args: {},
    },
  };
}

/** A generated flow as it sits on the Homey, triggering on `deviceId`. */
function liveFlow(id: string, deviceId: string) {
  return {
    id,
    name: 'Lightkeeper — BILRESA: Button 1 — Press',
    trigger: { id: `homey:device:${deviceId}:switch_initial_press_multi` },
    actions: [{
      id: cardId('bridge_event'),
      args: { controller: CONTROLLER, event_key: BINDING_KEY },
      droptoken: null,
    }],
  };
}

function reference(flowId: string, fingerprint: string): ManagedFlowReference {
  return {
    flowId,
    bindingKey: BINDING_KEY,
    variantKey: 'fixed',
    fingerprint,
    managedVersion: 1,
    createdAt: 1,
  };
}

function harness(flows: Record<string, unknown>) {
  const created: any[] = [];
  const deleted: string[] = [];
  let nextId = 100;

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => flows,
      getFlowFolders: async () => ({
        f: { id: 'folder-1', name: 'Lightkeeper', parent: null },
      }),
      createFlowFolder: async ({ flowfolder }: { flowfolder: any }) => {
        nextId += 1;
        return { id: `folder-${nextId}`, ...flowfolder };
      },
      updateFlowFolder: async () => ({}),
      updateFlow: async () => ({}),
      deleteFlowFolder: async () => ({}),
      createFlow: async ({ flow }: { flow: any }) => {
        created.push(flow);
        nextId += 1;
        return { id: `flow-${nextId}` };
      },
      deleteFlow: async ({ id }: { id: string }) => { deleted.push(id); },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return { bridge: new FlowBridgeManager(api, APP_ID, () => { /* quiet */ }), created, deleted };
}

const syncRequest = (deviceId: string, existing: ManagedFlowReference[], fingerprint: string) => ({
  controllerId: CONTROLLER,
  sourceName: 'BILRESA',
  deviceName: 'Hallway button',
  fingerprint,
  mapped: [inputOn(deviceId)],
  existing,
});

describe('sync after a re-attach', () => {
  test('creates flows against the new device when no references are carried over', async () => {
    // The old flow is still on the Homey — nothing has deleted it at this point.
    const h = harness({ 'flow-1': liveFlow('flow-1', OLD_DEVICE) });

    const result = await h.bridge.sync(syncRequest(NEW_DEVICE, [], 'fp-1'));

    assert.equal(result.created, 1);
    assert.deepEqual(result.userEdited, [], 'a re-attach is not a user edit');
    assert.equal(h.created.length, 1);
    assert.equal(
      h.created[0].trigger.id,
      `homey:device:${NEW_DEVICE}:switch_initial_press_multi`,
      'the new flow must trigger on the re-added device',
    );
    assert.equal(result.references[0].bindingKey, BINDING_KEY);
  });

  test('carrying the old references over is what produced the false "user edited"', async () => {
    const h = harness({ 'flow-1': liveFlow('flow-1', OLD_DEVICE) });

    // Exactly what device.applyProfile used to do: restore the previous
    // managedFlows regardless of the source having changed.
    const result = await h.bridge.sync(syncRequest(NEW_DEVICE, [reference('flow-1', 'fp-1')], 'fp-1'));

    assert.deepEqual(result.userEdited, ['flow-1']);
    assert.equal(result.created, 0, 'the new remote got no flows at all');
    // Left as documentation of the failure mode carryForwardFlows() prevents:
    // if this ever passes with created > 0, the guard is no longer needed.
  });

  test('an unchanged source still reuses its flows rather than recreating them', async () => {
    const h = harness({ 'flow-1': liveFlow('flow-1', OLD_DEVICE) });

    const result = await h.bridge.sync(syncRequest(OLD_DEVICE, [reference('flow-1', 'fp-1')], 'fp-1'));

    assert.equal(result.reused, 1);
    assert.equal(result.created, 0);
    assert.deepEqual(h.created, []);
    assert.deepEqual(result.userEdited, []);
  });
});

describe('carryForwardFlows', () => {
  const profile = (deviceId: string, flows: ManagedFlowReference[]): ControllerProfile => ({
    schemaVersion: 1,
    enabled: true,
    source: { deviceId, eventSurfaceFingerprint: 'fp-1', driverId: 'matter_bilresa_scroll_wheel' },
    target: { kind: 'devices', deviceIds: ['light-1'] },
    mappings: [{ id: 'r1', function: 'toggle', inputKey: BINDING_KEY, target: null }],
    behavior: { ...DEFAULT_BEHAVIOR },
    managedFlows: flows,
    catalogue: [inputOn(deviceId)],
  });

  test('keeps the references while the source device is the same', () => {
    const previous = profile(OLD_DEVICE, [reference('flow-1', 'fp-1')]);
    const next = profile(OLD_DEVICE, []);

    const { profile: merged, obsolete } = carryForwardFlows(previous, next);

    assert.equal(merged.managedFlows.length, 1);
    assert.equal(merged.managedFlows[0].flowId, 'flow-1');
    assert.deepEqual(obsolete, [], 'nothing to delete when the remote has not moved');
  });

  test('hands the references back for deletion when the source changed', () => {
    const previous = profile(OLD_DEVICE, [reference('flow-1', 'fp-1')]);
    const next = profile(NEW_DEVICE, []);

    const { profile: merged, obsolete } = carryForwardFlows(previous, next);

    assert.deepEqual(merged.managedFlows, [], 'the re-attached profile starts clean');
    assert.equal(obsolete.length, 1);
    assert.equal(obsolete[0].flowId, 'flow-1');
  });

  test('preserves mappings and targets across a re-attach', () => {
    const previous = profile(OLD_DEVICE, [reference('flow-1', 'fp-1')]);
    const next = profile(NEW_DEVICE, []);

    const { profile: merged } = carryForwardFlows(previous, next);

    // The whole point of re-attach: only the device id moves.
    assert.deepEqual(merged.mappings, previous.mappings);
    assert.deepEqual(merged.target, previous.target);
    assert.equal(merged.source.deviceId, NEW_DEVICE);
  });

  test('a first save has nothing to carry and nothing to delete', () => {
    const { profile: merged, obsolete } = carryForwardFlows(null, profile(NEW_DEVICE, []));

    assert.deepEqual(merged.managedFlows, []);
    assert.deepEqual(obsolete, []);
  });
});
