import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * What a device or zone event COSTS, as against what it changes.
 *
 * Every such event invalidates the whole catalogue, and the next question then
 * refreshes it. The device and zone reads come out of `homey-api`'s own cache;
 * `getApps()` does not, because `read()` never connects `apps`, so it is a real
 * round trip. It used to be made on every refresh, because every event cleared
 * the app names. These tests pin the rule that replaced that: ask only when a
 * device has an owner we cannot name yet, and count everything for
 * `/diagnostics`.
 */

interface Device { id: string; ownerUri?: string | null }

function harness(initial: Device[], apps: Record<string, { id: string; name: string }> = {
  'com.example.bulbs': { id: 'com.example.bulbs', name: 'Example Bulbs' },
}) {
  let devices = initial;
  let zones: Record<string, { id: string; name: string; parent: string | null }> = {
    z1: { id: 'z1', name: 'Living room', parent: null },
  };
  let appsCalls = 0;
  let appsFail = false;
  let gate: Promise<void> | null = null;
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const replacements: Array<() => void> = [];

  const manager = {
    on: (event: string, fn: (payload?: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event: string, fn: (payload?: unknown) => void) => { listeners.get(event)?.delete(fn); },
  };

  const client = {
    devices: {
      ...manager,
      getDevices: async () => {
        if (gate) await gate;
        return Object.fromEntries(devices.map(d => [d.id, {
          id: d.id, name: d.id, class: 'light', zone: 'z1', ownerUri: d.ownerUri ?? null,
          capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } },
        }]));
      },
    },
    zones: { ...manager, getZones: async () => ({ ...zones }) },
    apps: {
      getApps: async () => {
        appsCalls += 1;
        if (appsFail) throw new Error('socket hang up');
        return apps;
      },
    },
  };

  const api = {
    read: async () => client,
    track: (fn: unknown) => fn,
    onReadReplacement: (fn: () => void) => { replacements.push(fn); return () => { /* nothing */ }; },
    reportReadFailure: () => false,
  } as unknown as HomeyApiService;

  return {
    catalog: new DeviceCatalog(api, 'com.thomassidor.lightkeeper'),
    emit: (event: string, payload?: unknown) => { for (const fn of [...listeners.get(event) ?? []]) fn(payload); },
    replaceClient: () => { for (const fn of replacements) fn(); },
    setDevices: (next: Device[]) => { devices = next; },
    setZones: (next: typeof zones) => { zones = next; },
    failApps: (fail: boolean) => { appsFail = fail; },
    hold: () => {
      let open!: () => void;
      gate = new Promise(resolve => { open = resolve; });
      return () => { gate = null; open(); };
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    appsCalls: () => appsCalls,
  };
}

const BULB = { id: 'lamp-1', ownerUri: 'homey:app:com.example.bulbs' };

describe('device catalogue invalidation cost', () => {
  test('an event on a device whose app is already named costs no getApps', async () => {
    const h = harness([BULB]);
    await h.catalog.watch(() => { /* registries */ });

    assert.equal((await h.catalog.device('lamp-1'))?.ownerName, 'Example Bulbs');
    assert.equal(h.appsCalls(), 1, 'the first refresh has to ask');

    for (let i = 0; i < 5; i += 1) {
      h.emit('device.update');
      await h.catalog.allDevices();
    }
    h.emit('zone.update');
    await h.catalog.allDevices();

    assert.equal(h.appsCalls(), 1, 'a device.update cannot change an app name, so it must not ask');
    assert.equal((await h.catalog.device('lamp-1'))?.ownerName, 'Example Bulbs', 'and the name survives');
  });

  test('a device from an integration installed after boot gets its name, with one read', async () => {
    const apps: Record<string, { id: string; name: string }> = {
      'com.example.bulbs': { id: 'com.example.bulbs', name: 'Example Bulbs' },
    };
    const h = harness([BULB], apps);
    await h.catalog.watch(() => { /* registries */ });
    await h.catalog.allDevices();

    apps['com.example.plugs'] = { id: 'com.example.plugs', name: 'Example Plugs' };
    h.setDevices([BULB, { id: 'plug-1', ownerUri: 'homey:app:com.example.plugs' }]);
    h.emit('device.update');

    assert.equal((await h.catalog.device('plug-1'))?.ownerName, 'Example Plugs');
    assert.equal(h.appsCalls(), 2);
  });

  test('an owner getApps cannot name is asked about once, not on every refresh', async () => {
    const h = harness([BULB, { id: 'odd-1', ownerUri: 'homey:app:com.example.installing' }]);
    await h.catalog.watch(() => { /* registries */ });

    assert.equal((await h.catalog.device('odd-1'))?.ownerName, 'com.example.installing', 'the URI fallback');
    for (let i = 0; i < 3; i += 1) {
      h.emit('device.update');
      await h.catalog.allDevices();
    }
    assert.equal(h.appsCalls(), 1);

    // A new device is the moment asking again could give a different answer.
    h.emit('device.create');
    await h.catalog.allDevices();
    assert.equal(h.appsCalls(), 2);
  });

  test('a failed getApps is not retried per refresh, and a replaced read client retries it', async () => {
    const h = harness([BULB]);
    h.failApps(true);
    await h.catalog.watch(() => { /* registries */ });

    assert.equal((await h.catalog.device('lamp-1'))?.ownerName, 'com.example.bulbs', 'names are cosmetic');
    h.emit('device.update');
    await h.catalog.allDevices();
    assert.equal(h.appsCalls(), 1);

    h.failApps(false);
    h.replaceClient();
    assert.equal((await h.catalog.device('lamp-1'))?.ownerName, 'Example Bulbs');
    assert.equal(h.appsCalls(), 2);
  });

  test('devices owned by Homey itself never cost a getApps', async () => {
    const h = harness([{ id: 'group-1', ownerUri: null }, { id: 'virt-1', ownerUri: 'homey:manager:vdevice' }]);
    await h.catalog.watch(() => { /* registries */ });

    assert.equal((await h.catalog.device('group-1'))?.ownerName, 'Homey');
    assert.equal(h.appsCalls(), 0);
  });

  test('stats count each event by name, every refresh, and a read superseded mid-flight', async () => {
    const h = harness([BULB]);
    await h.catalog.watch(() => { /* registries */ });
    await h.catalog.allDevices();

    h.emit('device.update');
    h.emit('device.update');
    h.emit('zone.create');
    await h.catalog.allDevices();

    // An event landing while the device read is out re-runs the read.
    h.emit('device.delete');
    const release = h.hold();
    const pending = h.catalog.allDevices();
    await Promise.resolve();
    h.emit('device.update');
    release();
    await pending;

    h.replaceClient();
    const stats = h.catalog.stats();
    assert.deepEqual(stats.invalidations, {
      'device.update': 3, 'zone.create': 1, 'device.delete': 1, read_client_replaced: 1,
    });
    assert.equal(stats.refreshes, 4, 'boot, after the burst, and the superseded read plus its re-run');
    assert.equal(stats.supersededRetries, 1);
    assert.equal(stats.refreshFailures, 0);
    assert.equal(stats.appNameLoads, 1);
    assert.equal(stats.ignoredZoneUpdates, 0);
    assert.equal(typeof stats.since, 'number');
    assert.ok(!JSON.stringify(stats).includes('lamp-1'), 'counts and event names only');
  });

  test('re-binding after a replaced client leaves one listener per event, not two', async () => {
    const h = harness([BULB]);
    await h.catalog.watch(() => { /* registries */ });
    assert.equal(h.listenerCount('device.update'), 1);

    h.replaceClient();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.listenerCount('device.update'), 1, 'off must be handed the same function on was');
    assert.equal(h.listenerCount('zone.delete'), 1);
  });
});

