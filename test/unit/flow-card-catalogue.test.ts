import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowCardCatalogue, NO_CACHE, toDiscoveredCard } from '../../lib/flow-card-catalogue';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * The catalogue exists for one reason: `homey-api` retains every item returned
 * by a `getAll` call, permanently, and the two card catalogues are ~11.6 MB
 * each on a real Homey (platform §15). Every test here is about that — what is
 * asked for, how often, and how much of the answer is kept.
 *
 * The single-flight and TTL cases are not performance tests. They stand in for
 * the cache that was deliberately given up: `HealthMonitor.findReattachCandidate`
 * calls `discover()` once per plausible device in a loop, and without them that
 * loop becomes N full catalogue fetches.
 */

interface Call {
  operation: 'triggers' | 'actions';
  options: unknown;
}

function fakeApi(cards: unknown[] = [], options: { fail?: () => boolean } = {}) {
  const calls: Call[] = [];
  const failures: unknown[] = [];
  const asRecord = () => Object.fromEntries(cards.map((c, i) => [`c${i}`, c]));

  const api = {
    read: async () => ({
      flow: {
        getFlowCardTriggers: async (opts: unknown) => {
          calls.push({ operation: 'triggers', options: opts });
          if (options.fail?.()) throw new Error('socket hang up');
          return asRecord();
        },
        getFlowCardActions: async (opts: unknown) => {
          calls.push({ operation: 'actions', options: opts });
          if (options.fail?.()) throw new Error('socket hang up');
          return asRecord();
        },
      },
    }),
    reportReadFailure: (error: unknown) => {
      failures.push(error);
      return true;
    },
  } as unknown as HomeyApiService;

  return { api, calls, failures };
}

/** One card carrying everything a real one does, most of which we must drop. */
const FAT_CARD = {
  id: 'homey:device:dial-1:tapdial_button_pressed',
  uri: 'homey:flowcardtrigger:homey:device:dial-1:tapdial_button_pressed',
  title: { en: 'Button pressed', nl: 'Knop ingedrukt', de: 'Taste gedrückt' },
  titleFormatted: { en: 'Button [[button]] pressed', nl: 'Knop [[button]] ingedrukt' },
  hint: { en: 'Fires when a button is pressed', nl: 'Wordt geactiveerd' },
  iconObj: { id: 'abc123', url: '/icon/abc123' },
  color: '#ff6600',
  deprecated: false,
  args: [
    {
      name: 'button',
      type: 'dropdown',
      title: { en: 'Button', nl: 'Knop' },
      values: [{ id: 'button1', title: { en: 'Top', nl: 'Boven' } }],
    },
  ],
  tokens: [{ id: 'steps', type: 'number', title: { en: 'Steps (1000/turn)', nl: 'Stappen' } }],
};

