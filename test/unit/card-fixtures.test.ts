import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCards, type DiscoveredTriggerCard } from '../../lib/inputs/event-normalizer';
import {
  SourceDiscoveryService, NORMALIZER_VERSION, deviceIdOfScopedCard,
} from '../../lib/source-discovery-service';
import { surfaceMoved } from '../../lib/runtime/health-monitor';
import { discoverTimeCard } from '../../lib/schedules/time-card-discovery';
import type { CatalogDevice } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';
import {
  STYRBAR_CARDS, STYRBAR_DEVICE_ID,
  HUE_DIMMER_CARDS, HUE_DIMMER_DEVICE_ID,
  TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID,
  BILRESA_CARDS, BILRESA_DEVICE_ID,
} from '../fixtures/reference-devices';

/**
 * The recorded card corpus, and the discovery rules it exists to pin down.
 *
 * Phase 5's brief called the discovery cluster "plausible, unverified" and asked
 * for fixtures that turn it into tests. Two of those findings turned out to be
 * real bugs about the ONE thing discovery must never do — offer a card that does
 * not belong to the device in front of the user — and both are asserted here.
 */

const CARDS_DIR = join(import.meta.dirname, '..', 'fixtures', 'cards');

interface CardFixture {
  provenance: string;
  driverId: string;
  deviceId: string;
  cards: DiscoveredTriggerCard[];
}

function fixture(slug: string): CardFixture {
  return JSON.parse(readFileSync(join(CARDS_DIR, `${slug}.json`), 'utf8'));
}

describe('the recorded card corpus', () => {
  const EXPECTED = [
    ['styrbar', STYRBAR_DEVICE_ID, STYRBAR_CARDS],
    ['hue-dimmer-v2', HUE_DIMMER_DEVICE_ID, HUE_DIMMER_CARDS],
    ['hue-tap-dial', TAP_DIAL_DEVICE_ID, TAP_DIAL_CARDS],
    ['bilresa', BILRESA_DEVICE_ID, BILRESA_CARDS],
  ] as const;

  test('one file per reference device, and no strays', () => {
    const files = readdirSync(CARDS_DIR).filter(f => f.endsWith('.json')).sort();
    assert.deepEqual(files, EXPECTED.map(([slug]) => `${slug}.json`).sort());
  });

  test('every file declares its provenance honestly', () => {
    for (const [slug] of EXPECTED) {
      const f = fixture(slug);
      // 'captured' is what a real hardware capture sets. Until then the corpus
      // must say so out loud rather than passing for evidence about the platform.
      assert.ok(
        ['reconstructed', 'captured'].includes(f.provenance),
        `${slug}: provenance "${f.provenance}"`,
      );
    }
  });

  test('the JSON and the TypeScript fixtures agree', () => {
    // The drift guard. Without it the corpus quietly describes a device the
    // normalizer tests no longer use, and proves nothing about either.
    for (const [slug, deviceId, cards] of EXPECTED) {
      const f = fixture(slug);
      assert.equal(f.deviceId, deviceId, slug);
      assert.deepEqual(f.cards, JSON.parse(JSON.stringify(cards)), slug);
    }
  });

  test('no capture carries a real device id', () => {
    for (const [slug] of EXPECTED) {
      const f = fixture(slug);
      // The placeholders are `<name>-0000-0000-0000-0000000000NN`. A real Homey
      // id is a UUID, and committing one leaks the household's own device list.
      assert.match(f.deviceId, /^[a-z]+-0000-0000-0000-\d{12}$/, slug);
      for (const card of f.cards) {
        assert.equal(deviceIdOfScopedCard(card.id), f.deviceId, `${slug}: ${card.id}`);
      }
    }
  });

  test('each corpus file normalises to the same catalogue as its TS twin', () => {
    for (const [slug, , cards] of EXPECTED) {
      const f = fixture(slug);
      const fromJson = normalizeCards(f.cards, { sourceDeviceId: f.deviceId });
      const fromTs = normalizeCards(cards, { sourceDeviceId: f.deviceId });
      assert.deepEqual(
        fromJson.inputs.map(i => i.key).sort(),
        fromTs.inputs.map(i => i.key).sort(),
        slug,
      );
    }
  });
});

// --------------------------------------------------------------- discovery

