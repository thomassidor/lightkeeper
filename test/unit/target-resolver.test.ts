import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TargetResolver } from '../../lib/outputs/target-resolver';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import type { CatalogDevice, DeviceCatalog } from '../../lib/device-catalog';

/**
 * Zone-following is the feature the README leads with — "if you add a lamp to a
 * room a device points at, it follows" — and it had no direct test.
 *
 * Two things it has to get right, and they pull in opposite directions: a zone
 * contains everything (a thermostat, a motion sensor, the controller's own
 * virtual device), so it must filter; and a missing device from an explicit
 * list must be REPORTED rather than silently dropped, because that is what
 * separates "one lamp is offline" from "this controller points at nothing".
 */

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
  capabilities: ['onoff'],
  capabilitiesObj: {},
  ...over,
});

const DIMMABLE = {
  onoff: { value: true },
  dim: { value: 0.4, min: 0, max: 1, decimals: 2 },
};

function catalog(devices: CatalogDevice[]): DeviceCatalog {
  return {
    device: async (id: string) => devices.find(d => d.id === id),
    devicesInZone: async () => devices,
  } as unknown as DeviceCatalog;
}

describe('explicit device targets', () => {
  test('missing devices are reported, not silently dropped', async () => {
    const resolver = new TargetResolver(catalog([device({ id: 'light-1' })]));

    const resolved = await resolver.resolve({
      kind: 'devices', deviceIds: ['light-1', 'light-gone'],
    });

    assert.deepEqual(resolved.devices.map(d => d.id), ['light-1']);
    assert.deepEqual(resolved.missing, ['light-gone']);
    assert.equal(resolved.summary.total, 1);
  });

  test('a non-light in an explicit list is still a target', async () => {
    // The user picked it. Zone resolution filters; an explicit choice does not,
    // or picking a smart plug you use as a lamp would silently do nothing.
    const plug = device({ id: 'plug-1', class: 'socket' });
    const resolver = new TargetResolver(catalog([plug]));

    const resolved = await resolver.resolve({ kind: 'devices', deviceIds: ['plug-1'] });
    assert.deepEqual(resolved.devices.map(d => d.id), ['plug-1']);
  });
});

describe('zone targets', () => {
  test('only controllable devices in the zone become targets', async () => {
    const resolver = new TargetResolver(catalog([
      device({ id: 'light-1' }),
      device({ id: 'sensor-1', class: 'sensor', capabilities: ['measure_temperature'] }),
      device({ id: 'lamp-2', capabilities: ['onoff', 'dim'] }),
    ]));

    const resolved = await resolver.resolve({
      kind: 'zone', zoneId: 'z1', includeSubzones: false,
    });

    assert.deepEqual(resolved.devices.map(d => d.id), ['light-1', 'lamp-2']);
    assert.deepEqual(resolved.missing, [], 'a zone cannot have missing members');
  });

  test('the capability summary counts each capability separately', async () => {
    // What decides which functions the mapping screen offers. A zone of mixed
    // lamps must report partial support rather than none.
    const resolver = new TargetResolver(catalog([
      device({ id: 'plain', capabilities: ['onoff'] }),
      device({ id: 'dimmable', capabilities: ['onoff', 'dim'] }),
      device({ id: 'tunable', capabilities: ['onoff', 'dim', 'light_temperature'] }),
    ]));

    const { summary } = await resolver.resolve({
      kind: 'zone', zoneId: 'z1', includeSubzones: false,
    });

    assert.deepEqual(summary, { onoff: 3, dim: 2, light_temperature: 1, total: 3 });
  });
});

describe('priming the cache', () => {
  test('each target keeps its OWN capability options', async () => {
    // Options are not uniform across devices (platform §6): onoff carries none
    // at all, and dim's decimals decide the smallest write that is not a no-op.
    // Assuming one device's options for another writes the wrong step.
    const narrow = device({
      id: 'narrow',
      capabilities: ['onoff', 'dim'],
      capabilitiesObj: { onoff: { value: true }, dim: { value: 0.5, min: 0.1, max: 0.9, decimals: 1 } },
    });
    const wide = device({ id: 'wide', capabilities: ['onoff', 'dim'], capabilitiesObj: DIMMABLE });

    const cache = new TargetStateCache();
    new TargetResolver(catalog([narrow, wide])).primeCache([narrow, wide], cache);

    assert.deepEqual(cache.capabilitiesOf('narrow')?.dim, {
      min: 0.1, max: 0.9, step: undefined, decimals: 1,
    });
    assert.deepEqual(cache.capabilitiesOf('wide')?.dim, {
      min: 0, max: 1, step: undefined, decimals: 2,
    });
  });

  test('a capability the device lacks is absent, not zeroed', async () => {
    // `light_temperature: { min: 0, max: 0 }` would read as a supported axis
    // that refuses every value.
    const plain = device({ id: 'plain', capabilities: ['onoff'], capabilitiesObj: { onoff: { value: false } } });

    const cache = new TargetStateCache();
    new TargetResolver(catalog([plain])).primeCache([plain], cache);

    const caps = cache.capabilitiesOf('plain');
    assert.equal(caps?.onoff, true);
    assert.equal(caps?.dim, undefined);
    assert.equal(caps?.light_temperature, undefined);
  });

  test('the device\'s current values are seeded, so a relative step is not blind', async () => {
    const lamp = device({ id: 'lamp', capabilities: ['onoff', 'dim'], capabilitiesObj: DIMMABLE });

    const cache = new TargetStateCache();
    new TargetResolver(catalog([lamp])).primeCache([lamp], cache);

    assert.equal(cache.currentOn('lamp'), true);
    assert.equal(cache.currentDim('lamp'), 0.4);
  });
});
