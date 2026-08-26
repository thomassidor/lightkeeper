import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CircadianRuntime } from '../../lib/circadian/circadian-runtime';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * What a circadian runtime is responsible for is everything a curve is not: when
 * a write is worth making at all, whose light it is safe to make it to, and when
 * to stop because somebody has taken over.
 *
 * The harness differs from the schedule one in the single way that matters here:
 * `makeCapabilityInstance` KEEPS its listener, so a test can fire a capability
 * change the way Homey does. Every interesting behaviour of this device type is
 * a reaction to one of those — the schedule harness could throw them away
 * because a schedule reacts to Flows instead.
 */

interface FakeDevice {
  id: string;
  name: string;
  zoneName: string;
  capabilities: string[];
  capabilitiesObj: Record<string, any>;
  available: boolean;
}

function light(
  id: string,
  capabilities: string[] = ['onoff', 'dim', 'light_temperature'],
  values: { onoff?: boolean; dim?: number; light_temperature?: number } = {},
): FakeDevice {
  const capabilitiesObj: Record<string, any> = {};
  if (capabilities.includes('onoff')) capabilitiesObj.onoff = { value: values.onoff ?? true };
  if (capabilities.includes('dim')) {
    capabilitiesObj.dim = { min: 0, max: 1, decimals: 2, value: values.dim ?? 0.5 };
  }
  if (capabilities.includes('light_temperature')) {
    capabilitiesObj.light_temperature = {
      min: 0, max: 1, decimals: 2, value: values.light_temperature ?? 0.5,
    };
  }
  return { id, name: id, zoneName: 'Kitchen', capabilities, capabilitiesObj, available: true };
}

/** 2026-08-18 20:15 UTC is 22:15 in Copenhagen — deep in the warm end. */
const EVENING = Date.UTC(2026, 7, 18, 20, 15);
/** 10:00 Copenhagen: the cool middle of the day. */
const MORNING = Date.UTC(2026, 7, 18, 8, 0);

function harness(options: {
  plan?: CircadianPlan;
  devices?: FakeDevice[];
  now?: number;
} = {}) {
  const devices = options.devices ?? [light('l1'), light('l2')];
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  const states: Array<{ state: string; detail?: unknown }> = [];
  const plans: CircadianPlan[] = [];
  const logs: string[] = [];
  /** deviceId:capability -> the listener Homey would call. */
  const listeners = new Map<string, (value: unknown) => void>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = options.now ?? EVENING;

  const deviceHandle = (id: string) => {
    const device = devices.find(d => d.id === id)!;
    return {
      ...device,
      async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
        writes.push({ deviceId: id, capability: capabilityId, value });
        // The Homey reports back what it was told, which is what makes the echo
        // dedupe and the override tolerance worth testing at all.
        if (device.capabilitiesObj[capabilityId]) device.capabilitiesObj[capabilityId].value = value;
      },
      makeCapabilityInstance(capability: string, listener: (value: unknown) => void) {
        listeners.set(`${id}:${capability}`, listener);
        return { destroy: () => listeners.delete(`${id}:${capability}`) };
      },
    };
  };

  const api = {
    credentials: { getStatus: () => ({ present: false, valid: false }) },
    async read() {
      return { devices: { getDevice: async ({ id }: { id: string }) => deviceHandle(id) } };
    },
    track: (unsubscribe: unknown) => unsubscribe,
  } as unknown as HomeyApiService;

  /**
   * Mutable, because that is how a target actually stops being one: the user
   * moves a light out of the zone, or deletes it. The plan's spec does not
   * change — `refreshTargets()` re-resolves it against a catalogue that has.
   */
  let inCatalogue = [...devices];
  const catalog = {
    async device(id: string) { return inCatalogue.find(d => d.id === id); },
    async devicesInZone() { return inCatalogue; },
  } as unknown as DeviceCatalog;

  const runtime = new CircadianRuntime('circ-1', options.plan ?? plan(), {
    api,
    catalog,
    timezone: () => 'Europe/Copenhagen',
    displayName: () => 'Kitchen circadian',
    now: () => now,
    // Collected rather than run: the pre-stage check must be assertable without
    // costing the suite a real 1.5 seconds.
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimeout: () => { /* nothing to cancel in a list */ },
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    onStateChange: (state, detail) => states.push({ state, detail }),
    onPlanChange: async p => { plans.push(p); },
  });

  return {
    runtime, writes, states, plans, logs, devices,
    /** Fire a capability change the way Homey's subscription does. */
    report(deviceId: string, capability: string, value: unknown) {
      const device = devices.find(d => d.id === deviceId)!;
      if (device.capabilitiesObj[capability]) device.capabilitiesObj[capability].value = value;
      listeners.get(`${deviceId}:${capability}`)?.(value);
    },
    /** Run every pending post-write check. */
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer.fn();
    },
    advance(ms: number) { now += ms; },
    at(ms: number) { now = ms; },
    /**
     * Writes now go out behind the scheduler's completion promise (Phase 2),
     * so bookkeeping and the pre-stage probe land a few microtasks after
     * applyNow() resolves rather than inside it.
     */
    async settle() {
      for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
    },
    /** The user moves a light out of the zone, or deletes it. */
    removeFromCatalogue(deviceId: string) {
      inCatalogue = inCatalogue.filter(device => device.id !== deviceId);
    },
  };
}