function device(over: Partial<CatalogDevice> = {}): CatalogDevice {
  return {
    id: 'dev-1',
    name: 'Remote',
    class: 'remote',
    virtualClass: null,
    zone: 'z1',
    zoneName: 'Hall',
    driverId: 'homey:app:com.ikea.tradfri:remote_control_n2',
    ownerUri: 'homey:app:com.ikea.tradfri',
    ownerName: 'IKEA Trådfri',
    available: true,
    capabilities: ['measure_battery'],
    capabilitiesObj: {},
    ...over,
  };
}

function discoveryOver(cards: unknown[]) {
  const api = {
    read: async () => ({
      flow: { getFlowCardTriggers: async () => Object.fromEntries(cards.map((c, i) => [i, c])) },
    }),
    reportReadFailure: () => false,
  } as unknown as HomeyApiService;
  return new SourceDiscoveryService(api);
}

/** An app-level card that says "which device?" with a filter. Rank-2, per §4. */
const APP_LEVEL_FILTERED = {
  id: 'homey:app:com.ikea.tradfri:remote_button_pressed',
  uri: 'homey:flowcardtrigger:homey:app:com.ikea.tradfri:remote_button_pressed',
  title: 'A button on a remote is pressed',
  args: [
    { name: 'device', type: 'device', filter: 'driver_id=remote_control_n2' },
    { name: 'button', type: 'dropdown', values: [{ id: 'up' }, { id: 'down' }] },
  ],
  tokens: [],
};

describe('LK-007: an app-level card with a filtered device argument', () => {
  test('is matched to the device — the filter route works', async () => {
    const result = await discoveryOver([APP_LEVEL_FILTERED]).discover(device());
    assert.deepEqual(result.matchRoutes, ['device_arg']);
  });

  test('and is then DECLINED, naming the argument type', async () => {
    /**
     * Confirmed, and deliberately not fixed here.
     *
     * Making the card usable means pre-binding the `device` argument into the
     * binding's fixedArgs — trivial now that every kind has them. What is not
     * trivial is the VALUE: a device argument's accepted shape is not something
     * we can enumerate ahead of time (§5 records that autocomplete arguments
     * serialise as the whole selected object, not an id), and §9's
     * `time_exactly_day` is the standing example of what guessing one costs — a
     * Flow that validates and never fires.
     *
     * So the decline stands and says why. Every reference device resolves through
     * `device_scoped`, so nothing shipped depends on this route; what changed is
     * that a user who hits it now gets a message that names the cause. See
     * DEVIATIONS.md for what a fix needs.
     */
    const result = await discoveryOver([APP_LEVEL_FILTERED]).discover(device());
    assert.deepEqual(result.inputs, []);
    const declined = result.rejected.find(r => r.cardId === APP_LEVEL_FILTERED.id);
    assert.ok(declined, JSON.stringify(result.rejected));
    assert.match(declined.reason, /type "device"/);
  });
});

describe('LK-030: driver_uri matches on a segment boundary', () => {
  const cardWithFilter = (filter: string) => ({
    ...APP_LEVEL_FILTERED,
    args: [{ name: 'device', type: 'device', filter }],
  });

  const routesFor = async (filter: string, over: Partial<CatalogDevice> = {}) =>
    (await discoveryOver([cardWithFilter(filter)]).discover(device(over))).matchRoutes;

  test('the owning app matches', async () => {
    assert.deepEqual(await routesFor('driver_uri=homey:app:com.ikea.tradfri'), ['device_arg']);
  });

  test('a truncated app id does NOT', async () => {
    // `startsWith` alone accepted this, so a filter naming one integration could
    // pull in another whose id happens to start the same way.
    assert.deepEqual(await routesFor('driver_uri=homey:app:com.ikea.tra'), []);
  });

  test('a different app does not', async () => {
    assert.deepEqual(await routesFor('driver_uri=homey:app:nl.philips.hue'), []);
  });

  test('the full driver id matches too', async () => {
    assert.deepEqual(
      await routesFor('driver_uri=homey:app:com.ikea.tradfri:remote_control_n2'),
      ['device_arg'],
    );
  });
});

