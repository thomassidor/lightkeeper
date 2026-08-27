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
});