function plan(over: Partial<CircadianPlan> = {}): CircadianPlan {
  return {
    schemaVersion: 1,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    // Deliberately steep, so a few hours of simulated time is a visible change.
    points: [
      { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2 },
      { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1 },
    ],
    adjustBrightness: false,
    preStage: false,
    ...over,
  };
}

/**
 * The write queue flushes on the leading edge and does not await the flush it
 * started, so a test that asserts immediately sees only the first write. Yield a
 * few turns rather than sleeping.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/**
 * Settle, then flush the queue.
 *
 * The write queue's 200 ms floor between two writes to the same light is real
 * time, not the harness's clock — right for a dial being turned, and the reason
 * a test that writes twice in a millisecond sees only the first one until the
 * queue is drained.
 */
async function applied(h: { runtime: { drain(): Promise<void> } }): Promise<void> {
  await settle();
  await h.runtime.drain();
  await settle();
}

interface Written { deviceId: string; capability: string; value: unknown }

const temperatures = (writes: Written[]) =>
  writes.filter(w => w.capability === 'light_temperature');

describe('circadian writes', () => {
  test('starting corrects the lights that are on, without waiting for a tick', async () => {
    const h = harness();
    await h.runtime.start();
    await settle();

    // Both lights, colour only — a circadian light never switches anything on.
    assert.equal(temperatures(h.writes).length, 2);
    assert.equal(h.writes.filter(w => w.capability === 'onoff').length, 0);
  });

  test('the value written is the curve at the local time, on the warm-is-higher axis', async () => {
    const h = harness({ now: EVENING });
    await h.runtime.start();
    await settle();

    // 22:15 sits between the 12:00 (0.2) and 23:00 (1.0) points, close to the
    // warm end. Cooler than this at bedtime is the bug CLAUDE.md §6 records.
    const value = temperatures(h.writes)[0].value as number;
    assert.ok(value > 0.9, `wrote ${value} at 22:15`);
  });

  test('a tick that has not moved the curve writes nothing', async () => {
    const h = harness();
    await h.runtime.start();
    await settle();
    const after = h.writes.length;

    // A minute later. The steep test curve moves about 0.001 a minute, and
    // light_temperature reports two decimals, so this is a no-op at the lamp.
    h.advance(60_000);
    await h.runtime.tick();
    await settle();

    assert.equal(h.writes.length, after, 'a once-a-minute tick must not be a once-a-minute write');
  });

  test('a tick that has moved the curve writes again', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();
    const after = h.writes.length;

    h.advance(3 * 60 * 60_000);
    await h.runtime.tick();
    await applied(h);

    assert.ok(h.writes.length > after, 'three hours of curve is worth a write');
  });

  test('lights that are off are left alone unless pre-staging is on', async () => {
    const h = harness({ devices: [light('l1', undefined, { onoff: false }), light('l2')] });
    await h.runtime.start();
    await settle();

    assert.deepEqual(temperatures(h.writes).map(w => w.deviceId), ['l2']);
  });

  test('with pre-staging on, a light that is off is set in advance', async () => {
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();

    assert.deepEqual(temperatures(h.writes).map(w => w.deviceId).sort(), ['l1', 'l2']);
    // And still nothing that could switch it on.
    assert.equal(h.writes.filter(w => w.capability === 'onoff').length, 0);
  });

  test('a light that cannot change colour is skipped, not failed', async () => {
    const h = harness({ devices: [light('l1', ['onoff', 'dim']), light('l2')] });
    await h.runtime.start();
    await settle();

    assert.deepEqual(temperatures(h.writes).map(w => w.deviceId), ['l2']);
    assert.equal(h.runtime.currentState, 'ready');
  });

  test('a paused device writes nothing at all', async () => {
    const h = harness({ plan: plan({ enabled: false }) });
    await h.runtime.start();
    await h.runtime.tick();
    await settle();

    assert.deepEqual(h.writes, []);
    assert.equal(h.runtime.currentState, 'disabled');
  });
});