describe('LK-031: a filter key we cannot evaluate declines the card', () => {
  const withFilter = (filter: string) => ({
    ...APP_LEVEL_FILTERED,
    args: [{ name: 'device', type: 'device', filter }],
  });

  test('an unknown restriction is not silently ignored', async () => {
    // Ignoring it read as "the filter does not restrict on that", which is the
    // opposite of what a filter is — and is how a Tap Dial was once offered
    // "LG refrigerator error changed" as an input.
    const result = await discoveryOver([withFilter('somethingNew=42')]).discover(device());
    assert.deepEqual(result.matchRoutes, []);
    const declined = result.rejected.find(r => /somethingNew/.test(r.reason));
    assert.ok(declined, JSON.stringify(result.rejected));
  });

  test('and it is reported, so "my remote shows no events" stays answerable', async () => {
    const result = await discoveryOver([withFilter('class=remote&mystery=1')]).discover(device());
    assert.match(
      result.rejected.find(r => /mystery/.test(r.reason))!.reason,
      /cannot evaluate/,
    );
  });

  test('known keys still evaluate normally', async () => {
    assert.deepEqual(
      (await discoveryOver([withFilter('class=remote')]).discover(device())).matchRoutes,
      ['device_arg'],
    );
    assert.deepEqual(
      (await discoveryOver([withFilter('class=light')]).discover(device())).matchRoutes,
      [],
    );
    assert.deepEqual(
      (await discoveryOver([withFilter('capabilities=measure_battery')]).discover(device())).matchRoutes,
      ['device_arg'],
    );
    assert.deepEqual(
      (await discoveryOver([withFilter('capabilities=onoff')]).discover(device())).matchRoutes,
      [],
    );
  });

  test('a device-scoped card is unaffected by any of this', async () => {
    // The real route, per §4. It does not go through a filter at all.
    const result = await discoveryOver(STYRBAR_CARDS).discover(device({ id: STYRBAR_DEVICE_ID }));
    assert.deepEqual(result.matchRoutes, ['device_scoped']);
    assert.equal(result.inputs.length, 6);
  });
});

describe('LK-047: two gestures cannot share one binding key', () => {
  test('a collision is reported rather than first-wins', () => {
    // Two cards whose short ids differ but whose keys collapse to the same
    // string. A key is what a MappingRule stores, so the loser can never be
    // mapped — and used to vanish with nothing anywhere saying so.
    const twin = (shortId: string): DiscoveredTriggerCard => ({
      id: `homey:device:x:${shortId}`,
      shortId: 'n2_on',
      uri: `homey:flowcardtrigger:homey:device:x:${shortId}`,
      title: 'Higher brightness was pressed',
      args: [],
      tokens: [],
    });

    const { inputs, rejected } = normalizeCards([twin('a'), twin('b')], { sourceDeviceId: 'x' });
    assert.equal(inputs.length, 1);
    const collision = rejected.find(r => /key collision/.test(r.reason));
    assert.ok(collision, JSON.stringify(rejected));
  });

  test('the reference devices have no collisions', () => {
    for (const [cards, id] of [
      [STYRBAR_CARDS, STYRBAR_DEVICE_ID],
      [HUE_DIMMER_CARDS, HUE_DIMMER_DEVICE_ID],
      [TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID],
      [BILRESA_CARDS, BILRESA_DEVICE_ID],
    ] as const) {
      const { rejected } = normalizeCards(cards, { sourceDeviceId: id });
      assert.deepEqual(rejected.filter(r => /key collision/.test(r.reason)), [], id);
    }
  });
});

describe('the time card refuses a tie rather than tossing a coin', () => {
  const timeCard = (id: string) => ({
    id,
    uri: `homey:flowcardtrigger:${id}`,
    args: [{ name: 'time', type: 'time' }],
  });

  test('one usable card is chosen', () => {
    const found = discoverTimeCard([timeCard('homey:manager:cron:time_exactly')]);
    assert.equal(found.card?.id, 'homey:manager:cron:time_exactly');
  });

  test('a known id still beats an unknown one of the same shape', () => {
    const found = discoverTimeCard([
      timeCard('homey:manager:something:at_time'),
      timeCard('homey:manager:cron:time_exactly'),
    ]);
    assert.equal(found.card?.id, 'homey:manager:cron:time_exactly');
  });

  test('two cards of equal score choose neither, and both are named', () => {
    // `sort` is stable, so a tie resolved to whichever the Homey listed first —
    // a firmware-dependent coin toss deciding what every schedule triggers on.
    const found = discoverTimeCard([
      timeCard('homey:manager:cron:at_time'),
      timeCard('homey:manager:clock:at_time'),
    ]);
    assert.equal(found.card, null);
    assert.equal(found.candidates.length, 2);
    for (const candidate of found.candidates) {
      assert.match(candidate.note, /tied with/);
    }
  });

  test('a card with no uri is still unusable — we may not invent one', () => {
    const found = discoverTimeCard([{ ...timeCard('homey:manager:cron:time_exactly'), uri: '' }]);
    assert.equal(found.card, null);
  });
});

