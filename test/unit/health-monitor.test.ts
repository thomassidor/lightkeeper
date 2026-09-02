import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  HealthMonitor, matchesOwnerAndDriver, surfaceIsPortablyTheSame, surfaceMoved,
} from '../../lib/runtime/health-monitor';
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
  /**
   * The v2 hash per device, which the harness did NOT model — and its absence
   * is why every test here passed while one-tap re-attach was dead. With no v2
   * on the discovery result, `surfaceMoved()` falls back to v1 and the
   * device-specific comparison the shipping build actually made never ran.
   */
  fingerprintsV2?: Record<string, string>;
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
      ...(options.fingerprintsV2?.[d.id] !== undefined
        ? { fingerprintV2: options.fingerprintsV2[d.id] }
        : {}),
      matchRoutes: [],
      cardsInspected: 0,
    }),
  } as any;

  return new HealthMonitor(catalog, discovery, () => options.credentialValid ?? true);
}

describe('controller health states', () => {
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

  test('a changed event surface produces needs_repair, not a guessed binding', async () => {
    const monitor = harness({
      devices: [device({ id: 'old-device' }), light('light-1')],
      fingerprints: { 'old-device': 'fp-CHANGED' },
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.state, 'needs_repair');
    assert.equal(assessment.detail?.key, 'state.surfaceChanged');
    assert.match(assessment.detail?.text ?? '', /different events/);
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
    // Pinned because this arm is now DELEGATED to assessTargets(), which a light
    // schedule calls too. HealthMonitor kept its own copy of it for a while, and
    // two copies of a locale key plus its tokens is how they drift apart.
    assert.equal(assessment.detail?.key, 'state.someTargets');
    assert.deepEqual(assessment.detail?.tokens, { count: 1, total: 2 });
  });

  test('no reachable targets is needs_repair, with the shared verdict', async () => {
    const monitor = harness({
      devices: [device({ id: 'old-device' }), light('light-1', { available: false })],
    });

    const assessment = await monitor.assess(profile({
      target: { kind: 'devices', deviceIds: ['light-1'] },
    }));

    assert.equal(assessment.state, 'needs_repair');
    assert.equal(assessment.detail?.key, 'state.noTargets');
  });
});

describe('one-tap re-attach', () => {
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
      { inputs: [], fingerprint: 'fp-new', fingerprintV2: 'fp-new-v2' },
    );

    assert.equal(updated.source.deviceId, 'new-device');
    assert.deepEqual(updated.mappings, original.mappings, 'mappings must survive intact');
    assert.deepEqual(updated.target, original.target, 'targets must survive intact');
    assert.deepEqual(updated.managedFlows, [],
      'flows pointing at the old device must be dropped so reconciliation recreates them');
  });

  /**
   * The second half of the same bug. A fingerprint is only meaningful against
   * the device it was taken from — v2 hashes each card's full id and uri, and
   * both embed the device id (platform §4) — so a re-attach that kept the old
   * device's hashes disagreed with itself on the very next `assess()`, which
   * put the device straight back into needs_repair with "This remote now
   * exposes different events". One tap, and then the same dead end.
   */
  test('re-attaching adopts the NEW device surface, or the next check reports it moved', () => {
    const original = profile();

    const updated = HealthMonitor.applyReattach(
      original,
      { deviceId: 'new-device', deviceName: 'BILRESA scroll wheel', matchedOn: 'owner+driver+fingerprint' },
      { inputs: [], fingerprint: 'fp-new', fingerprintV2: 'fp-new-v2' },
    );

    assert.equal(updated.source.eventSurfaceFingerprint, 'fp-new');
    assert.equal(updated.source.eventSurfaceFingerprintV2, 'fp-new-v2');
    // Which is exactly what makes the device settle instead of bouncing.
    assert.equal(
      surfaceMoved(updated, { fingerprint: 'fp-new', fingerprintV2: 'fp-new-v2' }), false,
      'the re-attached profile agrees with the device it is now pointed at',
    );
  });
});

describe('one-tap re-attach through assess()', () => {
  /**
   * The whole feature, end to end, on a profile that carries a v2 hash — which
   * is every controller paired or repaired since v2 landed, and the population
   * for whom re-attach silently did nothing.
   *
   * The two devices are the SAME remote: identical v1 shape, different v2,
   * because v2 hashes each card's full id and uri and both embed the device id
   * (platform §4). Platform §7 records that BILRESA's cards vanish on every
   * Homey restart and the device must be re-added under a new id.
   */
  test('a v2-carrying profile still finds its remote re-added under a new id', async () => {
    const monitor = harness({
      devices: [device({ id: 'new-device', name: 'BILRESA scroll wheel' }), light('light-1')],
      fingerprints: { 'new-device': 'fp-abc' },
      fingerprintsV2: { 'new-device': 'fp-abc-on-new-device' },
    });

    const stored = profile();
    stored.source.eventSurfaceFingerprintV2 = 'fp-abc-on-old-device';

    const assessment = await monitor.assess(stored);

    assert.equal(assessment.state, 'needs_repair');
    assert.equal(assessment.detail?.key, 'source.reattach',
      'the user is offered one tap, not a full remap');
    assert.equal(assessment.reattach?.deviceId, 'new-device');
  });

  test('a v2-carrying profile still refuses a remote of a different shape', async () => {
    const monitor = harness({
      devices: [device({ id: 'new-device' }), light('light-1')],
      fingerprints: { 'new-device': 'fp-DIFFERENT' },
      fingerprintsV2: { 'new-device': 'fp-DIFFERENT-on-new-device' },
    });

    const stored = profile();
    stored.source.eventSurfaceFingerprintV2 = 'fp-abc-on-old-device';

    const assessment = await monitor.assess(stored);

    assert.equal(assessment.detail?.key, 'state.sourceGone');
    assert.equal(assessment.reattach, undefined, 'never guess a new binding');
  });
});

describe('one-tap re-attach matches a DIFFERENT device', () => {
  /**
   * v2 embeds the device id, so comparing two devices on it can only ever
   * disagree — which is why every candidate was rejected and the feature was
   * dead for any controller paired or repaired since v2 landed.
   */
  test('a candidate is matched on the portable hash, not the device-specific one', () => {
    const stored = profile();
    stored.source.eventSurfaceFingerprint = 'shape-1';
    stored.source.eventSurfaceFingerprintV2 = 'shape-1-on-old-device';

    // The same remote, re-added: identical shape, a v2 hash that cannot match
    // because it carries the new device's id.
    const readded = { fingerprint: 'shape-1', fingerprintV2: 'shape-1-on-new-device' };

    assert.equal(surfaceIsPortablyTheSame(stored, readded), true,
      'the same shape on another device is a re-attach candidate');
    assert.equal(surfaceMoved(stored, readded), true,
      'while surfaceMoved correctly says the device-specific surface differs — '
      + 'which is why re-attach must not ask it');
  });

  test('a genuinely different remote is still refused', () => {
    const stored = profile();
    stored.source.eventSurfaceFingerprint = 'shape-1';

    assert.equal(
      surfaceIsPortablyTheSame(stored, { fingerprint: 'shape-2' }), false,
      'never guess a new binding — a changed shape means remapping',
    );
  });
});

describe('re-attach candidate matching', () => {
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