describe('brightness', () => {
  test('is left alone unless the curve was asked to follow it', async () => {
    const h = harness();
    await h.runtime.start();
    await settle();
    assert.equal(h.writes.filter(w => w.capability === 'dim').length, 0);
  });

  test('is written on the perceptual axis when it is switched on', async () => {
    const h = harness({
      plan: plan({
        adjustBrightness: true,
        points: [
          { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2, brightness: 1 },
          { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 1 },
        ],
      }),
    });
    await h.runtime.start();
    await settle();

    // A perceptual 1 is a device 1; the conversion is toDevice(), the same one
    // the dimming gestures and the schedule screen use.
    assert.deepEqual(
      h.writes.filter(w => w.capability === 'dim').map(w => w.value),
      [1, 1],
    );
  });

  test('is never sent to a light that is off, even while pre-staging', async () => {
    // A dim write turns an off lamp on — measured on Hue, and the reason
    // `impliesOn` exists. Pre-staging is a colour-only idea.
    const h = harness({
      plan: plan({
        preStage: true,
        adjustBrightness: true,
        points: [
          { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2, brightness: 0.4 },
          { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 0.4 },
        ],
      }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();

    assert.deepEqual(h.writes.filter(w => w.capability === 'dim').map(w => w.deviceId), ['l2']);
  });
});

describe('switching on', () => {
  test('a light coming on is corrected immediately', async () => {
    const h = harness({ devices: [light('l1', undefined, { onoff: false }), light('l2')] });
    await h.runtime.start();
    await settle();
    const before = h.writes.length;

    h.report('l1', 'onoff', true);
    await settle();

    const added = h.writes.slice(before);
    assert.deepEqual(added.map(w => [w.deviceId, w.capability]), [['l1', 'light_temperature']]);
  });

  test('and is corrected even where the curve has not moved since our last write', async () => {
    // The lamp restores whatever colour it was last at, so what we wrote an hour
    // ago says nothing about what it is showing now.
    const h = harness();
    await h.runtime.start();
    await settle();
    const before = h.writes.length;

    h.report('l1', 'onoff', false);
    h.report('l1', 'onoff', true);
    await applied(h);

    assert.equal(h.writes.length, before + 1);
  });

  test('a duplicated echo of the same power event produces one write, not two', async () => {
    // Echoes arrive duplicated on real hardware (CLAUDE.md §6).
    const h = harness({ devices: [light('l1', undefined, { onoff: false }), light('l2')] });
    await h.runtime.start();
    await settle();
    const before = h.writes.length;

    h.report('l1', 'onoff', true);
    h.report('l1', 'onoff', true);
    await settle();

    assert.equal(h.writes.length, before + 1);
  });
});

describe('somebody changing a light by hand', () => {
  test('stops circadian writing to that light, and only that light', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    // Well outside the tolerance, and well after our own write settled.
    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);

    h.advance(3 * 60 * 60_000);
    const before = h.writes.length;
    await h.runtime.tick();
    await applied(h);

    assert.deepEqual(
      h.writes.slice(before).map(w => w.deviceId), ['l2'],
      'the light somebody set by hand must be left where they put it',
    );
  });

  test('rounding by a bridge is not mistaken for a person', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;

    // A hundredth off, and after the settle window: still ours.
    h.advance(10_000);
    h.report('l1', 'light_temperature', written + 0.01);

    h.advance(3 * 60 * 60_000);
    const before = h.writes.length;
    await h.runtime.tick();
    await applied(h);

    assert.equal(h.writes.slice(before).filter(w => w.deviceId === 'l1').length, 1);
  });

  test('a change while our own write is still settling is not an override', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    // A bridge reporting an intermediate value part-way through a transition.
    h.report('l1', 'light_temperature', 0.42);

    h.advance(3 * 60 * 60_000);
    const before = h.writes.length;
    await h.runtime.tick();
    await applied(h);

    assert.equal(h.writes.slice(before).filter(w => w.deviceId === 'l1').length, 1);
  });

  test('is forgotten when the light is switched off and on again', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);
    h.report('l1', 'onoff', false);
    h.report('l1', 'onoff', true);
    await applied(h);

    const before = h.writes.length;
    h.advance(3 * 60 * 60_000);
    await h.runtime.tick();
    await applied(h);

    assert.equal(h.writes.slice(before).filter(w => w.deviceId === 'l1').length, 1);
  });
});

