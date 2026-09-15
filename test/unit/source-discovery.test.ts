import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SourceDiscoveryService } from '../../lib/source-discovery-service';
import type { CatalogDevice } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * Discovery decides what a remote appears to be capable of, so what it
 * declines matters as much as what it offers.
 *
 * The rule (platform §4) is rank-last, never hard-filter: an unfiltered
 * `device`-typed argument matches every device on the Homey — it once offered
 * "LG refrigerator error changed" as an input for a Tap Dial — so it must not
 * reach the picker, but it must stay visible. It did not: the weak matches were
 * dropped on the floor, `MatchRoute`'s third member was unreachable, and the
 * comment claiming they were "kept reachable via diagnostics" was false.
 */

const DIAL: CatalogDevice = {
  id: 'dial-1',
  name: 'Tap Dial',
  class: 'button',
  virtualClass: null,
  zone: 'z1',
  zoneName: 'Living room',
  driverId: 'homey:app:nl.philips.hue:tapdial',
  ownerUri: 'homey:app:nl.philips.hue',
  ownerName: 'Philips Hue',
  available: true,
  capabilities: [],
  capabilitiesObj: {},
};

const service = (cards: Record<string, unknown>) => new SourceDiscoveryService({
  read: async () => ({ flow: { getFlowCardTriggers: async () => cards } }),
} as unknown as HomeyApiService);

describe('source discovery', () => {
  test('a device-scoped card is offered', async () => {
    const result = await service({
      a: {
        id: 'homey:device:dial-1:tapdial_button_pressed',
        uri: 'homey:flowcardtrigger:homey:device:dial-1:tapdial_button_pressed',
        title: 'Button pressed',
        args: [{ type: 'dropdown', name: 'button', values: [{ id: 'button1' }, { id: 'button2' }] }],
      },
    }).discover(DIAL);

    assert.equal(result.matchRoutes.includes('device_scoped'), true);
    assert.ok(result.inputs.length > 0, 'a device-scoped input card must be offered');
  });

  test('an unfiltered device argument is declined, not offered', async () => {
    const result = await service({
      fridge: {
        id: 'homey:app:com.lg.thinq:error_changed',
        uri: 'homey:flowcardtrigger:homey:app:com.lg.thinq:error_changed',
        title: 'Error changed',
        // No filter: the SDK's own semantics accept every device on the Homey.
        args: [{ type: 'device', name: 'device' }],
      },
    }).discover(DIAL);

    assert.deepEqual(result.inputs, [], 'an unfiltered match must never reach the picker');
    assert.deepEqual(result.matchRoutes, [], 'and must never be ranked into the catalogue');

    const declined = result.rejected.find(r => r.cardId === 'homey:app:com.lg.thinq:error_changed');
    assert.ok(declined, 'but it must be reported, or "no events found" has no answer');
    assert.match(declined.reason, /unfiltered device argument/);
  });

  test('a filtered device argument that matches is a real route', async () => {
    const result = await service({
      scoped: {
        id: 'homey:app:nl.philips.hue:dial_turned',
        uri: 'homey:flowcardtrigger:homey:app:nl.philips.hue:dial_turned',
        title: 'Dial turned',
        args: [{ type: 'device', name: 'device', filter: 'driver_id=tapdial' }],
      },
    }).discover(DIAL);

    assert.deepEqual(result.matchRoutes, ['device_arg']);
  });

  test('a card matching nothing is not reported at all', async () => {
    const result = await service({
      other: {
        id: 'homey:device:some-other-device:button_pressed',
        uri: 'homey:flowcardtrigger:homey:device:some-other-device:button_pressed',
        title: 'Button pressed',
      },
    }).discover(DIAL);

    assert.deepEqual(result.inputs, []);
    assert.deepEqual(result.rejected, [], 'no route at all is silence, not a rejection');
    assert.equal(result.cardsInspected, 1);
  });

  /**
   * The fingerprints are what HealthMonitor compares to decide "this remote now
   * exposes different events". If flattening titles at the projection boundary
   * (platform §15) changed either hash, every installed controller's stored
   * value would disagree with a freshly computed one on upgrade and the whole
   * Homey would report needs_repair about a surface that had not moved.
   */
  test('flattening a locale object to English does not move either fingerprint', async () => {
    const card = (title: unknown, tokenTitle: unknown) => ({
      dial: {
        id: 'homey:device:dial-1:tapdial_button_pressed',
        uri: 'homey:flowcardtrigger:homey:device:dial-1:tapdial_button_pressed',
        title,
        args: [{ type: 'dropdown', name: 'button', values: [{ id: 'button1' }] }],
        tokens: [{ id: 'steps', type: 'number', title: tokenTitle }],
      },
    });

    const multilingual = await service(
      card({ en: 'Button pressed', nl: 'Knop ingedrukt' }, { en: 'Steps (1000/turn)', nl: 'Stappen' }),
    ).discover(DIAL);
    const flattened = await service(
      card('Button pressed', 'Steps (1000/turn)'),
    ).discover(DIAL);

    assert.equal(multilingual.fingerprint, flattened.fingerprint);
    assert.equal(multilingual.fingerprintV2, flattened.fingerprintV2);
  });
});

