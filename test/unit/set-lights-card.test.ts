import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  eligibleTargets,
  intentsFor,
  isPowerChoice,
  planSetLights,
  settingsFrom,
  LEAVE_ALONE,
  type ColourSource,
  type ValueSource,
} from '../../lib/flow/set-lights';
import {
  lightChoices,
  matching,
  parseTargetChoice,
  sourceChoices,
  targetChoiceId,
} from '../../lib/flow/flow-arguments';
import { FlowLightWriter } from '../../lib/flow/light-writer';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import { ownsNothing, zoneLights } from '../support/fake-catalog';
import type { CatalogDevice, DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService, Unsubscribe } from '../../lib/homey-api-service';

/**
 * The `set_lights` card: colour from one Lightkeeper device, brightness from
 * another, into one ordered write.
 *
 * Two promises here are the reason this file exists rather than a couple of
 * assertions bolted onto an existing suite.
 *
 *  - **A lamp that is off is written to only when "switch them on" was chosen.**
 *    It cannot be enforced on the writes, because the write that breaks it is a
 *    `dim` — which carries no `onoff` and turns the lamp on anyway (platform
 *    §12, twenty-five of twenty-five). So it is enforced on the targets, and
 *    the end-to-end test below is what proves the filter is actually the one
 *    the planner is handed.
 *  - **A source device that is gone refuses the whole pass.** Half a set of
 *    settings — the right brightness in last week's colour — is the outcome a
 *    Flow card's untrusted arguments can produce and nothing would report.
 */

function source(values: Record<string, unknown>): ValueSource {
  return { publishedValues: () => values as any };
}

function curve(
  values: Record<string, unknown>,
  color?: { hue: number; saturation: number },
): ColourSource {
  return {
    publishedValues: () => values as any,
    currentValue: () => (color ? { color } : {}),
  };
}

describe('what the card decides to set', () => {
  test('colour comes from one device and brightness from another', () => {
    const plan = planSetLights({
      colour: curve({ [VALUE_CAPABILITIES.temperature]: 0.86 }),
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: [],
    }, 'on');

    assert.equal(plan.refused, undefined);
    assert.deepEqual(plan.intents, [
      { type: 'power', value: true },
      { type: 'temperature_absolute', value: 0.86 },
      { type: 'brightness_absolute', value: 0.26 },
    ]);
  });

  test('the brightness is the device value, not the perceptual one', () => {
    // The board publishes what a lamp is addressed with, so the number that
    // reaches the planner is the same one a user could have dragged into
    // Homey's own "Dim to" as a tag. The two must not be able to disagree.
    const settings = settingsFrom({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: [],
    });
    assert.equal(settings.brightness, 0.26);
    assert.equal(settings.temperature, null);
  });

  test('a palette colour wins over the colour temperature beside it', () => {
    // Both are always present on a coloured stretch — the warmth is what the
    // lamps with no colour capability get (platform §12) — and a lamp told both
    // ends up wherever its mode handling leaves it.
    const plan = planSetLights({
      colour: curve({ [VALUE_CAPABILITIES.temperature]: 0.86 }, { hue: 0.11, saturation: 0.75 }),
      brightness: null,
      missing: [],
    }, 'only_on');

    assert.deepEqual(plan.intents, [
      { type: 'color_absolute', hue: 0.11, saturation: 0.75 },
    ]);
  });

  test('one source alone is a complete answer', () => {
    const plan = planSetLights({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.4 }),
      missing: [],
    }, 'only_on');

    assert.deepEqual(plan.intents, [{ type: 'brightness_absolute', value: 0.4 }]);
  });

  test('a device that has published nothing sets nothing', () => {
    // A runtime that has not ticked yet, or one whose curve carries no
    // brightness because the user did not ask it to adjust one.
    const plan = planSetLights({
      colour: curve({ [VALUE_CAPABILITIES.temperature]: null }),
      brightness: source({ [VALUE_CAPABILITIES.brightness]: null }),
      missing: [],
    }, 'only_on');

    assert.deepEqual(plan.intents, []);
    assert.match(plan.refused ?? '', /nothing was chosen to set/);
  });

  test('but switching them on is still something to do', () => {
    const plan = planSetLights({ colour: null, brightness: null, missing: [] }, 'on');
    assert.deepEqual(plan.intents, [{ type: 'power', value: true }]);
    assert.equal(plan.refused, undefined);
  });

  test('a source that is no longer there refuses the whole pass', () => {
    const plan = planSetLights({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: ['lk-curve-gone'],
    }, 'on');

    assert.deepEqual(plan.intents, []);
    assert.match(plan.refused ?? '', /lk-curve-gone/);
  });

  test('the power choice is validated, never cast', () => {
    assert.equal(isPowerChoice('on'), true);
    assert.equal(isPowerChoice('only_on'), true);
    assert.equal(isPowerChoice('leave'), false);
    assert.equal(isPowerChoice(undefined), false);
    assert.equal(isPowerChoice(1), false);
  });

  test('intentsFor puts the switch first, so the queue can order around it', () => {
    const intents = intentsFor(
      { brightness: 0.3, temperature: 0.8, colour: null }, 'on',
    );
    assert.equal(intents[0]?.type, 'power');
  });
});

