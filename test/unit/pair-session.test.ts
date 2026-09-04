import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  handlerRegistrar,
  newSessionOwner,
  registerDaylightCardHandlers,
  registerTargetHandlers,
  releaseOnDisconnect,
  timezoneOf,
  type PairSessionHost,
  type SharedSessionState,
} from '../../lib/pairing/pair-session';
import { DEFAULT_RESPONSE, MAX_LUX, MIN_LUX } from '../../lib/daylight/daylight-types';

/**
 * The pairing-session mechanics, tested for the first time.
 *
 * None of this could be reached before. It lived inside five files that each
 * contain `extends Homey.Driver`, and platform §13 means such a file cannot be
 * imported by a test at all — `require('homey')` resolves to the CLI in
 * `node_modules`, whose main executes the CLI, so the SDK module simply is not
 * there. The daylight card's three handlers carried a COMMENT asserting they
 * were identical on four drivers; that comment was the entire guarantee.
 *
 * Two things below are the ones that justified the extraction on their own:
 *
 *  - **The sensor ref-count.** A pairing screen retains lux sensors so the card
 *    can show what they read, and releases them on `disconnect` however the
 *    screen closes. Get that wrong and abandoning a half-finished pairing leaves
 *    a subscription on somebody's battery-powered motion sensor for as long as
 *    the app runs.
 *  - **The handler wrapper's fail-loud.** A handler that throws inside a pairing
 *    view surfaces as a screen that silently does nothing, which is why every
 *    handler is wrapped — and why the wrapper must RE-THROW rather than swallow.
 */

interface Recorded {
  logs: string[];
  errors: string[];
  retained: Array<{ sensors: string[]; owner: string }>;
  released: string[];
}

interface RigOptions {
  devices?: FakeDevice[];
  timezone?: () => string;
  release?: () => Promise<void>;
}

/**
 * Enough of `CatalogDevice` for the two pickers, and no more.
 *
 * `capabilitiesObj` is what the sensor picker reads a live lux value out of, and
 * `zoneName`/`available` are what it groups and greys by — all three are real
 * fields the pickers depend on, so the fake has to carry them or it proves
 * nothing about them.
 */
interface FakeDevice {
  id: string;
  name: string;
  zone: string;
  zoneName: string;
  available: boolean;
  capabilities: string[];
  capabilitiesObj: Record<string, { value?: unknown }>;
}

function lux(id: string, name: string, value: number | null): FakeDevice {
  return {
    id, name, zone: 'z1', zoneName: 'Hall', available: true,
    capabilities: ['measure_luminance'],
    capabilitiesObj: { measure_luminance: { value } },
  };
}

function lamp(id: string, name: string): FakeDevice {
  return {
    id, name, zone: 'z1', zoneName: 'Hall', available: true,
    capabilities: ['onoff', 'dim'],
    capabilitiesObj: { onoff: { value: true }, dim: { value: 0.5 } },
  };
}

/**
 * A host with no Homey behind it, and a session that records its handlers so a
 * test can call them the way a pairing view would.
 *
 * That the host is four plain members is the whole point of the seam: nothing
 * here names `Homey.Driver`, so this file loads.
 */
function rig(options: RigOptions = {}) {
  const recorded: Recorded = { logs: [], errors: [], retained: [], released: [] };
  const devices = options.devices
    ?? [lux('lux-1', 'Hall sensor', 120), lamp('lamp-1', 'Hall lamp')];

  const host = {
    log: (...args: unknown[]) => recorded.logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => recorded.errors.push(args.map(String).join(' ')),
    translate: (key: string) => `[${key}]`,
    clock: options.timezone ? { getTimezone: options.timezone } : undefined,
    app: {
      catalog: {
        allDevices: async () => devices,
        allZones: async () => [{ id: 'z1', name: 'Hall', parent: null }],
        device: async (id: string) => devices.find(d => d.id === id) ?? null,
        // The real predicates, reproduced: a light has `onoff` and is not ours.
        lightCandidates: async () => devices.filter(d => d.capabilities.includes('onoff')),
        lightsInZone: async () => devices.filter(d => d.capabilities.includes('onoff')),
        capabilitySummary: async () => ({}),
        isOwnDevice: () => false,
      },
      daylight: {
        evaluate: () => ({ brightness: 0.4, source: 'sensors' }),
        sky: () => ({ elevation: 12 }),
        sensors: () => [
          { deviceId: 'lux-1', name: 'Hall sensor', lux: 120, at: 1, available: true },
        ],
      },
      luminance: {
        retain: async (sensors: string[], owner: string) => {
          recorded.retained.push({ sensors: [...sensors], owner });
        },
        release: options.release ?? (async (owner: string) => {
          recorded.released.push(owner);
        }),
      },
    },
  } as unknown as PairSessionHost;

  const handlers = new Map<string, (...args: any[]) => unknown>();
  const session = { setHandler: (n: string, f: (...a: any[]) => unknown) => handlers.set(n, f) };

  return {
    host,
    session,
    recorded,
    handler: handlerRegistrar(host, session),
    /** Call a registered handler, as the view would. */
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(...args) as Promise<unknown>,
  };
}

