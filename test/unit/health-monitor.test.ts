import { test, describe } from 'node:test';
import { ownsNothing, zoneLights } from '../support/fake-catalog';
import assert from 'node:assert/strict';

import {
  HealthMonitor, SURFACE_MEMO_MS, matchesOwnerAndDriver, surfaceIsPortablyTheSame, surfaceMoved,
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
  /** Remotes a LIVE controller is already listening to. See `sourcesInUse`. */
  sourcesInUse?: string[];
  /** Every device `discover()` was asked about, in order. */
  discovered?: string[];
  /** The monitor's clock, for the surface memo. */
  now?: () => number;
}) {
  const catalog = {
    device: async (id: string) => options.devices.find(d => d.id === id),
    allDevices: async () => options.devices,
    devicesInZone: async () => options.devices,
    lightsInZone: zoneLights(async () => options.devices),
    isOwnDevice: ownsNothing,
  } as any;

  const discovery = {
    discover: async (d: CatalogDevice) => (options.discovered?.push(d.id), {
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

  return new HealthMonitor(
    catalog, discovery, () => options.credentialValid ?? true,
    () => new Set(options.sourcesInUse ?? []),
    options.now,
  );
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
    assert.deepEqual(assessment.detail?.tokens, { unavailable: 1, count: 2 });
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

  /**
   * Two identical remotes tie, and a coin toss is not a one-tap answer.
   *
   * The portable fingerprint is device-agnostic BY DESIGN — it hashes card
   * short ids, which is exactly "the same card on another device" — so two
   * STYRBARs or two BILRESAs match equally well and the search simply returned
   * whichever `allDevices()` listed first. BILRESA is the re-add case platform
   * §7 exists for, so a household with two of them is the realistic setup, and
   * the copy promises "re-attach in one tap".
   */
  test('two identical remotes produce no one-tap offer', async () => {
    const monitor = harness({
      devices: [
        device({ id: 'bilresa-a', name: 'Bedroom remote' }),
        device({ id: 'bilresa-b', name: 'Study remote' }),
        light('light-1'),
      ],
      fingerprints: { 'bilresa-a': 'fp-abc', 'bilresa-b': 'fp-abc' },
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.state, 'needs_repair');
    assert.equal(
      assessment.reattach, undefined,
      'offered a one-tap re-attach onto a remote it cannot have identified',
    );
    assert.equal(
      assessment.detail?.key, 'source.reattachAmbiguous',
      'and it must say WHY, not fall back to "no longer paired"',
    );
  });

  /**
   * `assess()` used to scan twice when the source was gone — the one-tap
   * search, then the full list — and every `discover()` is a match against the
   * whole trigger catalogue, repeated on every catalogue change while the
   * remote stays gone.
   */
  test('a gone remote is searched for once per assessment, not twice', async () => {
    for (const ids of [['bilresa-a'], ['bilresa-a', 'bilresa-b'], ['bilresa-a', 'bilresa-b', 'bilresa-c']]) {
      const discovered: string[] = [];
      const monitor = harness({
        devices: [...ids.map(id => device({ id, name: id })), light('light-1')],
        discovered,
      });

      const assessment = await monitor.assess(profile());

      assert.deepEqual(discovered, ids, `each candidate discovered once (${ids.length} remote(s))`);
      if (ids.length === 1) assert.equal(assessment.reattach?.deviceId, 'bilresa-a');
      else assert.deepEqual(assessment.detail?.tokens, { count: ids.length });
    }
  });

  test('the repair screen\'s yes-or-no search still stops at two', async () => {
    const discovered: string[] = [];
    const monitor = harness({
      devices: ['a', 'b', 'c'].map(id => device({ id, name: id })),
      discovered,
    });

    assert.equal(await monitor.findReattachCandidate(profile()), undefined);
    assert.deepEqual(discovered, ['a', 'b']);
  });

  test('a remote another live controller is using is not a candidate', async () => {
    // Re-attaching onto it would leave two controllers driving from one
    // remote, with the other one's mappings silently competing for the same
    // gestures — and this is the ONLY thing that can tell the two apart.
    const monitor = harness({
      devices: [
        device({ id: 'bilresa-a', name: 'Bedroom remote' }),
        device({ id: 'bilresa-b', name: 'Study remote' }),
        light('light-1'),
      ],
      fingerprints: { 'bilresa-a': 'fp-abc', 'bilresa-b': 'fp-abc' },
      sourcesInUse: ['bilresa-b'],
    });

    const assessment = await monitor.assess(profile());

    assert.equal(
      assessment.reattach?.deviceId, 'bilresa-a',
      'with the other one accounted for, the remaining match IS unambiguous',
    );
  });

  test('and a household with one spare remote keeps its one tap', async () => {
    // The whole point of the feature must survive the fix.
    const monitor = harness({
      devices: [
        device({ id: 'new-device', name: 'BILRESA scroll wheel' }),
        light('light-1'),
      ],
      fingerprints: { 'new-device': 'fp-abc' },
      sourcesInUse: ['some-other-remote'],
    });

    assert.equal((await monitor.assess(profile())).reattach?.deviceId, 'new-device');
  });

  test('every matching remote already in use means no candidate at all', async () => {
    const monitor = harness({
      devices: [device({ id: 'bilresa-b', name: 'Study remote' }), light('light-1')],
      fingerprints: { 'bilresa-b': 'fp-abc' },
      sourcesInUse: ['bilresa-b'],
    });

    const assessment = await monitor.assess(profile());

    assert.equal(assessment.reattach, undefined);
    assert.equal(assessment.detail?.key, 'state.sourceGone');
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

/**
 * A remote's surface is re-read when something about the REMOTE could have
 * moved, not on every catalogue change.
 *
 * Measured on the reference Homey: with zone motion already ignored, a full
 * read of the 1748-card trigger catalogue still happened 13 times an hour,
 * driven by devices that were not the remote at all.
 */
describe('the remembered event surface', () => {
  function rig() {
    let clock = 1_000_000;
    const discovered: string[] = [];
    const fingerprints: Record<string, string> = { 'old-device': 'fp-abc' };
    const devices = [device({ id: 'old-device' }), light('light-1')];
    const monitor = harness({ devices, fingerprints, discovered, now: () => clock });
    return {
      monitor, discovered, fingerprints, devices,
      advance: (ms: number) => { clock += ms; },
      setSource: (over: Partial<CatalogDevice>) => { devices[0] = device({ id: 'old-device', ...over }); },
    };
  }

  test('an unchanged remote is discovered once, however many checks follow', async () => {
    const r = rig();
    for (let i = 0; i < 5; i += 1) assert.equal((await r.monitor.assess(profile({ source: { ...profile().source, deviceId: 'old-device' } }))).state, 'ready');
    assert.deepEqual(r.discovered, ['old-device']);
  });

  test('a changed driver or owning app is read again', async () => {
    const r = rig();
    const p = profile({ source: { ...profile().source, deviceId: 'old-device', driverId: undefined, ownerAppId: undefined } });
    await r.monitor.assess(p);
    r.setSource({ driverId: 'homey:app:com.ikea.tradfri:remote_control_n3' });
    await r.monitor.assess(p);
    assert.deepEqual(r.discovered, ['old-device', 'old-device']);
  });

  test('a remote that went unavailable is read again when it comes back', async () => {
    const r = rig();
    const p = profile({ source: { ...profile().source, deviceId: 'old-device' } });
    await r.monitor.assess(p);
    r.setSource({ available: false });
    assert.equal((await r.monitor.assess(p)).state, 'needs_repair');
    r.setSource({ available: true });
    r.fingerprints['old-device'] = 'fp-CHANGED';   // what an integration update can do
    const back = await r.monitor.assess(p);
    assert.equal(back.detail?.key, 'state.surfaceChanged', 'the restart is what made it look again');
    assert.equal(r.discovered.length, 2);
  });

  test('after the hour it is read again, which is the backstop for a move the row cannot show', async () => {
    const r = rig();
    const p = profile({ source: { ...profile().source, deviceId: 'old-device' } });
    await r.monitor.assess(p);
    r.fingerprints['old-device'] = 'fp-CHANGED';
    r.advance(SURFACE_MEMO_MS - 1);
    assert.equal((await r.monitor.assess(p)).state, 'ready', 'inside the hour the memory stands');
    r.advance(1);
    assert.equal((await r.monitor.assess(p)).detail?.key, 'state.surfaceChanged');
  });

  test('a remembered surface never fails a controller: a disagreement is re-read live first', async () => {
    const r = rig();
    await r.monitor.assess(profile({ source: { ...profile().source, deviceId: 'old-device' } }));
    // Repair remapped the remote onto a surface the memory predates.
    r.fingerprints['old-device'] = 'fp-NEW';
    const repaired = profile({ source: { ...profile().source, deviceId: 'old-device', eventSurfaceFingerprint: 'fp-NEW' } });
    assert.equal((await r.monitor.assess(repaired)).state, 'ready');
    assert.deepEqual(r.discovered, ['old-device', 'old-device'], 'the second read is the live one');
  });
});
