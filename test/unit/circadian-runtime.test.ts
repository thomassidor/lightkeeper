import { test, describe } from 'node:test';
import { ownsNothing, zoneLights } from '../support/fake-catalog';
import assert from 'node:assert/strict';

import { CircadianRuntime } from '../../lib/circadian/circadian-runtime';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { settle as sharedSettle } from '../support/deferred';

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
  values: {
    onoff?: boolean; dim?: number; light_temperature?: number;
    light_hue?: number; light_saturation?: number;
  } = {},
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
  // No `decimals`: homey-lib gives the colour pair none, which is why the
  // runtime's colour deadband is a fixed step rather than a declared resolution.
  if (capabilities.includes('light_hue')) {
    capabilitiesObj.light_hue = { min: 0, max: 1, value: values.light_hue ?? 0.5 };
  }
  if (capabilities.includes('light_saturation')) {
    capabilitiesObj.light_saturation = { min: 0, max: 1, value: values.light_saturation ?? 0.5 };
  }
  return { id, name: id, zoneName: 'Kitchen', capabilities, capabilitiesObj, available: true };
}

/** A lamp that can do both axes, so it can be driven into the wrong mode. */
const colourLamp = (id: string) => light(id, [
  'onoff', 'dim', 'light_temperature', 'light_hue', 'light_saturation', 'light_mode',
]);

/** 2026-08-18 20:15 UTC is 22:15 in Copenhagen — deep in the warm end. */
const EVENING = Date.UTC(2026, 7, 18, 20, 15);
/** 10:00 Copenhagen: the cool middle of the day. */
const MORNING = Date.UTC(2026, 7, 18, 8, 0);

