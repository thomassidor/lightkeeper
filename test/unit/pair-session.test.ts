import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LocalisedError } from '../../lib/support/localised-error';

import {
  curvePreStageProbe,
  handlerRegistrar,
  newSessionOwner,
  registerCredentialHandlers,
  registerCurvePreviewHandlers,
  registerSaveHandler,
  registerTargetHandlers,
  releaseOnDisconnect,
  timezoneOf,
  type PairSessionHost,
  type SharedSessionState,
} from '../../lib/pairing/pair-session';
import {
  controlModeOf, registerControlHandlers, reviewControl, type ControlState,
} from '../../lib/pairing/control-choice';

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
  credentials: string[];
  probed: string[];
  ephemeral: unknown[];
  applied: Array<{ reason: string; force: boolean }>;
  drained: number;
  stopped: number;
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
  const recorded: Recorded = {
    logs: [], errors: [], retained: [], released: [],
    credentials: [], probed: [], ephemeral: [], applied: [], drained: 0, stopped: 0,
  };
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
      credentials: {
        getStatus: () => ({ present: true, valid: true, lastCheckedAt: 1 }),
        setCredential: async (token: string, validate: (client: unknown) => Promise<void>) => {
          // Driven with a client the REAL `flowWriteProbe` can use, so the test
          // proves the probe runs rather than that a function was passed.
          await validate({
            flow: {
              getFlowFolders: async () => ({}),
              createFlowFolder: async () => {
                recorded.probed.push('createFlowFolder');
                return { id: 'probe-folder' };
              },
              deleteFlowFolder: async () => { recorded.probed.push('deleteFlowFolder'); },
            },
          });
          recorded.credentials.push(token);
          return { present: true, valid: true, lastCheckedAt: 2 };
        },
      },
      curves: {
        ephemeral: async (plan: unknown) => {
          recorded.ephemeral.push(plan);
          return {
            applyNow: async (reason: string, opts: { force?: boolean }) => {
              recorded.applied.push({ reason, force: opts.force === true });
              return { writes: 3 };
            },
            drain: async () => { recorded.drained += 1; },
            probePreStageAll: async () => ({
              lights: [
                { deviceId: 'lamp-1', name: 'Hall lamp', ok: true, restored: true },
                { deviceId: 'lamp-2', name: 'Porch lamp', ok: false, restored: true, reason: 'it came on' },
              ],
            }),
            stop: async () => { recorded.stopped += 1; },
          };
        },
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

  test('a refusal raised in lib/ reaches the screen translated, not as a key', async () => {
    // lib/ cannot translate (CLAUDE.md), so it throws a LocalisedError and the
    // wrapper — the one place every handler's error passes — resolves it.
    const { handler, call } = rig();
    handler('save', async () => { throw new LocalisedError('errors.targetSelectionChanged'); });

    await assert.rejects(() => call('save'), (error: Error) => {
      assert.equal(error.message, '[errors.targetSelectionChanged]');
      assert.ok(!(error instanceof LocalisedError), 'the key must not travel on past the wrapper');
      return true;
    });
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

  test('nothing ticked is a state of the screen, not a refusal', async () => {
    /**
     * The picker pushes its whole selection on every tap, and the first push is
     * the empty one it opens with — so an empty list refused as invalid printed
     * `target.deviceIds is empty` across step 1 before the user had touched
     * anything.
     */
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerTargetHandlers(host, handler, state, 'targets.subtitleCurve');

    assert.equal(await call('selectTargets', { kind: 'devices', deviceIds: [] }), null);
    assert.equal(state.target, undefined);
  });

  test('unticking the last light forgets what a repair session arrived with', async () => {
    // Why the empty push is answered rather than skipped in the view: the target
    // lives in the session, so only a round trip can clear it.
    const { host, handler, call } = rig();
    const state: SharedSessionState = { target: { kind: 'devices', deviceIds: ['light-1'] } };

    registerTargetHandlers(host, handler, state, 'targets.subtitleCurve');
    await call('selectTargets', { kind: 'devices', deviceIds: [] });

    assert.equal(state.target, undefined);
  });
});

/**
 * `registerDaylightCardHandlers` is gone, and with it this block.
 *
 * The shared daylight card was the "follow the daylight" section spliced into a
 * schedule, a circadian light and a Colour Curve Light. The pairing rewrite removed
 * `fromDaylight` from all three stores — brightness from the room is what a
 * Room-sensing Light is for — so the card, its three handlers and the four-way
 * splice went with it. The Room-sensing Light's own screen keeps its handlers, and
 * they live in its own driver.
 */

describe('the credential handlers', () => {
  test('nextView is the driver\'s, because the view cannot know', async () => {
    // The credential VIEW is a byte-for-byte copy shared between the controller
    // and the schedule (platform §8), so what follows it is the driver's answer:
    // a controller goes on to pick a remote, a schedule straight to its lights.
    const { host, handler, call } = rig();

    registerCredentialHandlers(host, handler, 'source');
    const status = await call('getCredentialStatus') as { nextView: string; valid: boolean };

    assert.equal(status.nextView, 'source');
    assert.equal(status.valid, true);
  });

  test('setCredential proves a WRITE, not just a read', async () => {
    // Reads succeed on credentials that cannot write (platform §1), so the
    // probe is the whole point of this handler. If it were not called, an
    // unusable key would be accepted and every generated Flow would fail later.
    const { host, recorded, handler, call } = rig();

    registerCredentialHandlers(host, handler, 'targets');
    await call('setCredential', 'user:session:secret');

    assert.deepEqual(recorded.credentials, ['user:session:secret']);
    // It created a folder and deleted it again: the delete is in a `finally`,
    // so a probe that proved the write never leaves one behind.
    assert.deepEqual(recorded.probed, ['createFlowFolder', 'deleteFlowFolder']);
  });
});

describe('the save handler', () => {
  test('pairing returns a device for Homey to create', async () => {
    const { host, handler, call } = rig();
    const state: SharedSessionState = {};

    registerSaveHandler(host, handler, state, {
      idPrefix: 'dayl',
      storeKey: 'daylight',
      naming: { fallback: 'Room-sensing Light', suffix: 'daylight' },
      buildPlan: () => ({ schemaVersion: 1 }),
    });
    const result = await call('save', '') as {
      created: boolean;
      device: { name: string; data: { id: string }; store: Record<string, unknown> };
    };

    assert.equal(result.created, true);
    // The plan lands under the driver's OWN store key — that key is also what
    // its migration chain reads, so a wrong one is an unreadable device.
    assert.deepEqual(result.device.store, { daylight: { schemaVersion: 1 } });
    // `mintDeviceId` prefixes `lk-` so a human reading a Flow's arguments can
    // see whose device it is; the kind follows.
    assert.match(result.device.data.id, /^lk-dayl-/);
  });

  test('with no target chosen the name falls back, and does not throw', async () => {
    // `buildPlan` is what refuses an empty target; naming must not race it to
    // an exception, or the failure the user sees names the wrong thing.
    const { host, handler, call } = rig();

    registerSaveHandler(host, handler, {}, {
      idPrefix: 'circ',
      storeKey: 'circadian',
      naming: { fallback: 'Circadian light', suffix: 'circadian' },
      buildPlan: () => ({}),
    });
    const result = await call('save', '') as { device: { name: string } };

    assert.equal(result.device.name, 'Circadian light');
  });

  test('a name typed by the user wins over the derived one', async () => {
    const { host, handler, call } = rig();

    registerSaveHandler(host, handler, {}, {
      idPrefix: 'curv',
      storeKey: 'curve',
      naming: { fallback: 'Colour Curve Light', suffix: 'curve' },
      buildPlan: () => ({}),
    });
    const result = await call('save', 'Kitchen curve') as { device: { name: string } };

    assert.equal(result.device.name, 'Kitchen curve');
  });

  test('REPAIR applies to the device already there and creates nothing', async () => {
    // Returning a device here would leave the household with two.
    const { host, handler, call } = rig();
    const applied: unknown[] = [];

    registerSaveHandler(host, handler, {}, {
      device: { applyPlan: async (plan: unknown) => { applied.push(plan); } },
      idPrefix: 'sched',
      storeKey: 'schedule',
      naming: { fallback: 'Light schedule', suffix: 'schedule' },
      buildPlan: () => ({ entries: [] }),
    });
    const result = await call('save', '') as { updated: boolean; created?: boolean };

    assert.equal(result.updated, true);
    assert.equal(result.created, undefined);
    assert.deepEqual(applied, [{ entries: [] }]);
  });
});

describe('the curve preview handlers', () => {
  test('previewNow FORCES the write and drains before reporting', async () => {
    // Forced because the user pressed a button and is owed a visible change even
    // where the lights already match the curve; drained so the count reported is
    // writes attempted rather than writes still queued behind the burst limit.
    const { host, recorded, handler, call } = rig();

    registerCurvePreviewHandlers(host, handler, () => ({ points: [] }) as never);
    const outcome = await call('previewNow');

    assert.deepEqual(outcome, { writes: 3 });
    assert.deepEqual(recorded.applied, [{ reason: 'preview', force: true }]);
    assert.equal(recorded.drained, 1);
    assert.equal(recorded.stopped, 1);
  });

  test('the ephemeral runtime is stopped even when the preview throws', async () => {
    // Leaking it would leave subscriptions on the household's lamps with nothing
    // holding a handle to tear them down.
    const { host, recorded, handler, call } = rig();

    registerCurvePreviewHandlers(host, handler, () => {
      throw new Error('a curve needs at least 2 points');
    });

    await assert.rejects(() => call('previewNow'), /at least 2 points/);
    // Nothing was built, so nothing to stop — the guard is that buildPlan runs
    // BEFORE the runtime exists.
    assert.equal(recorded.ephemeral.length, 0);
    assert.equal(recorded.stopped, 0);
  });

  test('the pre-stage probe asks an ephemeral runtime, and stops it', async () => {
    // It moved to the review screen, but the runtime it asks is still built
    // from the plan on screen and still torn down, or the test leaves
    // subscriptions on the household's lamps.
    const { host, recorded } = rig();

    const outcome = await curvePreStageProbe(host, () => ({ points: [] }) as never)();

    assert.equal(outcome.lights.length, 2);
    assert.equal(recorded.ephemeral.length, 1);
    assert.equal(recorded.stopped, 1);
  });
});

describe('"How Lightkeeper controls your lights"', () => {
  const state = (over: Partial<ControlState> = {}): ControlState => ({
    preStage: false, writesLights: true, target: { kind: 'devices', deviceIds: ['lamp-1', 'lamp-2'] },
    ...over,
  });

  test('the three modes are the two stored flags, and nothing new', () => {
    assert.equal(controlModeOf({ preStage: false, writesLights: true }), 'after');
    assert.equal(controlModeOf({ preStage: true, writesLights: true }), 'before');
    // Publish-only wins: a device that writes to no lamp pre-stages none either.
    assert.equal(controlModeOf({ preStage: true, writesLights: false }), 'none');
  });

  test('setControl moves both flags, and keeps a test already run', async () => {
    const { handler, call } = rig();
    const session = state({ preStage: true, preStageLights: ['lamp-1'] });
    registerControlHandlers(handler, session, { offerBefore: true });

    await call('setControl', { mode: 'none' });
    assert.equal(session.writesLights, false);
    assert.equal(session.preStage, false);
    // Coming back to "before" must not mean running the test again.
    assert.deepEqual(session.preStageLights, ['lamp-1']);

    await call('setControl', { mode: 'before' });
    assert.equal(session.writesLights, true);
    assert.equal(session.preStage, true);
  });

  test('setControl refuses a mode it does not know, and one this device cannot do', async () => {
    // A pair session is a scriptable surface (platform §14), so the screen is
    // not what enforces a Room-sensing Light's two options.
    const { handler, call } = rig();
    const session = state();
    registerControlHandlers(handler, session, { offerBefore: false });

    await assert.rejects(() => call('setControl', { mode: 'sometimes' }), /errors\.notAControlMode/);
    await assert.rejects(() => call('setControl', { mode: 'before' }), /errors\.cannotSetBefore/);
    assert.equal(session.preStage, false);
  });

  test('the test stores the lamps that passed, and never the ones that did not', async () => {
    const { host, handler, call } = rig();
    const session = state({ preStage: true });
    registerControlHandlers(handler, session, {
      offerBefore: true,
      probe: curvePreStageProbe(host, () => ({ points: [] }) as never),
    });

    const result = await call('testPreStage') as { lights: unknown[]; restored: number };

    assert.deepEqual(session.preStageLights, ['lamp-1']);
    assert.deepEqual(result.lights, [{ name: 'Hall lamp', ok: true }, { name: 'Porch lamp', ok: false }]);
    assert.equal(result.restored, 2);
  });

  test('a Room-sensing Light registers no test at all', () => {
    const { handler } = rig();
    const names: string[] = [];
    registerControlHandlers((name, fn) => { names.push(name); handler(name, fn); }, state(), { offerBefore: false });
    assert.deepEqual(names, ['setControl']);
  });

  test('a repair reads the stored list back against the lamps it drives today', async () => {
    const { host } = rig({
      devices: [
        { id: 'lamp-1', name: 'Hall lamp', capabilities: ['onoff'] },
        { id: 'lamp-2', name: 'Porch lamp', capabilities: ['onoff'] },
      ] as never,
    });
    // Nothing tested in THIS session: the list came from the store.
    const control = await reviewControl(host, state({ preStage: true, preStageLights: ['lamp-1'] }), true);

    assert.equal(control.selected, 'before');
    assert.equal(control.lightCount, 2);
    assert.deepEqual(control.tested, {
      fresh: false,
      lights: [{ name: 'Hall lamp', ok: true }, { name: 'Porch lamp', ok: false }],
    });
  });

  test('a fresh test that no longer covers the lamps is read back instead', async () => {
    // Test, go back, add a lamp, come here again: "Tested just now" would then
    // be silent about the lamp that was never tested.
    const { host } = rig({
      devices: [
        { id: 'lamp-1', name: 'Hall lamp', capabilities: ['onoff'] },
        { id: 'lamp-2', name: 'Porch lamp', capabilities: ['onoff'] },
      ] as never,
    });
    const control = await reviewControl(host, state({
      preStage: true,
      preStageLights: ['lamp-1'],
      tested: [{ deviceId: 'lamp-1', name: 'Hall lamp', ok: true }],
    }), true);

    assert.equal(control.tested?.fresh, false);
    assert.equal(control.tested?.lights.length, 2);
  });

  test('a Room-sensing Light offers two modes and no test result', async () => {
    const { host } = rig();
    const control = await reviewControl(host, { writesLights: false }, false);
    assert.deepEqual(control.modes, ['after', 'none']);
    assert.equal(control.selected, 'none');
    assert.equal(control.tested, undefined);
  });
});