describe('pre-staging that turns out to be unsafe', () => {
  test('disables itself, persists that, and does not switch the light back off', async () => {
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();

    // The lamp came on from a colour write, which is what some integrations do.
    h.report('l1', 'onoff', true);
    await settle();
    h.runTimers();

    assert.equal(h.runtime.currentPlan.preStage, false, 'pre-staging must turn itself off');
    assert.equal(h.plans.at(-1)?.preStage, false, 'and the verdict must be persisted');
    assert.equal(
      h.writes.filter(w => w.capability === 'onoff').length, 0,
      'switching off a room somebody may have just lit is the worse failure',
    );
    assert.ok(h.runtime.diagnostics().preStageDisabled, 'and it is reported, not hidden');
  });

  test('the pairing screen probe reports a lamp that stayed off', async () => {
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.startIdle();

    const probe = h.runtime.probePreStage(0);
    // The probe's own wait goes through the injected timer, like every other
    // delay in this runtime.
    await settle();
    h.runTimers();
    const outcome = await probe;

    assert.equal(outcome.deviceId, 'l1');
    assert.equal(outcome.stayedOff, true);
    assert.equal(outcome.restored, false);
  });

  test('the probe puts a lamp back that came on, because the user asked for the test', async () => {
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.startIdle();

    const probe = h.runtime.probePreStage(0);
    await settle();
    // The lamp came on from the colour write, the way some integrations do.
    h.report('l1', 'onoff', true);
    h.runTimers();
    const outcome = await probe;

    assert.equal(outcome.stayedOff, false);
    assert.equal(outcome.restored, true);
    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff'),
      [{ deviceId: 'l1', capability: 'onoff', value: false }],
    );
  });

  test('the probe says so when every light is already on', async () => {
    const h = harness({ plan: plan({ preStage: true }) });
    await h.runtime.startIdle();

    const outcome = await h.runtime.probePreStage(0);
    assert.equal(outcome.deviceId, null);
    assert.match(outcome.reason ?? '', /already on/);
  });

  test('stays on when the light stays off', async () => {
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();
    h.runTimers();

    assert.equal(h.runtime.currentPlan.preStage, true);
    assert.deepEqual(h.plans, []);
  });
});