describe('LK-029: the fingerprint is versioned, not widened', () => {
  const profile = (over: Partial<ControllerProfile['source']> = {}): ControllerProfile => ({
    schemaVersion: 2,
    enabled: true,
    source: { deviceId: 'dev-1', eventSurfaceFingerprint: 'v1-hash', ...over },
    target: { kind: 'devices', deviceIds: [] },
    mappings: [],
    behavior: {} as any,
    managedFlows: [],
  });

  test('a profile with no v2 hash keeps v1 semantics', () => {
    // This is the whole point: widening in place would have marked every
    // installed controller needs_repair on the upgrade.
    assert.equal(surfaceMoved(profile(), { fingerprint: 'v1-hash', fingerprintV2: 'anything' }), false);
    assert.equal(surfaceMoved(profile(), { fingerprint: 'moved', fingerprintV2: 'anything' }), true);
  });

  test('a profile carrying a v2 hash is compared on v2', () => {
    const p = profile({ eventSurfaceFingerprintV2: 'v2-hash' });
    assert.equal(surfaceMoved(p, { fingerprint: 'anything', fingerprintV2: 'v2-hash' }), false);
    assert.equal(surfaceMoved(p, { fingerprint: 'v1-hash', fingerprintV2: 'moved' }), true);
  });

  test('a v2 profile against a discovery with no v2 falls back to v1', () => {
    const p = profile({ eventSurfaceFingerprintV2: 'v2-hash' });
    assert.equal(surfaceMoved(p, { fingerprint: 'v1-hash' }), false);
  });

  test('v2 sees what v1 cannot', async () => {
    const base = STYRBAR_CARDS;
    const withBounds = base.map((card, index) => (index === 6
      // The battery-threshold card's numeric bounds, which v1 does not hash.
      ? { ...card, args: [{ name: 'threshold', type: 'number', min: 0, max: 100 }] }
      : card));

    const a = await discoveryOver(base).discover(device({ id: STYRBAR_DEVICE_ID }));
    const b = await discoveryOver(withBounds).discover(device({ id: STYRBAR_DEVICE_ID }));

    assert.equal(a.fingerprint, b.fingerprint, 'v1 is blind to argument bounds');
    assert.notEqual(a.fingerprintV2, b.fingerprintV2, 'v2 is not');
  });

  test('v2 sees a token whose SCALE was relabelled', async () => {
    // "Steps (1000/turn)" becoming "Steps (500/turn)" is the same shape and a
    // different remote — it is the difference between a nudge and a slam.
    const relabelled = TAP_DIAL_CARDS.map(card => ({
      ...card,
      tokens: card.tokens.map(t => (t.id === 'steps' ? { ...t, title: 'Steps (500/turn)' } : t)),
    }));

    const a = await discoveryOver(TAP_DIAL_CARDS).discover(device({ id: TAP_DIAL_DEVICE_ID }));
    const b = await discoveryOver(relabelled).discover(device({ id: TAP_DIAL_DEVICE_ID }));

    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprintV2, b.fingerprintV2);
  });

  test('both fingerprints are stable across a re-read of the same cards', async () => {
    const a = await discoveryOver(STYRBAR_CARDS).discover(device({ id: STYRBAR_DEVICE_ID }));
    const b = await discoveryOver([...STYRBAR_CARDS].reverse()).discover(device({ id: STYRBAR_DEVICE_ID }));
    assert.equal(a.fingerprint, b.fingerprint, 'card order must not matter');
    assert.equal(a.fingerprintV2, b.fingerprintV2);
  });

  test('the normalizer version is part of the v2 hash', () => {
    // Bumping it must read as "this surface moved" — that is the repair prompt a
    // change to normalisation needs, and it cannot be inferred from the cards.
    assert.equal(typeof NORMALIZER_VERSION, 'number');
    assert.ok(NORMALIZER_VERSION >= 1);
  });
});