/**
 * What `rankSources` counts, and why the picker can act on it.
 *
 * `eventCount` is no longer only a ranking hint: the remote picker splits on
 * it, drawing the devices with one and folding the rest away behind a row. So
 * it has to mean "a gesture Homey could offer", and a count of device-scoped
 * cards by id alone did not — every Homey device carries generated capability
 * cards, and a lamp's own `onoff_true`/`onoff_false` survived the state-card
 * filter. A house of fifty lamps was fifty two-event "remotes".
 */
describe('ranking sources for the picker', () => {
  const LAMP: CatalogDevice = {
    id: 'lamp-1',
    name: 'Floor lamp',
    class: 'light',
    virtualClass: null,
    zone: 'z1',
    zoneName: 'Living room',
    driverId: 'homey:app:nl.philips.hue:bulb',
    ownerUri: 'homey:app:nl.philips.hue',
    ownerName: 'Philips Hue',
    available: true,
    capabilities: ['onoff', 'dim'],
    capabilitiesObj: {},
  };

  const deviceCard = (deviceId: string, shortId: string, title: string) => ({
    id: `homey:device:${deviceId}:${shortId}`,
    uri: `homey:flowcardtrigger:homey:device:${deviceId}:${shortId}`,
    title,
    args: [],
  });

  test('a lamp switching on is not a gesture, and scores nothing', async () => {
    const ranked = await service({
      on: deviceCard('lamp-1', 'onoff_true', 'Turned on'),
      off: deviceCard('lamp-1', 'onoff_false', 'Turned off'),
      dim: deviceCard('lamp-1', 'dim_changed', 'The dim level changed'),
    }).rankSources([LAMP]);

    assert.deepEqual(ranked.map(r => r.eventCount), [0]);
  });

  test('a remote being pressed is, and its battery is not', async () => {
    const ranked = await service({
      press: deviceCard('dial-1', 'tapdial_button_pressed', 'A button is pressed'),
      hold: deviceCard('dial-1', 'tapdial_button_held', 'A button is long pressed'),
      battery: deviceCard('dial-1', 'measure_battery_changed', 'The battery level changed'),
    }).rankSources([DIAL]);

    assert.deepEqual(ranked.map(r => r.eventCount), [2]);
  });

  test('a filtered app-level card counts for the device it names, and for no other', async () => {
    // Discovery's other strong route (platform §4), and the reason a remote can
    // be usable with no device-scoped card of its own. Counting only the scoped
    // ones would fold such a remote away as if Homey had never heard of it.
    const ranked = await service({
      hue: {
        id: 'homey:app:nl.philips.hue:dial_pressed',
        uri: 'homey:flowcardtrigger:homey:app:nl.philips.hue:dial_pressed',
        title: 'A button is pressed',
        args: [{ type: 'device', name: 'device', filter: 'driver_id=tapdial' }],
      },
    }).rankSources([DIAL, LAMP]);

    assert.deepEqual(ranked.map(r => [r.device.id, r.eventCount]),
      [['dial-1', 1], ['lamp-1', 0]]);
  });

  test('an unfiltered device argument counts for nobody', async () => {
    // It accepts every device on the Homey, so counting it would add the same
    // number to every score and say nothing. It is discovery's weak route for
    // exactly that reason.
    const ranked = await service({
      any: {
        id: 'homey:app:com.example:something_pressed',
        uri: 'homey:flowcardtrigger:homey:app:com.example:something_pressed',
        title: 'Something is pressed',
        args: [{ type: 'device', name: 'device' }],
      },
    }).rankSources([DIAL, LAMP]);

    assert.deepEqual(ranked.map(r => r.eventCount), [0, 0]);
  });
});