describe('health', () => {
  test('lights that cannot change colour at all is needs_repair, not ready', async () => {
    const h = harness({ devices: [light('l1', ['onoff']), light('l2', ['onoff', 'dim'])] });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.equal((h.states.at(-1)?.detail as any)?.key, 'state.noWarmthTargets');
  });

  test('there is never a credential verdict, because no key is involved', async () => {
    const h = harness();
    await h.runtime.start();
    assert.ok(!h.states.some(s => s.state === 'needs_credential'));
    // Not merely undefined: CircadianDiagnostics has no such field at all, so a
    // future change that adds one fails to compile here rather than passing.
    assert.equal('credential' in h.runtime.diagnostics(), false);
  });
});

describe('diagnostics', () => {
  test('report where the curve is, what is next, and who has been overridden', async () => {
    const h = harness({ now: EVENING });
    await h.runtime.start();
    await settle();

    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);

    const diagnostics = h.runtime.diagnostics() as any;
    assert.equal(diagnostics.kind, 'circadian');
    assert.equal(diagnostics.localTime, 'Tue 22:15');
    assert.ok(diagnostics.now.warmth > 0.9);
    assert.equal(diagnostics.nextPoint.at, '23:00');
    assert.deepEqual(diagnostics.targets.map((t: any) => t.overridden), [true, false]);
  });
});

/**
 * The acceptance bar for target release.
 *
 * A circadian light watches its targets' `onoff` and writes on the rising edge
 * — that IS the feature (CLAUDE.md §12), and it is why leaving a subscription
 * behind is worse here than anywhere else in the app. A light dropped from the
 * plan kept its subscription, so the next time somebody switched it on, this
 * runtime dutifully wrote a colour to a lamp that was no longer any of its
 * business.
 */
describe('a light removed from the plan is released', () => {

  test('switching an ex-target on produces ZERO writes', async () => {
    const h = harness({ plan: plan({ target: { kind: 'zone', zoneId: 'z1', includeSubzones: false } }) });
    await h.runtime.start();
    await h.settle();

    // Prove the subscription is live BEFORE removing it, or this would pass
    // against a runtime that never subscribed at all.
    h.report('l2', 'onoff', false);
    h.report('l2', 'onoff', true);
    await h.settle();
    assert.ok(
      h.writes.some(w => w.deviceId === 'l2'),
      'the rising edge reaches a light that IS a target',
    );

    h.removeFromCatalogue('l2');
    await h.runtime.refreshTargets();
    await h.settle();

    const afterRefresh = h.writes.filter(w => w.deviceId === 'l2').length;
    h.report('l2', 'onoff', false);
    h.report('l2', 'onoff', true);
    await h.settle();

    assert.equal(
      h.writes.filter(w => w.deviceId === 'l2').length, afterRefresh,
      'not one write to a light that has left the plan',
    );
  });

  test('the remaining targets still work', async () => {
    const h = harness({ plan: plan({ target: { kind: 'zone', zoneId: 'z1', includeSubzones: false } }) });
    await h.runtime.start();
    await h.settle();

    h.removeFromCatalogue('l2');
    await h.runtime.refreshTargets();
    await h.settle();

    const before = h.writes.filter(w => w.deviceId === 'l1').length;
    h.report('l1', 'onoff', false);
    h.report('l1', 'onoff', true);
    // drain(), not just settle: l1 was written to during the refresh, so the
    // rising edge's write is inside the rate window and waiting on a timer.
    await applied(h);

    assert.ok(
      h.writes.filter(w => w.deviceId === 'l1').length > before,
      'removing one light must not stand the whole device down',
    );
  });

  test('an unchanged target set is a no-op', async () => {
    const h = harness({ plan: plan({ target: { kind: 'zone', zoneId: 'z1', includeSubzones: false } }) });
    await h.runtime.start();
    await h.settle();

    const before = h.writes.length;
    await h.runtime.refreshTargets();
    await h.settle();

    assert.equal(h.writes.length, before, 'no churn when nothing has changed');
  });
});
