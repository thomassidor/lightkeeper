import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { listTargetsPayload, targetDeviceIds } from '../../lib/pairing/target-picker';
import { TargetResolver } from '../../lib/outputs/target-resolver';

/**
 * What the app offers as a light, driven against a REAL DeviceCatalog.
 *
 * There was no test of this at all. `pairing-sessions.test.ts` builds a fake
 * catalogue that stubs `allZones`, `device` and `devicesInZone` and omits
 * `lightCandidates` entirely, so the rule was bypassed by construction — and
 * `target-resolver.test.ts` asserts the resolver's own copy of the predicate
 * rather than the catalogue's. Which is how the app came to offer its own
 * devices as lights while `scripts/probe-lights.mjs` had excluded them since
 * the day it was written.
 *
 * The fixture is deliberately the reference Homey in miniature: a bulb, a
 * plug, a plug a user has told Homey is really a lamp, a sensor, and one of
 * Lightkeeper's own devices.
 */

const APP_ID = 'com.thomassidor.lightkeeper';

const DEVICES = {
  bulb: {
    id: 'bulb', name: 'Table lamp', class: 'light', virtualClass: null, zone: 'living',
    driverId: 'homey:app:nl.philips.hue:bulb', ownerUri: 'homey:app:nl.philips.hue',
    capabilities: ['onoff', 'dim', 'light_temperature'], available: true,
  },
  plug: {
    id: 'plug', name: 'Christmas tree', class: 'socket', virtualClass: null, zone: 'living',
    driverId: 'homey:app:com.ikea.tradfri:tretakt_outlet', ownerUri: 'homey:app:com.ikea.tradfri',
    capabilities: ['onoff'], available: true,
  },
  lampPlug: {
    id: 'lampPlug', name: 'Alcove', class: 'socket', virtualClass: 'light', zone: 'living',
    driverId: 'homey:app:com.ikea.tradfri:tretakt_outlet', ownerUri: 'homey:app:com.ikea.tradfri',
    capabilities: ['onoff'], available: true,
  },
  sensor: {
    id: 'sensor', name: 'Hallway motion', class: 'sensor', virtualClass: null, zone: 'living',
    driverId: 'homey:app:com.ikea.tradfri:motion', ownerUri: 'homey:app:com.ikea.tradfri',
    capabilities: ['alarm_motion'], available: true,
  },
  ours: {
    id: 'ours', name: 'Evening light', class: 'service', virtualClass: null, zone: 'living',
    driverId: `homey:app:${APP_ID}:curve`, ownerUri: `homey:app:${APP_ID}`,
    capabilities: ['onoff'], available: true,
  },
};

function catalogue(ownAppId: string | null = APP_ID): DeviceCatalog {
  const api = {
    async read() {
      return {
        devices: { async getDevices() { return DEVICES; }, on() {}, off() {} },
        zones: {
          async getZones() { return { living: { id: 'living', name: 'Living room', parent: null } }; },
          on() {}, off() {},
        },
        apps: { async getApps() { return {}; } },
      };
    },
    reportReadFailure() { return false; },
    track(off: () => void) { return off; },
  } as unknown as HomeyApiService;

  return new DeviceCatalog(api, ownAppId);
}

describe('what counts as a light', () => {
  test('the rule is onoff, so a plug with a lamp in it is offered', async () => {
    const ids = (await catalogue().lightCandidates()).map(d => d.id).sort();
    // The sensor is out because it has no onoff; `ours` is out because it is ours.
    assert.deepEqual(ids, ['bulb', 'lampPlug', 'plug']);
  });

  test("the app's own devices are never candidates", async () => {
    const ids = (await catalogue().lightCandidates()).map(d => d.id);
    assert.ok(!ids.includes('ours'), 'a Lightkeeper device is not a light');
  });

  test('a zone target excludes them too, which is the dangerous half', async () => {
    // Nobody CHOOSES a device in a zone target: "all the lights in the living
    // room" sweeps up whatever is there, so the picker's exclusion alone would
    // have left the loop reachable.
    const ids = await targetDeviceIds(catalogue(), {
      kind: 'zone', zoneId: 'living', includeSubzones: false,
    });
    assert.deepEqual([...ids].sort(), ['bulb', 'lampPlug', 'plug']);
  });

  test('a plan saved before the fix stops driving them too', async () => {
    // The picker no longer offers them and a zone no longer sweeps them, but a
    // target saved while it did would go on running. An explicit list is
    // otherwise honoured exactly as given — see TargetResolver.resolve().
    const resolved = await new TargetResolver(catalogue()).resolve({
      kind: 'devices', deviceIds: ['bulb', 'ours', 'plug'],
    });
    assert.deepEqual(resolved.devices.map(d => d.id), ['bulb', 'plug']);
    // Dropped, not "missing": it is there, it is just never a light.
    assert.deepEqual(resolved.missing, []);
  });

  test('with no app id nothing is excluded — the pairing rigs and the tests', async () => {
    const ids = (await catalogue(null).lightCandidates()).map(d => d.id).sort();
    assert.deepEqual(ids, ['bulb', 'lampPlug', 'ours', 'plug']);
  });

  test('class light and virtualClass light both count as a light', () => {
    assert.equal(DeviceCatalog.isLightClass(DEVICES.bulb), true);
    // The person who owns the room told Homey this socket is a lamp.
    assert.equal(DeviceCatalog.isLightClass(DEVICES.lampPlug), true);
    assert.equal(DeviceCatalog.isLightClass(DEVICES.plug), false);
  });
});

describe('the picker payload', () => {
  test('real lights come first, and the rest are marked rather than hidden', async () => {
    const payload = await listTargetsPayload(catalogue(), undefined) as any;
    const room = payload.rooms.find((r: any) => r.zoneName === 'Living room');
    assert.deepEqual(room.lights.map((l: any) => l.id), ['lampPlug', 'bulb', 'plug']);
    // Alcove sorts above Table lamp because both are lights; the plug is last
    // because it is not one, and says so.
    assert.deepEqual(room.lights.map((l: any) => l.isLight), [true, true, false]);
  });

  test('the sort is alphabetical inside each group, as it always was', async () => {
    const payload = await listTargetsPayload(catalogue(null), undefined) as any;
    const room = payload.rooms.find((r: any) => r.zoneName === 'Living room');
    // 'ours' has class 'service', so it joins the plug below the two lights —
    // and only appears at all because this catalogue has no app id.
    assert.deepEqual(room.lights.map((l: any) => l.name),
      ['Alcove', 'Table lamp', 'Christmas tree', 'Evening light']);
  });
});