describe('which lights a pass may touch', () => {
  const lights = ['a', 'b', 'c'];
  const on = new Set(['a']);

  test('"only lights already on" drops the lamps that are off', () => {
    assert.deepEqual(eligibleTargets(lights, 'only_on', id => on.has(id)), ['a']);
  });

  test('"switch them on" keeps every one of them', () => {
    assert.deepEqual(eligibleTargets(lights, 'on', id => on.has(id)), ['a', 'b', 'c']);
  });

  test('a lamp whose state is unknown counts as off', () => {
    // This runs after a live refresh, so unknown means the lamp did not answer.
    assert.deepEqual(eligibleTargets(lights, 'only_on', () => false), []);
  });
});

describe('what the card offers to choose from', () => {
  const device = (over: Partial<CatalogDevice> & { id: string }): CatalogDevice => ({
    name: over.id,
    class: 'light',
    virtualClass: null,
    zone: 'z1',
    zoneName: 'Living room',
    driverId: null,
    ownerUri: null,
    ownerName: 'Test',
    available: true,
    capabilities: ['onoff', 'dim'],
    capabilitiesObj: {},
    ...over,
  });

  function catalog(devices: CatalogDevice[], zones: { id: string; name: string }[]): DeviceCatalog {
    return {
      lightCandidates: async () => devices,
      allZones: async () => zones,
      device: async (id: string) => devices.find(d => d.id === id),
      devicesInZone: async () => devices,
      lightsInZone: zoneLights(async () => devices),
      isOwnDevice: ownsNothing,
    } as unknown as DeviceCatalog;
  }

  test('rooms come first, and only rooms with a light in them', async () => {
    const choices = await lightChoices(
      catalog(
        [device({ id: 'l1', name: 'Reading lamp', zone: 'z1' })],
        [{ id: 'z1', name: 'Living room' }, { id: 'z2', name: 'Garage' }],
      ),
      { room: 'Every light in this room' },
    );

    assert.deepEqual(choices.map(c => c.name), ['Living room', 'Reading lamp']);
  });

  test('a chosen room survives a lamp being added to it later', () => {
    const spec = parseTargetChoice(targetChoiceId({ kind: 'zone', zoneId: 'z1', includeSubzones: true }));
    assert.deepEqual(spec, { kind: 'zone', zoneId: 'z1', includeSubzones: true });
  });

  test('a chosen light round-trips as an explicit list', () => {
    assert.deepEqual(
      parseTargetChoice(targetChoiceId({ kind: 'devices', deviceIds: ['l1'] })),
      { kind: 'devices', deviceIds: ['l1'] },
    );
  });

  /**
   * A Flow argument is user-editable like every other one, and a spec invented
   * from a malformed id is a write to lights nobody chose.
   */
  test('anything unrecognisable is refused rather than guessed at', () => {
    for (const junk of [undefined, null, '', 'z1', 'zone:', 'devices:', 'devices:,,', 42, {}]) {
      assert.equal(parseTargetChoice(junk), null, `${JSON.stringify(junk)} should be refused`);
    }
  });

  test('"leave it alone" is the first row of both source pickers', () => {
    const choices = sourceChoices(
      [{ id: 'lk-b', name: 'Bedroom' }, { id: 'lk-a', name: 'Attic' }],
      { leaveAlone: 'Leave it alone', leaveAloneHint: 'Do not set this at all' },
    );

    assert.equal(choices[0]?.id, LEAVE_ALONE);
    assert.deepEqual(choices.slice(1).map(c => c.name), ['Attic', 'Bedroom']);
  });

  test('typing filters on the name and the room alike', () => {
    const all = [
      { id: '1', name: 'Reading lamp', description: 'Living room' },
      { id: '2', name: 'Ceiling', description: 'Hall' },
    ];
    assert.deepEqual(matching(all, 'liv').map(c => c.id), ['1']);
    assert.deepEqual(matching(all, 'CEIL').map(c => c.id), ['2']);
    assert.deepEqual(matching(all, '  ').map(c => c.id), ['1', '2']);
  });
});

