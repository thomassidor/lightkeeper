import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FlowCardCatalogue, NO_CACHE, toDiscoveredCard } from '../../lib/flow-card-catalogue';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import { HomeyApiService } from '../../lib/homey-api-service';
import type { CredentialService } from '../../lib/credential-service';
import { FakeTimers } from '../support/fake-timers';
import { DeviceCatalog, type CatalogDevice } from '../../lib/device-catalog';
import { fingerprintOf, fingerprintV2Of } from '../../lib/source-discovery-service';

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

  /**
   * The TTL used to be checked only on a read, so the projection outlived it
   * until the next read replaced it: once anything had asked, the trigger cards
   * (~1.1 MB of heap for 1700 cards, platform §15) stayed for the whole run.
   */
  test('the projection is let go when the TTL runs out, not when the next read comes', async () => {
    const timers = new FakeTimers(1_000);
    const { api, calls } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api, { ttlMs: 1_000, timers });

    await catalogue.triggerCards();
    assert.equal(catalogue.stats().triggers.retained, true);
    assert.equal(timers.pending, 1, 'one release timer per held projection');

    timers.advance(999);
    await catalogue.triggerCards();
    assert.equal(calls.length, 1, 'inside the TTL the held projection still answers');
    assert.equal(catalogue.stats().triggers.retained, true);

    timers.advance(1);
    assert.equal(catalogue.stats().triggers.retained, false, 'released on time, with nothing asking');
    assert.equal(timers.pending, 0);

    await catalogue.triggerCards();
    assert.equal(calls.length, 2, 'the next question reads the cards again');
  });

  test('a refetch re-arms the release rather than stacking a second timer', async () => {
    const timers = new FakeTimers();
    const { api } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api, { ttlMs: 1_000, timers });

    await catalogue.triggerCards();
    await catalogue.actionCardRefs();
    assert.equal(timers.pending, 2, 'one per catalogue');

    timers.advance(1_000);
    await catalogue.triggerCards();
    assert.equal(timers.pending, 1, 'the triggers re-armed once; the actions were released');
  });

  /** Nothing survives teardown: `onUninit` calls `clear()`, and it must leave no timer. */
  test('clear() leaves no release timer pending', async () => {
    const timers = new FakeTimers();
    const { api } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api, { timers });

    await catalogue.triggerCards();
    await catalogue.actionCardRefs();
    catalogue.clear();

    assert.equal(timers.pending, 0);
    assert.equal(catalogue.stats().triggers.retained, false);
    assert.equal(catalogue.stats().actions.retained, false);
  });

  /**
   * The same promise for a read that was still in flight when `clear()` ran:
   * teardown does not wait for a health pass to finish asking for cards.
   */
  test('a read in flight across clear() answers its caller and keeps nothing', async () => {
    const timers = new FakeTimers();
    const { api, calls } = fakeApi([FAT_CARD]);
    const catalogue = new FlowCardCatalogue(api, { timers });

    const inFlight = catalogue.triggerCards();
    catalogue.clear();
    assert.equal((await inFlight).length, 1, 'its own caller still gets the cards');

    assert.equal(timers.pending, 0, 'no release timer armed after teardown');
    assert.equal(catalogue.stats().triggers.retained, false, 'and no projection retained');
    await catalogue.triggerCards();
    assert.equal(calls.length, 2, 'the next question is a fresh read, not the one let go of');
  });

  /** For `/diagnostics`: how often the expensive read happens, and what it costs. */
  test('stats count reads, failures, duration and size, and never carry a card', async () => {
    const timers = new FakeTimers();
    let broken = false;
    const { api } = fakeApi([FAT_CARD, FAT_CARD], { fail: () => broken });
    const catalogue = new FlowCardCatalogue(api, { ttlMs: 1_000, timers });

    await catalogue.triggerCards();
    await catalogue.triggerCards();
    timers.advance(1_000);
    broken = true;
    await assert.rejects(() => catalogue.triggerCards());

    const stats = catalogue.stats();
    assert.deepEqual(stats.triggers, { fetches: 2, failures: 1, lastMs: 0, lastCount: 2, retained: false });
    assert.deepEqual(stats.actions, { fetches: 0, failures: 0, lastMs: null, lastCount: null, retained: false });
    assert.ok(!JSON.stringify(stats).includes('tapdial'), 'counts only, never a card');
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

    /**
     * An argument's `name` and `type` are STRINGS, whatever the card said.
     *
     * `CardArgument` declares both as `string` and this assigned them raw, so a
     * card with a nameless argument produced `name: undefined` behind a type
     * that promised otherwise. `buildFingerprint` in source-discovery-service.ts
     * then sorts a card's arguments with `a.name.localeCompare(b.name)` — which
     * throws `TypeError` on `undefined`, inside `discover()`, i.e. inside the
     * remote picker, the health check's re-attach scan and the reconcile path,
     * for every device on the Homey rather than just the offending one.
     *
     * Two arguments, because a one-element sort never calls its comparator and
     * the bug would hide.
     */
    test('an argument with no name projects to a string, not undefined', () => {
      const card = toDiscoveredCard({
        id: 'x',
        args: [{ type: 'dropdown' }, { name: 'zone', type: 'autocomplete' }],
      });

      assert.equal(card.args[0]!.name, '');
      assert.equal(card.args[0]!.type, 'dropdown');
      assert.equal(typeof card.args[1]!.name, 'string');

      // The REAL fingerprints, both versions, which is where the sort that used
      // to throw lives. A hash of the right shape is the assertion; a copy of
      // the sort written here would only prove the copy.
      const device = { ownerUri: 'homey:app:x', driverId: 'remote' } as CatalogDevice;
      assert.match(fingerprintOf(device, [card]), /^[0-9a-f]{32}$/);
      assert.match(fingerprintV2Of(device, [card]), /^[0-9a-f]{32}$/);
    });

    test('a non-string name is coerced rather than carried', () => {
      const card = toDiscoveredCard({ id: 'x', args: [{ name: 7, type: null }] });
      assert.equal(card.args[0]!.name, '7');
      assert.equal(card.args[0]!.type, '');
    });
  });
});