describe('the handler wrapper', () => {
  test('logs success under the handler name', async () => {
    const { recorded, handler, call } = rig();

    handler('getEnds', async () => ({ ok: true }));

    assert.deepEqual(await call('getEnds'), { ok: true });
    assert.deepEqual(recorded.logs, ['pair/getEnds ok']);
    assert.deepEqual(recorded.errors, []);
  });

  test('a throwing handler is logged AND re-thrown', async () => {
    // Both halves matter. Swallowing would leave the view believing it saved,
    // and not logging is the failure mode the wrapper exists for: a pairing
    // screen that silently does nothing is undiagnosable from the outside.
    const { recorded, handler, call } = rig();

    handler('save', async () => {
      throw new Error('no lights chosen');
    });

    await assert.rejects(() => call('save'), /no lights chosen/);
    assert.equal(recorded.logs.length, 0);
    assert.match(recorded.errors[0]!, /pair\/save failed:.*no lights chosen/);
  });

  test('arguments reach the handler unchanged', async () => {
    const { handler, call } = rig();
    let seen: unknown[] = [];

    handler('setRules', async (...args: unknown[]) => {
      seen = args;
      return true;
    });
    await call('setRules', { rules: [] }, 'extra');

    assert.deepEqual(seen, [{ rules: [] }, 'extra']);
  });
});

describe('the session owner', () => {
  test('every session gets its own id', () => {
    // A fixed string would make two people pairing at once release each other's
    // sensors, because `retain` is ref-counted and TOTAL per owner.
    const ids = new Set([newSessionOwner(), newSessionOwner(), newSessionOwner()]);
    assert.equal(ids.size, 3);
    for (const id of ids) assert.match(id, /^pair-[0-9a-f-]{36}$/);
  });
});

describe('releasing the sensors when a screen closes', () => {
  test('disconnect releases exactly this session', async () => {
    const { host, session, recorded, call } = rig();

    releaseOnDisconnect(host, session, 'pair-abc');
    await call('disconnect');

    assert.deepEqual(recorded.released, ['pair-abc']);
  });

  test('a release that fails is logged, never thrown', async () => {
    // `disconnect` is the SDK closing the screen. Throwing here reaches nobody
    // and would abort the rest of the teardown.
    const { host, session, recorded, call } = rig({
      release: async () => { throw new Error('client gone'); },
    });

    releaseOnDisconnect(host, session, 'pair-abc');
    await call('disconnect');

    assert.match(recorded.errors[0]!, /Releasing the pairing session sensors failed:.*client gone/);
  });
});

describe('the timezone', () => {
  test('the Homey clock when it answers', () => {
    assert.equal(timezoneOf(rig({ timezone: () => 'Europe/Copenhagen' }).host), 'Europe/Copenhagen');
  });

  test('null when there is no clock at all', () => {
    assert.equal(timezoneOf(rig().host), null);
  });

  test('null when the clock throws', () => {
    // A schedule refuses to fire on a clock it does not trust, so "no answer"
    // has to stay distinguishable from an answer — never a guess.
    const { host } = rig({
      timezone: () => { throw new Error('no geolocation permission'); },
    });
    assert.equal(timezoneOf(host), null);
  });
});

describe('the light-picker handlers', () => {
  test('the subtitle is resolved through the host, per driver', async () => {
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerTargetHandlers(host, handler, state, 'targets.subtitleCurve');
    const payload = await call('listTargets') as { subtitle: string };

    // `lib/` cannot translate, so the key has to come back through the host.
    assert.equal(payload.subtitle, '[targets.subtitleCurve]');
  });

  test('a target naming something that is not a light is refused', async () => {
    // The pairing channel is a webview: shape AND membership are checked before
    // anything is persisted, exactly as a generated Flow's arguments are.
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerTargetHandlers(host, handler, state, 'targets.subtitleCurve');

    await assert.rejects(() => call('selectTargets', { kind: 'devices', deviceIds: ['nope'] }));
    assert.equal(state.target, undefined);
  });
});

describe('the shared daylight card handlers', () => {
  test('getDaylight reports standalone: false on a driver that owns the screen', async () => {
    // TRUE only on the Daylight light, whose screen IS the card and which
    // therefore keeps its own handler. Here the card is a section of somebody
    // else's screen, and that screen owns the Save and the Test.
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerDaylightCardHandlers(host, handler, state, 'pair-abc');
    const payload = await call('getDaylight') as {
      standalone: boolean; limits: { minLux: number; maxLux: number }; response: unknown;
    };

    assert.equal(payload.standalone, false);
    assert.deepEqual(payload.limits, { minLux: MIN_LUX, maxLux: MAX_LUX });
    assert.deepEqual(payload.response, DEFAULT_RESPONSE);
  });

  test('setDaylight retains the chosen sensors BEFORE reporting a reading', async () => {
    // Ordering is the point: a sensor nobody is subscribed to has no reading,
    // so evaluating first would show the sky for a device just given a sensor.
    const { host, recorded, handler, call } = rig();
    const state: SharedSessionState = {};

    registerDaylightCardHandlers(host, handler, state, 'pair-abc');
    await call('setDaylight', {
      response: { sensors: ['lux-1'], darkLux: 10, brightLux: 500, dark: 0.9, bright: 0.2 },
    });

    assert.deepEqual(recorded.retained, [{ sensors: ['lux-1'], owner: 'pair-abc' }]);
    assert.deepEqual(state.daylight?.sensors, ['lux-1']);
  });

  test('a response the screen could not have sent is corrected, and said so', async () => {
    const { host, recorded, handler, call } = rig();
    const state: SharedSessionState = {};

    registerDaylightCardHandlers(host, handler, state, 'pair-abc');
    const result = await call('setDaylight', {
      response: { sensors: ['lux-1'], darkLux: 'nonsense', brightLux: 500, dark: 0.9, bright: 0.2 },
    }) as { corrected: string[] };

    assert.ok(result.corrected.length > 0);
    assert.ok(recorded.logs.some(l => /Corrected daylight/.test(l)));
  });

  test('listSensors offers the lux sensors and no lamps', async () => {
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerDaylightCardHandlers(host, handler, state, 'pair-abc');
    const payload = JSON.stringify(await call('listSensors'));

    assert.match(payload, /lux-1/);
    assert.doesNotMatch(payload, /lamp-1/);
  });
});