/**
 * A zone's motion state is not a change to the catalogue.
 *
 * Captured on the reference Homey: every `zone.update` in a quiet hour carried
 * only `active`, `activeOrigins` and `activeLastUpdated`, for the zone and each
 * zone above it — 176 an hour, each one a full invalidation and, behind it, a
 * trigger-catalogue read. The catalogue keeps a zone's name and parent only.
 */
describe('zone.update that changes nothing the catalogue keeps', () => {
  const MOTION = { id: 'z1', name: 'Living room', parent: null, active: true, activeOrigins: ['m1'], activeLastUpdated: 1 };

  async function watched() {
    const h = harness([BULB]);
    let changes = 0;
    await h.catalog.watch(() => { changes += 1; });
    await h.catalog.allDevices();
    return { h, changes: () => changes };
  }

  test('a motion-only update invalidates nothing, notifies nobody, and is counted', async () => {
    const { h, changes } = await watched();
    const before = h.catalog.stats().refreshes;

    h.emit('zone.update', MOTION);
    h.emit('zone.update', { ...MOTION, active: false });
    await h.catalog.allDevices();

    assert.equal(changes(), 0, 'no registry is told to refresh');
    assert.equal(h.catalog.stats().refreshes, before, 'and the cache is still the one it had');
    assert.equal(h.catalog.stats().ignoredZoneUpdates, 2);
    assert.equal(h.catalog.stats().invalidations['zone.update'], undefined);
  });

  test('a renamed zone still invalidates, and the new name is what devices read', async () => {
    const { h, changes } = await watched();

    h.setZones({ z1: { id: 'z1', name: 'Lounge', parent: null } });
    h.emit('zone.update', { ...MOTION, name: 'Lounge' });

    assert.equal(changes(), 1);
    assert.equal((await h.catalog.device('lamp-1'))?.zoneName, 'Lounge');
    // And once the catalogue knows the new name, a motion update under it is quiet again.
    h.emit('zone.update', { ...MOTION, name: 'Lounge', active: false });
    assert.equal(changes(), 1);
  });

  test('a zone moved under another still invalidates', async () => {
    const { h, changes } = await watched();
    h.emit('zone.update', { ...MOTION, parent: 'z-home' });
    assert.equal(changes(), 1);
    assert.equal(h.catalog.stats().invalidations['zone.update'], 1);
  });

  test('an update it cannot judge invalidates, as every update used to', async () => {
    const { h, changes } = await watched();
    h.emit('zone.update');                                        // no payload at all
    h.emit('zone.update', { id: 'z1' });                          // no name to compare
    h.emit('zone.update', { id: 'z-new', name: 'Attic', parent: null }); // a zone the refresh never saw
    assert.equal(changes(), 3);
    assert.equal(h.catalog.stats().ignoredZoneUpdates, 0);
  });

  test('before the first refresh there is nothing to compare with, so it invalidates', async () => {
    const h = harness([BULB]);
    let changes = 0;
    await h.catalog.watch(() => { changes += 1; });
    h.emit('zone.update', MOTION);
    assert.equal(changes, 1);
  });

  test('a device event between two zone updates does not make the second one count', async () => {
    const { h, changes } = await watched();
    h.emit('device.update');                 // nulls the cache, keeps the shapes
    h.emit('zone.update', MOTION);
    assert.equal(changes(), 1, 'only the device event');
    assert.equal(h.catalog.stats().ignoredZoneUpdates, 1);
  });
});