describe('flow card catalogue', () => {
  test('the fetch opts out of the homey-api cache in BOTH directions', async () => {
    const { api, calls } = fakeApi([FAT_CARD]);
    await new FlowCardCatalogue(api).triggerCards();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.options, { $cache: false, $updateCache: false });
    // $cache alone only skips the cache READ; $updateCache is the half that
    // stops the 16.8 MB being written. Both, or nothing is saved.
    assert.deepEqual({ ...NO_CACHE }, { $cache: false, $updateCache: false });
  });

  test('concurrent callers share ONE fetch', async () => {
    const { api, calls } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api);

    const [a, b] = await Promise.all([catalogue.triggerCards(), catalogue.triggerCards()]);

    assert.equal(calls.length, 1, 'two callers must not each pay for the catalogue');
    assert.equal(a, b, 'and they must get the same projection back');
  });

  test('a second call inside the TTL does not refetch; one past it does', async () => {
    let now = 1_000;
    const { api, calls } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api, { ttlMs: 1_000, now: () => now });

    await catalogue.triggerCards();
    now += 999;
    await catalogue.triggerCards();
    assert.equal(calls.length, 1, 'inside the TTL the held projection answers');

    now += 2;
    await catalogue.triggerCards();
    assert.equal(calls.length, 2, 'past it, the cards are read again');
  });

  test('a failed fetch is not cached, and the client is told', async () => {
    let broken = true;
    const { api, calls, failures } = fakeApi([FAT_CARD], { fail: () => broken });
    const catalogue = new FlowCardCatalogue(api);

    await assert.rejects(() => catalogue.triggerCards(), /socket hang up/);
    assert.equal(failures.length, 1, 'a dead socket must be reported so the client is rebuilt');

    broken = false;
    const cards = await catalogue.triggerCards();
    assert.equal(calls.length, 2, 'a rejection cached forever is what this guards against');
    assert.equal(cards.length, 1);
  });

  test('clear() drops what is held', async () => {
    const { api, calls } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api);

    await catalogue.triggerCards();
    catalogue.clear();
    await catalogue.triggerCards();

    assert.equal(calls.length, 2);
  });

  describe('finding our own action cards', () => {
    const APP_ID = 'com.thomassidor.lightkeeper';

    /**
     * The app needs three cards. Reading ~1700 to find them is ~12 MB the
     * process never gets back (platform §15), so the catalogue read must be
     * the fallback and not the first thing tried.
     */
    function bridgeOver(options: { cardsByName?: boolean } = {}) {
      const asked: string[] = [];
      let enumerated = 0;
      const client = {
        flow: {
          getFlowCardAction: async ({ uri, id }: { uri: string; id: string }) => {
            asked.push(`${uri}|${id}`);
            if (!options.cardsByName) throw new Error('404 Not Found');
            // Echoed exactly as the Homey composes them — never assembled here.
            return { id: `${APP_ID}:${id}`, uri: `homey:flowcardaction:${APP_ID}:${id}` };
          },
          getFlowCardActions: async () => {
            enumerated += 1;
            return Object.fromEntries(
              ['bridge_event', 'bridge_numeric_event', 'bridge_token_event'].map(name => [
                name,
                { id: `${APP_ID}:${name}`, uri: `homey:flowcardaction:${APP_ID}:${name}`, bulk: 'x' },
              ]),
            );
          },
        },
      };
      const api = { read: async () => client, reportReadFailure: () => false } as unknown as HomeyApiService;
      return {
        asked,
        get enumerated() { return enumerated; },
        bridge: new FlowBridgeManager(api, APP_ID, () => { /* quiet */ }),
      };
    }

    test('the three are asked for by name, and the catalogue is never read', async () => {
      const rig = bridgeOver({ cardsByName: true });

      const refs = await rig.bridge.bridgeCards();

      assert.equal(rig.enumerated, 0, 'reading 1700 cards to find 3 is the whole cost');
      assert.deepEqual(rig.asked, [
        `homey:app:${APP_ID}|bridge_event`,
        `homey:app:${APP_ID}|bridge_numeric_event`,
        `homey:app:${APP_ID}|bridge_token_event`,
      ]);
      // Echoed back verbatim, never constructed here (platform §3).
      assert.equal(refs.event.id, `${APP_ID}:bridge_event`);
      assert.equal(refs.event.uri, `homey:flowcardaction:${APP_ID}:bridge_event`);
    });

    test('a Homey that will not answer for one card falls back to enumerating', async () => {
      const rig = bridgeOver({ cardsByName: false });

      const refs = await rig.bridge.bridgeCards();

      assert.equal(rig.enumerated, 1, 'the fallback is what keeps platform §3 honest');
      assert.equal(refs.token.id, `${APP_ID}:bridge_token_event`);
    });
  });

  test('action cards are reduced to id and uri, and nothing else', async () => {
    const { api } = fakeApi([{
      ...FAT_CARD,
      id: 'com.example:do_thing',
      uri: 'homey:flowcardaction:com.example:do_thing',
    }]);

    const refs = await new FlowCardCatalogue(api).actionCardRefs();

    assert.deepEqual(refs, [{
      id: 'com.example:do_thing',
      uri: 'homey:flowcardaction:com.example:do_thing',
    }]);
  });

  describe('the projection', () => {
    const card = toDiscoveredCard(FAT_CARD);

    test('keeps only the fields the app reads', () => {
      assert.deepEqual(
        Object.keys(card).sort(),
        ['args', 'id', 'shortId', 'title', 'tokens', 'uri'],
      );
      const serialised = JSON.stringify(card);
      for (const dropped of ['titleFormatted', 'hint', 'iconObj', 'color', 'deprecated']) {
        assert.equal(serialised.includes(dropped), false, `${dropped} must not be carried`);
      }
    });

    test('flattens every title to English — the app ships English only', () => {
      assert.equal(card.title, 'Button pressed');
      assert.equal(card.args[0]!.values![0]!.title, 'Top');
      // The token title carries the SCALE — "Steps (1000/turn)" — so flattening
      // it must not lose it; magnitudePerTurnOf() reads that number.
      assert.equal(card.tokens[0]!.title, 'Steps (1000/turn)');
      assert.equal(JSON.stringify(card).includes('Knop'), false, 'no other locale survives');
    });

    test('a device-scoped id keeps its trailing segment as shortId', () => {
      assert.equal(card.shortId, 'tapdial_button_pressed');
      assert.equal(
        toDiscoveredCard({ id: 'homey:app:com.example:pressed' }).shortId,
        'homey:app:com.example:pressed',
        'an app-level card has no trailing segment to take',
      );
    });

    test('a card missing everything optional still projects', () => {
      assert.deepEqual(toDiscoveredCard({ id: 'x' }), {
        id: 'x', shortId: 'x', uri: '', title: 'x', args: [], tokens: [],
      });
    });
  });
});