/**
 * End to end, through the real resolver, the real cache, the real planner and
 * the real write queue — with only Homey faked.
 *
 * The pure tests above prove the filter is right. This is what proves it is the
 * filter the planner is actually handed, which is the half a refactor could
 * quietly undo.
 */
describe('a pass, all the way to the lamps', () => {
  function rig(states: Record<string, boolean>) {
    const written: Array<{ id: string; capability: string; value: unknown }> = [];

    const devices: CatalogDevice[] = Object.keys(states).map(id => ({
      id,
      name: id,
      class: 'light',
      virtualClass: null,
      zone: 'z1',
      zoneName: 'Living room',
      driverId: null,
      ownerUri: null,
      ownerName: 'Test',
      available: true,
      capabilities: ['onoff', 'dim', 'light_temperature'],
      capabilitiesObj: {
        onoff: { value: states[id] },
        dim: { value: 0.5, min: 0, max: 1, decimals: 2 },
        light_temperature: { value: 0.5, min: 0, max: 1, decimals: 2 },
      },
    }));

    const handles = new Map(devices.map(device => [device.id, {
      capabilitiesObj: device.capabilitiesObj,
      async setCapabilityValue({ capabilityId, value }: any) {
        written.push({ id: device.id, capability: capabilityId, value });
      },
      makeCapabilityInstance: () => ({ destroy: () => {} }),
    }]));

    const catalog = {
      lightCandidates: async () => devices,
      allZones: async () => [{ id: 'z1', name: 'Living room' }],
      device: async (id: string) => devices.find(d => d.id === id),
      devicesInZone: async () => devices,
      lightsInZone: zoneLights(async () => devices),
      isOwnDevice: ownsNothing,
    } as unknown as DeviceCatalog;

    const api = {
      async read() {
        return { devices: { getDevice: async ({ id }: any) => handles.get(id) } };
      },
      track: (unsubscribe: Unsubscribe) => unsubscribe,
    } as unknown as HomeyApiService;

    const writer = new FlowLightWriter({ api, catalog, log: () => {} });
    return { writer, written };
  }

  const SPEC = { kind: 'zone', zoneId: 'z1', includeSubzones: true } as const;

  test('two devices, one burst, every lamp in the room', async () => {
    const { writer, written } = rig({ 'lamp-on': true, 'lamp-off': false });

    const result = await writer.apply(SPEC, planSetLights({
      colour: curve({ [VALUE_CAPABILITIES.temperature]: 0.86 }),
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: [],
    }, 'on'), 'on');
    await writer.destroy();

    assert.equal(result.refused, undefined);
    assert.ok(result.writes > 0);
    // Both lamps, and the switch went out before the level on each of them.
    for (const id of ['lamp-on', 'lamp-off']) {
      const forLamp = written.filter(w => w.id === id).map(w => w.capability);
      assert.ok(forLamp.includes('onoff'), `${id} should have been switched on`);
      assert.ok(forLamp.indexOf('onoff') < forLamp.indexOf('dim'), `${id}: onoff before dim`);
      assert.ok(forLamp.includes('light_temperature'));
    }
    assert.deepEqual(
      written.filter(w => w.id === 'lamp-on' && w.capability === 'dim').map(w => w.value),
      [0.26],
    );
  });

  test('"only lights already on" never writes to a lamp that is off', async () => {
    const { writer, written } = rig({ 'lamp-on': true, 'lamp-off': false });

    const result = await writer.apply(SPEC, planSetLights({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: [],
    }, 'only_on'), 'only_on');
    await writer.destroy();

    assert.deepEqual(written.map(w => w.id), ['lamp-on']);
    assert.equal(result.skipped, 1);
  });

  test('and writes nothing at all when every lamp is off', async () => {
    const { writer, written } = rig({ 'lamp-off': false });

    const result = await writer.apply(SPEC, planSetLights({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: [],
    }, 'only_on'), 'only_on');
    await writer.destroy();

    assert.deepEqual(written, []);
    assert.match(result.refused ?? '', /none of the chosen lights are on/);
  });

  test('a refused plan never reaches a lamp', async () => {
    const { writer, written } = rig({ 'lamp-on': true });

    const result = await writer.apply(SPEC, planSetLights({
      colour: null,
      brightness: source({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
      missing: ['lk-gone'],
    }, 'on'), 'on');
    await writer.destroy();

    assert.deepEqual(written, []);
    assert.match(result.refused ?? '', /lk-gone/);
  });
});