/**
 * Platform §15's rule, enforced: a `getAll` call site either passes `NO_CACHE`
 * or is a deliberate, NAMED exception.
 *
 * The rule was prose, and prose is what a new call site forgets. The set of
 * operations that ARE `getAll` is not guessed from their names — §15 is blunt
 * that it is a property of the specification — so it is read from the very
 * specification `homey-api` builds its managers from. A `getAll` added to the
 * client in a later version is covered the day the pin moves.
 *
 * What counts as the opt-out: `NO_CACHE` or `$updateCache: false` inside the
 * call's own parentheses, which may run over a few lines — not merely nearby.
 *
 * What counts as an exception, and this is narrower than it was. It used to be
 * any comment citing §15 within FORTY lines above the call, and that excused
 * the very comments that explain why `NO_CACHE` IS passed: dropping the flag
 * from `getFlowCardActions` or `getFlowFolders` left the scan green. Now it is
 * one of two things, both local and both explicit:
 *
 *   - a `§15: retained` marker on the call's own line or the line directly
 *     above it, for a new site that argues its case where it stands; or
 *   - an entry in `RETAINED` below, which names the file and the operation and
 *     points at the BEHAVIOURAL test that pins why. The three sites that rely
 *     on it today argue their case in a docblock some lines up, and moving a
 *     marker into the source is not this file's call to make.
 */
