import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HealthMonitor, matchesOwnerAndDriver } from '../../lib/runtime/health-monitor';
import { CURRENT_SCHEMA_VERSION, type ControllerProfile } from '../../lib/profiles/controller-profile';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import type { CatalogDevice } from '../../lib/device-catalog';

const device = (over: Partial<CatalogDevice>): CatalogDevice => ({
  id: 'd1', name: 'Remote', class: 'remote', virtualClass: null,
  zone: 'z1', zoneName: 'Kitchen',
  driverId: 'homey:app:com.ikea.tradfri:remote_control_n2',
  ownerUri: 'homey:app:com.ikea.tradfri', ownerName: 'IKEA',
  available: true, capabilities: [], capabilitiesObj: {},
  ...over,
});

/** Lights must not share the remote's driver, or they look like re-attach candidates. */
const light = (id: string, over: Partial<CatalogDevice> = {}): CatalogDevice => device({
  id,
  name: id,
  class: 'light',
  capabilities: ['onoff'],
  driverId: 'homey:app:nl.philips.hue:bulb',
  ownerUri: 'homey:app:nl.philips.hue',
  ownerName: 'Philips Hue',
  ...over,
});

const profile = (over: Partial<ControllerProfile> = {}): ControllerProfile => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  enabled: true,
  source: {
    deviceId: 'old-device',
    driverId: 'homey:app:com.ikea.tradfri:remote_control_n2',
    ownerAppId: 'homey:app:com.ikea.tradfri',
    eventSurfaceFingerprint: 'fp-abc',
    name: 'Kitchen STYRBAR',
  },
  target: { kind: 'devices', deviceIds: ['light-1'] },
  mappings: [{ id: 'r1', function: 'toggle', inputKey: 'n2_on|press', target: null }],
  behavior: { ...DEFAULT_BEHAVIOR },
  managedFlows: [],
  ...over,
});

function harness(options: {
  devices: CatalogDevice[];
  fingerprints?: Record<string, string>;
  credentialValid?: boolean;
}) {
  const catalog = {
    device: async (id: string) => options.devices.find(d => d.id === id),
    allDevices: async () => options.devices,
    devicesInZone: async () => options.devices,
  } as any;

  const discovery = {
    discover: async (d: CatalogDevice) => ({
      device: d,
      inputs: [],
      rejected: [],
      fingerprint: options.fingerprints?.[d.id] ?? 'fp-abc',
      matchRoutes: [],
      cardsInspected: 0,
    }),
  } as any;

  return new HealthMonitor(catalog, discovery, () => options.credentialValid ?? true);
}

describe('controller health states (§9.2)', () => {
  test('ready when source, targets and credential are all fine', async () => {
    const monitor = harness({
      devices: [device({ id: 'old-device' }), light('light-1')],
    });
    assert.equal((await monitor.assess(profile())).state, 'ready');
  });

  test('disabled short-circuits everything', async () => {
    const monitor = harness({ devices: [] });
    assert.equal((await monitor.assess(profile({ enabled: false }))).state, 'disabled');
  });

  test('a changed event surface produces needs_repair, not a guessed binding (AC-15)', async () => {
    const monitor = harness({
      devices: [device({ id: 'old-device' }), light('light-1')],
      fingerprints: { 'old-device': 'fp-CHANGED' },
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.state, 'needs_repair');
    assert.match(assessment.detail!, /different events/);
  });

  test('an invalid credential is its own state, not needs_repair', async () => {
    const monitor = harness({
      devices: [device({ id: 'old-device' }), light('light-1')],
      credentialValid: false,
    });

    const assessment = await monitor.assess(profile({
      managedFlows: [{
        flowId: 'f1', bindingKey: 'k', variantKey: 'fixed',
        fingerprint: 'fp-abc', managedVersion: 1, createdAt: 0,
      }],
    }));

    assert.equal(assessment.state, 'needs_credential',
      'the mappings are fine; only the key is not — do not make the user remap');
  });

  test('unavailable targets degrade to partial, not broken', async () => {
    const monitor = harness({
      devices: [
        device({ id: 'old-device' }),
        light('light-1', { available: false }),
        light('light-2'),
      ],
    });

    const assessment = await monitor.assess(profile({
      target: { kind: 'devices', deviceIds: ['light-1', 'light-2'] },
    }));

    assert.equal(assessment.state, 'partial');
  });
});

describe('one-tap re-attach (§9.4, AC-16)', () => {
  test('finds the same remote re-added under a new device ID', async () => {
    const monitor = harness({
      devices: [
        device({ id: 'new-device', name: 'BILRESA scroll wheel' }),
        light('light-1'),
      ],
      fingerprints: { 'new-device': 'fp-abc' },
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.state, 'needs_repair');
    assert.equal(assessment.reattach?.deviceId, 'new-device');
    assert.equal(assessment.reattach?.matchedOn, 'owner+driver+fingerprint');
  });

  test('refuses to re-attach when the fingerprint has changed', async () => {
    const monitor = harness({
      devices: [
        device({ id: 'new-device', name: 'Something else' }),
        light('light-1'),
      ],
      fingerprints: { 'new-device': 'fp-DIFFERENT' },
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.reattach, undefined,
      'a changed surface must require remapping — never guess a new binding');
  });

  test('refuses a device from a different driver even with a matching fingerprint', async () => {
    const monitor = harness({
      devices: [
        device({ id: 'new-device', driverId: 'homey:app:nl.philips.hue:tapdial', ownerUri: 'homey:app:nl.philips.hue' }),
        light('light-1'),
      ],
      fingerprints: { 'new-device': 'fp-abc' },
    });

    assert.equal((await monitor.assess(profile())).reattach, undefined);
  });

  test('re-attaching preserves every mapping and target', () => {
    const original = profile({
      mappings: [
        { id: 'r1', function: 'toggle', inputKey: 'n2_on|press', target: null },
        { id: 'r2', function: 'brightness_up', inputKey: 'n2_dim_up|long_press', target: null },
      ],
      managedFlows: [{
        flowId: 'stale', bindingKey: 'k', variantKey: 'fixed',
        fingerprint: 'fp-abc', managedVersion: 1, createdAt: 0,
      }],
    });

    const updated = HealthMonitor.applyReattach(
      original,
      { deviceId: 'new-device', deviceName: 'BILRESA scroll wheel', matchedOn: 'owner+driver+fingerprint' },
      [],
    );

    assert.equal(updated.source.deviceId, 'new-device');
    assert.deepEqual(updated.mappings, original.mappings, 'mappings must survive intact');
    assert.deepEqual(updated.target, original.target, 'targets must survive intact');
    assert.deepEqual(updated.managedFlows, [],
      'flows pointing at the old device must be dropped so reconciliation recreates them');
  });
});

describe('re-attach candidate matching (§2.4)', () => {
  test('matches on owner app plus driver, never model name alone', () => {
    const p = profile();
    assert.equal(matchesOwnerAndDriver(device({ id: 'x' }), p), true);
    assert.equal(matchesOwnerAndDriver(
      device({ id: 'x', driverId: 'homey:app:com.ikea.tradfri:other_driver' }), p), false);
    assert.equal(matchesOwnerAndDriver(
      device({ id: 'x', ownerUri: 'homey:app:nl.philips.hue' }), p), false);
  });

  test('a profile with no recorded driver or owner cannot re-attach', () => {
    const p = profile({
      source: { deviceId: 'old', eventSurfaceFingerprint: 'fp-abc' },
    });
    assert.equal(matchesOwnerAndDriver(device({ id: 'x' }), p), false);
  });
});