function harness(options: {
  plan?: CircadianPlan;
  devices?: FakeDevice[];
  now?: number;
  /**
   * An integration that declines a write, the way a Hue Bridge does.
   *
   * `when` is what lets a lamp refuse a colour while it is OFF and take one
   * once it is on — which is the actual measured behaviour (platform §6's third
   * outcome) and cannot be expressed by refusing unconditionally.
   */
  refuseWrite?: {
    capability: string;
    message: string;
    when?: (device: FakeDevice) => boolean;
  };
  /** A stand-in evaluator, for the points that follow the daylight. */
  daylight?: { evaluate: () => { brightness: number; source: string } };
} = {}) {
  const devices = options.devices ?? [light('l1'), light('l2')];
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  /** Every write ATTEMPTED, refused or not. See setCapabilityValue below. */
  const attempts: Array<{ deviceId: string; capability: string; value: unknown }> = [];
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
        // BEFORE the refusal, and `writes` is after it. A refused write is
        // invisible in `writes` by construction, which is exactly what a test
        // counting how often we retry a refusing lamp has to see.
        attempts.push({ deviceId: id, capability: capabilityId, value });
        if (options.refuseWrite?.capability === capabilityId
          && (options.refuseWrite.when?.(device) ?? true)) {
          throw new Error(options.refuseWrite.message);
        }
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
    lightsInZone: zoneLights(async () => inCatalogue),
    isOwnDevice: ownsNothing,
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
    // Absent unless a test asks, which is the shape a curve with no daylight
    // response runs in — and the shape every other test in this file runs in.
    ...(options.daylight ? { daylight: options.daylight as any } : {}),
    onPlanChange: async p => { plans.push(p); },
  });

  return {
    runtime, writes, attempts, states, plans, logs, devices,
    /**
     * Whether Homey still holds a capability listener for this device.
     *
     * The observable that separates "released" from "merely ignored". A light
     * dropped from the plan stopped producing WRITES on its own — the cache and
     * the planner see to that — so a test asserting only writes passed against a
     * runtime that had left the subscription behind. The subscription is the
     * thing platform §12's release contract is about: it is a live listener on
     * somebody's lamp, held by a device that is no longer watching it.
     */
    isSubscribed(deviceId: string, capability: string) {
      return listeners.has(`${deviceId}:${capability}`);
    },
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
 * few turns rather than sleeping — twelve is well past any burst these tests
 * produce.
 *
 * `settle` itself is `test/support/deferred.ts`'s; three files each carried a
 * private copy of exactly this loop with an incompatible signature, while five
 * other files imported the shared one.
 */
const settle = () => sharedSettle(12);

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
    // warm end. Cooler than this at bedtime is the bug platform §6 records.
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
    // Echoes arrive duplicated on real hardware (platform §6).
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

  test('the probe reports a REFUSED write rather than throwing it at the user', async () => {
    /**
     * The third outcome, found on hardware. A Hue Bridge declines a colour
     * write to a lamp it considers "soft off" instead of accepting it or
     * turning the lamp on — and the probe's write was unguarded, so the
     * integration's own sentence arrived on the pairing screen underneath a
     * button labelled "Test it".
     *
     * For the user it means what "the lamp came on" means: pre-staging is not
     * available here. So it is reported that way, and the reason is kept.
     */
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
      },
    });
    await h.runtime.startIdle();

    const outcome = await h.runtime.probePreStage(0);

    assert.equal(outcome.deviceId, 'l1', 'it still names the lamp it tried');
    assert.equal(outcome.stayedOff, false, 'pre-staging is not available here');
    assert.equal(outcome.restored, true, 'nothing was changed, so nothing needed putting back');
    assert.match(outcome.reason ?? '', /soft off/,
      "the integration's own words are the most useful thing it can say");

    // And it did NOT switch the lamp off to "restore" a lamp it never touched.
    assert.deepEqual(h.writes.filter(w => w.capability === 'onoff'), []);
  });

  /**
   * The runtime knew about the third outcome in one place only — the pairing
   * screen's probe, above — and the runtime itself did not.
   *
   * Measured 4 September 2026: 4 of 13 Hue bulbs behind one bridge refuse a
   * colour while off, every time, and 9 on the same bridge take it and stay
   * off. A failed write leaves `lastWritten` alone on purpose (it is the retry
   * mechanism), so the refusal was re-sent every tick for as long as the lamp
   * was switched off — some six hundred a night, per lamp.
   */
  test('a lamp that refuses a colour while off is not asked for ever', async () => {
    const h = harness({
      plan: plan({ preStage: true, target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: false })],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
      },
    });

    await h.runtime.start();
    await applied(h);
    for (let i = 0; i < 4; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await applied(h);
    }

    const asked = h.attempts.filter(a => a.capability === 'light_temperature');
    assert.equal(asked.length, 3,
      `three refusals and then silence, not one a minute — saw ${asked.length}`);
  });

  test('and the reason is in the diagnostics, so one silent lamp is legible', async () => {
    const h = harness({
      plan: plan({ preStage: true, target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: false })],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
      },
    });

    await h.runtime.start();
    await applied(h);
    for (let i = 0; i < 2; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await applied(h);
    }

    const target = h.runtime.diagnostics().targets.find(t => t.id === 'l1')!;
    assert.equal(target.preStageDeclined?.count, 3);
    assert.match(target.preStageDeclined?.reason ?? '', /soft off/,
      "the integration's own sentence, kept because it ages out of recentFailures");

    // And it is NOT the device-wide switch: one lamp declining must not read as
    // pre-staging having been turned off for every lamp.
    assert.equal(h.runtime.diagnostics().preStage, true);
    assert.equal(h.runtime.diagnostics().preStageDisabled, null);
  });

  test('a decline does not take pre-staging from the lamps that stage correctly', async () => {
    // The measured split, in one house: `l1` refuses while off, `l2` does not.
    const h = harness({
      plan: plan({ preStage: true, target: { kind: 'devices', deviceIds: ['l1', 'l2'] } }),
      devices: [
        light('l1', undefined, { onoff: false }),
        light('l2', undefined, { onoff: false }),
      ],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
        when: device => device.id === 'l1',
      },
    });

    await h.runtime.start();
    await applied(h);
    // Long enough for the curve to move past the per-lamp deadband more than
    // once, so "still being staged" is a count and not a single write.
    for (let i = 0; i < 12; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await applied(h);
    }

    assert.equal(h.attempts.filter(a => a.deviceId === 'l1').length, 3,
      'the refusing lamp is asked three times and then left alone');
    assert.ok(h.writes.filter(w => w.deviceId === 'l2').length > 1,
      'the lamp that stages correctly goes on being staged');
  });

  test('the lamp is offered a colour again after it has been switched on', async () => {
    const h = harness({
      plan: plan({ preStage: true, target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: false })],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
        when: device => device.capabilitiesObj.onoff?.value !== true,
      },
    });

    await h.runtime.start();
    await applied(h);
    for (let i = 0; i < 3; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await applied(h);
    }
    const beforeCycle = h.attempts.filter(a => a.capability === 'light_temperature').length;

    // Somebody switches it on and off again. Each off-period re-tests once, so
    // a replaced bulb or a firmware fix recovers without an app restart.
    h.report('l1', 'onoff', true);
    await applied(h);
    h.report('l1', 'onoff', false);
    h.advance(60_000);
    await h.runtime.tick();
    await applied(h);

    assert.ok(h.attempts.filter(a => a.capability === 'light_temperature').length > beforeCycle,
      'the suppression is per off-period, not sticky until a restart');
  });

  /**
   * The probe wrote `light_temperature` straight through the adapter with no
   * `light_mode` first, unlike every production pre-stage write. Platform §6
   * measured that a lamp sitting in colour mode refuses a temperature "from
   * anything — this app or a direct API write", so on such a lamp the probe
   * changed nothing, the lamp stayed off, and it reported `stayedOff: true` — a
   * false pass on the exact question it exists to answer.
   */
  test('the probe switches the lamp into the mode it is about to write', async () => {
    const lamp = light('l1', ['onoff', 'dim', 'light_temperature', 'light_mode'], { onoff: false });
    const h = harness({ plan: plan({ preStage: true }), devices: [lamp, light('l2')] });
    await h.runtime.startIdle();

    const probe = h.runtime.probePreStage(0);
    await settle();
    h.runTimers();
    await probe;

    const order = h.writes.filter(w => w.deviceId === 'l1').map(w => w.capability);
    assert.deepEqual(order, ['light_mode', 'light_temperature'],
      'the mode goes first, or the lamp discards the value it enables');
  });

  /**
   * A colour-only lamp is the one a coloured curve drives, and the probe could
   * not see it: it filtered candidates on `light_temperature` alone, so a
   * household whose lamps do colour and not temperature was told there was
   * nothing to test.
   */
  test('the probe tests the axis the curve will actually write', async () => {
    const colourOnly = light('l1', ['onoff', 'light_hue', 'light_saturation'], { onoff: false });
    const h = harness({
      plan: plan({
        preStage: true,
        points: [
          { id: 'p1', anchor: { kind: 'clock', at: 21 * 60 }, warmth: 0.9, color: 'amber' },
          { id: 'p2', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 0.9, color: 'amber' },
        ],
      }),
      devices: [colourOnly],
    });
    await h.runtime.startIdle();

    const probe = h.runtime.probePreStage(0);
    await settle();
    h.runTimers();
    const outcome = await probe;

    assert.equal(outcome.deviceId, 'l1', 'a colour-only lamp IS testable');
    const written = h.writes.filter(w => w.deviceId === 'l1').map(w => w.capability);
    assert.ok(written.includes('light_hue'), `wrote ${written.join(', ')}`);
  });

  /**
   * The health check counted `light_temperature` alone, so a Curve light whose
   * points carry colours, pointed at colour-only lamps, was reported as "None of
   * its lights can change their warmth" and taken offline — while `planWrites()`
   * drives exactly that lamp on the hue axis, and the pairing screen's probe
   * tests it happily. Pair it, watch the test pass, save, find it unavailable.
   */
  test('a coloured curve over colour-only lamps is ready, not broken', async () => {
    const colourOnly = light('l1', ['onoff', 'light_hue', 'light_saturation']);
    const h = harness({
      plan: plan({
        target: { kind: 'devices', deviceIds: ['l1'] },
        points: [
          { id: 'p1', anchor: { kind: 'clock', at: 21 * 60 }, warmth: 0.9, color: 'amber' },
          { id: 'p2', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 0.9, color: 'amber' },
        ],
      }),
      devices: [colourOnly],
    });

    await h.runtime.start();
    await h.settle();

    assert.equal(h.runtime.currentState, 'ready');
  });

  test('a curve with no colours over colour-only lamps is still broken', async () => {
    // Nothing to drive it with: no temperature capability, and no colour asked
    // for. Reporting repair is right here.
    const colourOnly = light('l1', ['onoff', 'light_hue', 'light_saturation']);
    const h = harness({
      plan: plan({ target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [colourOnly],
    });

    await h.runtime.start();
    await h.settle();

    assert.equal(h.runtime.currentState, 'needs_repair');
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
    // The registry serves both device types; a runtime registered without a
    // kind is a curve light's, which is what this harness builds.
    assert.equal(diagnostics.kind, 'curve');
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
 * — that IS the feature (platform §12), and it is why leaving a subscription
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

  /**
   * On the FIRST catalogue change of a runtime's life, which is the case that
   * was broken.
   *
   * `this.snapshot` was written only by `refreshTargets()`, never by
   * `buildRuntime()`, so the first refresh diffed against `null` — `removed` came
   * back empty and `releaseTarget()` was never called for a light that had just
   * left the plan. Its capability subscription stayed live. The sibling test
   * above could not see it: the write is suppressed further down the path
   * whether the subscription is released or not.
   */
  test('the first refresh after start really releases the subscription', async () => {
    const h = harness({ plan: plan({ target: { kind: 'zone', zoneId: 'z1', includeSubzones: false } }) });
    await h.runtime.start();
    await h.settle();

    assert.equal(h.isSubscribed('l2', 'onoff'), true, 'it is a target to begin with');

    h.removeFromCatalogue('l2');
    // The FIRST refresh — nothing has set a snapshot before this point.
    await h.runtime.refreshTargets();
    await h.settle();

    assert.equal(
      h.isSubscribed('l2', 'onoff'), false,
      'a light that has left the plan keeps no listener on somebody else’s lamp',
    );
    assert.equal(h.isSubscribed('l1', 'onoff'), true, 'and the remaining target keeps its own');
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

/**
 * A lamp is written on ONE of the two axes, and switching axes needs a mode
 * write to land first (platform §6). These are about the moment it switches.
 */
describe('crossing between a coloured segment and a temperature one', () => {
  /**
   * Three points, so that ONE segment has a colour at neither end.
   *
   * Two would not do it: a segment with a colour at either end holds that
   * colour flat, so with one coloured point out of two every segment is a
   * coloured one. With the colour at 06:00 the day reads — 06:00→12:00 coloured
   * (from-end), 12:00→18:00 TEMPERATURE, 18:00→06:00 coloured (to-end).
   */
  const mixedPlan = () => plan({
    points: [
      { id: 'dawn', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.9, color: 'ember' },
      { id: 'noon', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2 },
      { id: 'dusk', anchor: { kind: 'clock', at: 18 * 60 }, warmth: 0.6 },
    ],
  });

  /** Copenhagen is UTC+2 in August, so these are local hours. */
  const localHour = (hour: number) => Date.UTC(2026, 7, 18, hour - 2, 0);

  const modeWrites = (writes: Written[]) =>
    writes.filter(w => w.capability === 'light_mode').map(w => w.value);

  test('the mode write survives the SECOND crossing, not just the first', async () => {
    /**
     * The regression. `planTemperature` returns two writes — the mode, then the
     * temperature — and the deadband filter used to run per write. Handed the
     * mode write, `hasMoved` compared the string 'temperature', got NaN, and
     * NaN >= step is false, so the mode was dropped whenever a warmth had ever
     * been recorded for that lamp. The temperature then went to a lamp still in
     * colour mode, which refuses it outright.
     *
     * The first crossing always worked, which is why this is about the second:
     * on a curve that repeats daily, every crossing after the first left the
     * lamp on the colour it last held.
     */
    const h = harness({ devices: [colourLamp('l1')], plan: mixedPlan(), now: localHour(9) });
    await h.runtime.start();
    await applied(h);

    // Into the temperature segment: the FIRST crossing.
    h.at(localHour(15));
    await h.runtime.tick();
    await applied(h);

    // Back into colour.
    h.at(localHour(20));
    await h.runtime.tick();
    await applied(h);

    const before = h.writes.length;

    // And into temperature again: the second crossing.
    h.at(localHour(15) + 24 * 60 * 60_000);
    await h.runtime.tick();
    await applied(h);

    const crossing = h.writes.slice(before);
    assert.deepEqual(modeWrites(crossing), ['temperature'],
      'the second crossing needs the mode write as much as the first');
    const order = crossing.map(w => w.capability);
    assert.ok(order.indexOf('light_mode') < order.indexOf('light_temperature'),
      'mode must precede the temperature it enables, got ' + order.join(' -> '));
  });

  test('a flat temperature segment writes no mode at all', async () => {
    /**
     * The other half of the fix, and the reason the mode write is not simply
     * exempted from the deadband: exempted, it would go out on every tick for
     * the whole life of a segment the curve is barely moving through.
     */
    const h = harness({ devices: [colourLamp('l1')], plan: mixedPlan(), now: localHour(15) });
    await h.runtime.start();
    await applied(h);

    const before = h.writes.length;
    // A minute of a segment this shallow is a no-op at two decimals.
    h.advance(60_000);
    await h.runtime.tick();
    await applied(h);

    assert.equal(h.writes.length, before, 'no temperature to write means no mode to write either');
  });

  test('a colour write voids the warmth we remember', async () => {
    /**
     * The mirror of the voiding a temperature write already did to the recorded
     * colour. A colour takes the lamp OUT of temperature mode, so the
     * temperature we last sent is no longer what it is showing — held, it told
     * the deadband the lamp was already at today's warmth, and a daily curve
     * repeats its warmths exactly.
     */
    const h = harness({ devices: [colourLamp('l1')], plan: mixedPlan(), now: localHour(15) });
    await h.runtime.start();
    await applied(h);

    const warmth = () => h.runtime.diagnostics().targets[0].lastWritten?.warmth;
    assert.notEqual(warmth(), undefined, 'a temperature segment records a warmth');

    h.at(localHour(20));
    await h.runtime.tick();
    await applied(h);

    assert.equal(warmth(), undefined, 'the colour write voids it');
    assert.notEqual(h.runtime.diagnostics().targets[0].lastWritten?.color, undefined,
      'and records what it put there instead');
  });
});

describe('a brightness a person chose is a brightness the lamp shows', () => {
  const dims = (writes: Written[]) =>
    writes.filter(w => w.capability === 'dim').map(w => w.value);

  const flatPlan = (brightness: number) => plan({
    adjustBrightness: true,
    points: [
      { id: 'a', anchor: { kind: 'clock', at: 0 }, warmth: 0.5, brightness },
      { id: 'b', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.5, brightness },
    ],
  });

  test('the dimmest setting is dim 0.01, not 0.00', async () => {
    /**
     * γ = 2.2 turns 5% into 0.0014, and `dim` reports two decimals, so it was
     * quantised to 0.00 — off, on most lamps. That was the LOWEST position the
     * brightness sliders offered, and on a curve it held there for the eight
     * minutes either side of the point. The sliders now start at 10%, and this
     * is the floor underneath any plan stored before they did.
     */
    const h = harness({ devices: [light('l1')], plan: flatPlan(0.05) });
    await h.runtime.start();
    await applied(h);

    assert.deepEqual(dims(h.writes), [0.01],
      'a positive brightness must stay positive through the perceptual curve');
  });

  test('a brightness well above the floor is untouched', async () => {
    const h = harness({ devices: [light('l1')], plan: flatPlan(0.6) });
    await h.runtime.start();
    await applied(h);

    // 0.6^2.2 = 0.325, quantised to two decimals.
    assert.deepEqual(dims(h.writes), [0.33], 'the floor must not reshape the rest of the curve');
  });
});

describe('the diagnostics can describe a Curve light', () => {
  const colouredPlan = () => plan({
    points: [
      { id: 'a', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.9, color: 'ember' },
      { id: 'b', anchor: { kind: 'clock', at: 18 * 60 }, warmth: 0.2, color: 'ocean' },
    ],
  });

  test('a coloured point reports the colour that drives the lamp', () => {
    /**
     * `warmth` on a coloured point is only the fallback for lamps that cannot
     * take a colour, so a projection carrying warmth alone made a coloured point
     * indistinguishable from a plain temperature point at the same value — the
     * one field a "my Curve light went the wrong colour" report needs.
     */
    const h = harness({ devices: [colourLamp('l1')], plan: colouredPlan() });

    assert.deepEqual(h.runtime.diagnostics().points.map(p => p.color), ['ember', 'ocean']);
  });

  test('an action on a coloured segment names the colours it is between', async () => {
    const h = harness({ devices: [colourLamp('l1')], plan: colouredPlan(), now: MORNING });
    await h.runtime.start();
    await applied(h);

    const { lastAction } = h.runtime.diagnostics();
    assert.deepEqual(lastAction?.colorLabelKeys, ['palette.ember', 'palette.ocean']);
    assert.notEqual(lastAction?.color, undefined,
      'the warmth beside it is the value a colour-capable lamp did NOT get');
  });

  test('a pass that does nothing says so, rather than leaving the last one standing', async () => {
    /**
     * These paths used to return and leave `lastAction` alone, so a plan
     * switched off an hour ago reported the last pass that DID something — and
     * a switched-off device was indistinguishable from one that had stopped
     * ticking.
     */
    const h = harness({ devices: [light('l1')], plan: plan({ enabled: false }) });
    await h.runtime.tick();

    const { lastAction } = h.runtime.diagnostics();
    assert.equal(lastAction?.writes, 0);
    assert.match(lastAction?.detail ?? '', /switched off/);
  });

  test('a colour-only lamp is not reported as one nothing can be done with', async () => {
    const h = harness({
      devices: [light('l1', ['onoff', 'dim', 'light_hue', 'light_saturation'])],
      plan: colouredPlan(),
    });
    await h.runtime.start();
    await h.settle();

    const target = h.runtime.diagnostics().targets[0];
    assert.equal(target.canWarm, false);
    assert.equal(target.canColor, true, 'it is driven perfectly well, on the other axis');
  });
});

describe('a curve point whose brightness follows the daylight', () => {
  const RESPONSE = { sensors: ['s1'], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 };

  const evaluator = (brightness: number, source = 'sensors') => ({
    evaluate: () => ({ brightness, source }),
  });

  /** Both points follow the daylight, so the whole curve does. */
  const following = (over: Partial<CircadianPlan> = {}) => plan({
    points: [
      { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2, brightness: 0.5, fromDaylight: true },
      { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 0.5, fromDaylight: true },
    ],
    adjustBrightness: true,
    daylight: RESPONSE,
    ...over,
  });

  test('the curve reads the daylight, not the stored number', async () => {
    const h = harness({ plan: following(), daylight: evaluator(0.8) });
    await h.runtime.start();
    await h.runtime.drain();

    // Both points at the same daylight brightness, so every minute of the day
    // is that brightness however the interpolation lands.
    assert.equal(h.runtime.currentValue()!.brightness, 0.8);
  });

  test('and it FOLLOWS: a later tick reads it again', async () => {
    /**
     * The difference from a schedule window, which samples once at its boundary.
     * A curve has a value at every minute and a tick to re-ask on, so this
     * really does track the room — and that is the reason both device types
     * exist rather than one.
     */
    let brightness = 0.9;
    const h = harness({
      plan: following(),
      daylight: { evaluate: () => ({ brightness, source: 'sensors' }) },
    });
    await h.runtime.start();
    await h.runtime.drain();
    assert.equal(h.runtime.currentValue()!.brightness, 0.9);

    // A cloud passes.
    brightness = 0.3;
    assert.equal(h.runtime.currentValue()!.brightness, 0.3);
  });

  test('a point that does NOT follow keeps its own number, in the same curve', async () => {
    // A mixed curve is the interesting case: the segment between a fixed point
    // and a daylight one has to be an ordinary blend, which is exactly what
    // resolving to numbers before valueAt() buys.
    const h = harness({
      plan: following({
        points: [
          { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2, brightness: 0.4 },
          { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 0.5, fromDaylight: true },
        ],
      }),
      daylight: evaluator(0.9),
      // 22:15 Copenhagen: an hour before the night point, deep in the segment.
      now: EVENING,
    });
    await h.runtime.start();

    const brightness = h.runtime.currentValue()!.brightness!;
    assert.ok(brightness > 0.4 && brightness < 0.9, `expected a blend, got ${brightness}`);
  });

  test('falls back to the stored numbers when nothing can tell how light it is', async () => {
    const h = harness({ plan: following(), daylight: evaluator(0.8, 'none') });
    await h.runtime.start();

    assert.equal(h.runtime.currentValue()!.brightness, 0.5);
  });

  test('falls back with a response but no evaluator wired', async () => {
    const h = harness({ plan: following() });
    await h.runtime.start();

    assert.equal(h.runtime.currentValue()!.brightness, 0.5);
  });

  test('a curve with no daylight response pays nothing for the feature', async () => {
    // The plan's own array is returned untouched — not even an allocation — so a
    // curve that does not use this is exactly as it was.
    const h = harness({ plan: plan(), daylight: evaluator(0.8) });
    await h.runtime.start();

    assert.equal(h.runtime.currentValue()!.brightness, undefined);
  });

  test('the report names which points follow the daylight', async () => {
    const h = harness({ plan: following(), daylight: evaluator(0.8) });
    await h.runtime.start();

    const points = h.runtime.diagnostics().points;
    assert.deepEqual(points.map(p => p.fromDaylight), [true, true]);
    // The stored fallback is reported beside it, because "it used 50% when it
    // should have followed the room" needs both numbers to tell apart.
    assert.deepEqual(points.map(p => p.brightness), [0.5, 0.5]);
  });
});