describe('every getAll call site opts out of the cache, or says why not', () => {
  const ROOT = join(import.meta.dirname, '..', '..');

  function getAllOperations(): Array<{ manager: string; operation: string }> {
    const spec = JSON.parse(readFileSync(
      join(ROOT, 'node_modules', 'homey-api', 'assets', 'specifications', 'HomeyAPIV3Local.json'),
      'utf8',
    )) as { managers: Record<string, { idCamelCase: string; operations?: Record<string, any> }> };
    const found: Array<{ manager: string; operation: string }> = [];
    for (const manager of Object.values(spec.managers)) {
      for (const [operation, definition] of Object.entries(manager.operations ?? {})) {
        if (definition?.crud?.type === 'getAll') found.push({ manager: manager.idCamelCase, operation });
      }
    }
    return found;
  }

  function sources(): string[] {
    const found = ['api.ts', 'app.ts'];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) found.push(path);
      }
    };
    walk('lib');
    return found;
  }

  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

  test('the specification still names the getAll operations this app uses', () => {
    // Without this the scan below could pass by finding no operations at all.
    const names = getAllOperations().map(o => `${o.manager}.${o.operation}`);
    for (const expected of ['flow.getFlows', 'flow.getFlowCardTriggers', 'devices.getDevices', 'zones.getZones']) {
      assert.ok(names.includes(expected), `${expected} is no longer a getAll in the pinned homey-api`);
    }
  });

  /**
   * The deliberate exceptions, each one a file, an operation and the test that
   * pins its reason. Exact: an entry that no longer matches a site fails too,
   * so this list cannot outlive the code it excuses.
   */
  const RETAINED: Array<{ file: string; call: string; pinnedBy: string }> = [
    // Measured: opting out raised the floor by 5 MB (DeviceCatalog.refreshNow).
    { file: 'lib/device-catalog.ts', call: 'devices.getDevices', pinnedBy: 'the catalogue reads devices and zones WITH the cache' },
    { file: 'lib/device-catalog.ts', call: 'zones.getZones', pinnedBy: 'the catalogue reads devices and zones WITH the cache' },
    // Retains nothing: `homey-api` caches a getAll only while the manager is connected.
    { file: 'lib/device-catalog.ts', call: 'apps.getApps', pinnedBy: 'the read client never connects apps' },
  ];

  /** The text between a call's own parentheses, `open` being the index of `(` in `text`. */
  function argumentsOf(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && (depth -= 1) === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  }

  test('no call site retains a getAll silently', () => {
    const operations = getAllOperations();
    const pattern = new RegExp(
      String.raw`\.(${[...new Set(operations.map(o => o.manager))].join('|')})\??\.`
      + String.raw`(${[...new Set(operations.map(o => o.operation))].join('|')})\(`,
    );
    const isGetAll = (manager: string, operation: string) =>
      operations.some(o => o.manager === manager && o.operation === operation);
    const marker = /\/[/*].*§15: retained/;

    const offenders: string[] = [];
    const excused = new Map<string, number>();
    let sites = 0;
    for (const file of sources()) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        const match = pattern.exec(line);
        if (!match || !isGetAll(match[1]!, match[2]!)) return;
        sites += 1;
        const text = lines.slice(index, index + 8).join('\n');
        const args = argumentsOf(text, match.index + match[0].length - 1);
        if (/NO_CACHE|\$updateCache:\s*false/.test(args)) return;
        if (marker.test(line) || marker.test(lines[index - 1] ?? '')) return;
        const call = `${match[1]}.${match[2]}`;
        if (RETAINED.some(r => r.file === file && r.call === call)) {
          excused.set(`${file} ${call}`, (excused.get(`${file} ${call}`) ?? 0) + 1);
          return;
        }
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }

    assert.ok(sites >= 5, `found only ${sites} getAll call sites — is the scan still finding them?`);
    assert.deepEqual(
      offenders, [],
      'a getAll that neither passes NO_CACHE in its own arguments, nor carries a '
      + '"§15: retained" marker on or directly above its line, nor is named in RETAINED',
    );
    assert.deepEqual(
      Object.fromEntries(excused),
      Object.fromEntries(RETAINED.map(r => [`${r.file} ${r.call}`, 1])),
      'each RETAINED entry excuses exactly one live call site — remove an entry whose site is gone',
    );
  });

  test('the scan reads a call\'s own arguments, not the lines around it', () => {
    // Self-test of the parser the scan stands on: a NO_CACHE on the NEXT
    // statement used to excuse a call that passed nothing.
    const text = 'await client.flow.getFlowFolders();\nconst opts = NO_CACHE;';
    assert.equal(argumentsOf(text, text.indexOf('(')), '');
    const multi = 'client.flow.getFlowFolders({\n  ...NO_CACHE,\n})';
    assert.match(argumentsOf(multi, multi.indexOf('(')), /NO_CACHE/);
  });
});

/**
 * What the scan's call sites actually SEND, asserted against the client.
 *
 * A source scan can be satisfied by text; these cannot. Each is a call site the
 * old 40-line exemption let lose its flag unnoticed, or one the scan cannot
 * see at all, or one of the deliberate exceptions in `RETAINED` above.
 */
describe('platform §15, behaviourally', () => {
  test('the action catalogue — the fallback\'s read — opts out in both directions', async () => {
    const { api, calls } = fakeApi([FAT_CARD]);

    await new FlowCardCatalogue(api).actionCardRefs();

    assert.deepEqual(calls, [{ operation: 'actions', options: { ...NO_CACHE } }]);
  });

  /**
   * RETAINED, first two entries. Not an oversight to be fixed by adding the
   * flag: opting out was measured on hardware at +5 MB of floor, because every
   * invalidation then re-parses every device (DeviceCatalog.refreshNow). The
   * correctness half is paid where it matters instead — single-device reads
   * pass `$cache: false` (see luminance-source.test.ts).
   */
  test('the catalogue reads devices and zones WITH the cache', async () => {
    const seen: Record<string, unknown[]> = { getDevices: [], getZones: [], getApps: [] };
    const record = (name: string, value: unknown) => async (...args: unknown[]) => {
      seen[name]!.push(args[0]);
      return value;
    };
    const client = {
      devices: {
        getDevices: record('getDevices', {
          d1: { id: 'd1', name: 'Lamp', zone: 'z', class: 'light', ownerUri: 'homey:app:com.example',
            capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } } },
        }),
        on: () => undefined, off: () => undefined,
      },
      zones: { getZones: record('getZones', { z: { id: 'z', name: 'Room', parent: null } }), on: () => undefined, off: () => undefined },
      apps: { getApps: record('getApps', { 'com.example': { id: 'com.example', name: 'Example' } }) },
    };
    const api = {
      read: async () => client, reportReadFailure: () => false,
      track: (off: unknown) => off, onReadReplacement: () => () => undefined,
    } as unknown as HomeyApiService;

    await new DeviceCatalog(api).device('d1');

    assert.deepEqual(seen, { getDevices: [undefined], getZones: [undefined], getApps: [undefined] },
      'measured, and retained on purpose — a change here is a §15 decision, not a tidy-up');
  });

  /**
   * RETAINED, third entry. `getApps()` passes no flag and retains nothing,
   * because `homey-api` writes a getAll into its cache only while the manager
   * `isConnected()` — and the read client never connects `apps`. That premise
   * is what this pins: connect `apps` and the exception stops being true.
   */
  test('the read client never connects apps', async () => {
    const connected: string[] = [];
    const manager = (name: string) => ({ connect: async () => { connected.push(name); } });
    const client: Record<string, unknown> = Object.fromEntries(
      ['devices', 'zones', 'apps', 'flow', 'flowtoken', 'insights'].map(name => [name, manager(name)]),
    );
    class Service extends HomeyApiService {
      protected override async createAppApi(): Promise<any> { return client; }
    }
    const service = new Service({ app: {} }, {} as CredentialService);

    await service.read();

    assert.deepEqual(connected, ['devices', 'zones']);
    assert.equal(connected.includes('apps'), false, 'a connected apps manager would cache every getApps()');
  });
});
