import { test, describe } from 'node:test';
import { ownsNothing, zoneLights } from '../support/fake-catalog';
import { FakeTimers } from '../support/fake-timers';
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
  /** 'light', or a zone target skips it — the real `lightsInZone` rule. */
  class: string;
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
  return { id, name: id, zoneName: 'Kitchen', class: 'light', capabilities, capabilitiesObj, available: true };
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
  /**
   * Lamps whose integration switches them ON when sent a colour while off —
   * the outcome pre-staging exists to rule out (platform §6).
   */
  turnsOnWhenSet?: string[];
} = {}) {
  const devices = options.devices ?? [light('l1'), light('l2')];
  /** Lamps refusing every write, settable after start. See setCapabilityValue. */
  const refusing = new Set<string>();
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  /** Every write ATTEMPTED, refused or not. See setCapabilityValue below. */
  const attempts: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  const states: Array<{ state: string; detail?: unknown }> = [];
  const plans: CircadianPlan[] = [];
  const logs: string[] = [];
  /** deviceId:capability -> the listener Homey would call. */
  const listeners = new Map<string, (value: unknown) => void>();
  /**
   * The shared clock. The wall clock is moved by `advance`/`at` WITHOUT firing
   * anything — every test here decides when the post-write checks run, with
   * `runTimers()` — so it is `setNow`, and the checks are `runPending()`.
   *
   * This used to be a bare list whose `clearTimeout` did nothing, so a check
   * the runtime had cancelled (a teardown, a superseding write) still ran.
   */
  const timers = new FakeTimers(options.now ?? EVENING);

  const deviceHandle = (id: string) => {
    const device = devices.find(d => d.id === id)!;
    return {
      ...device,
      async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
        // BEFORE the refusal, and `writes` is after it. A refused write is
        // invisible in `writes` by construction, which is exactly what a test
        // counting how often we retry a refusing lamp has to see.
        attempts.push({ deviceId: id, capability: capabilityId, value });
        // A lamp cut at the wall: still `available` (platform §6), accepts
        // nothing. Switchable AFTER start, because the finding this exists for
        // is a lamp that goes wrong on a runtime that started healthy.
        if (refusing.has(id)) throw new Error(`${id} did not respond`);
        if (options.refuseWrite?.capability === capabilityId
          && (options.refuseWrite.when?.(device) ?? true)) {
          throw new Error(options.refuseWrite.message);
        }
        writes.push({ deviceId: id, capability: capabilityId, value });
        // The Homey reports back what it was told, which is what makes the echo
        // dedupe and the override tolerance worth testing at all.
        if (device.capabilitiesObj[capabilityId]) device.capabilitiesObj[capabilityId].value = value;
        if (options.turnsOnWhenSet?.includes(id)
          && (capabilityId === 'light_temperature' || capabilityId === 'light_hue')
          && device.capabilitiesObj.onoff?.value === false) {
          device.capabilitiesObj.onoff.value = true;
        }
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
    now: timers.now,
    // Held rather than run: the pre-stage check must be assertable without
    // costing the suite a real 1.5 seconds.
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
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
      timers.runPending();
    },
    advance(ms: number) { timers.setNow(timers.now() + ms); },
    refuseWrites(id: string) { refusing.add(id); },
    acceptWrites(id: string) { refusing.delete(id); },
    at(ms: number) { timers.setNow(ms); },
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

/**
 * `preStage: true` here means "chosen, AND the test passed every target" unless
 * a test says otherwise: that is the device every pre-staging test below was
 * written against, and since the review screen's per-lamp test the choice alone
 * pre-stages nothing (`preStagesLamp()`). A test about the untested case, or
 * about one lamp passing and one not, passes `preStageLights` itself.
 */
function plan(over: Partial<CircadianPlan> = {}): CircadianPlan {
  const built: CircadianPlan = {
    schemaVersion: 2,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    transition: 'balanced',
    // Deliberately steep, so a few hours of simulated time is a visible change.
    points: [
      { id: 'day', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2 },
      { id: 'night', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1 },
    ],
    adjustBrightness: false,
    preStage: false,
    ...over,
  };
  if (built.preStage && over.preStageLights === undefined && built.target.kind === 'devices') {
    built.preStageLights = [...built.target.deviceIds];
  }
  return built;
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

describe('a colour reported by a lamp that is OFF', () => {
  /**
   * Found on hardware, 23 September 2026: a house-wide "Test my lights" sent a
   * colour to three OFF Studio spots, and the household's own Studio curve —
   * which drives them — filed all three as a person, at `light_hue` 0.1, within
   * 200 ms. The same test from Repair does it to the device being repaired, and
   * two devices pre-staging lamps they share do it to each other. An override on
   * an off lamp protects nothing (the switch-on clears it) and costs the lamp its
   * pre-staging, so no report on an off lamp is an override, on any axis.
   */
  test('a colour or a warmth sent to an off lamp by someone else is not a person', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', ['onoff', 'dim', 'light_temperature', 'light_hue', 'light_saturation'], { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();

    h.advance(10_000);
    h.report('l1', 'light_hue', 0.1);
    h.report('l1', 'light_temperature', 0.95);

    const target = h.runtime.diagnostics().targets.find((t: any) => t.id === 'l1');
    assert.equal(target?.overridden, false, 'an off lamp was stood down for a report');
    const reasons = h.runtime.diagnostics().recentControlEvents
      .filter((event: any) => event.type === 'report_ignored' && event.deviceId === 'l1')
      .map((event: any) => event.reason);
    assert.ok(reasons.includes('lamp_off'), 'and it is recorded as set aside, not swallowed');
  });

  test('the same report on a lamp that is ON is still a person', async () => {
    // The rule is about the lamp being off, and must not grow into a blind spot.
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);

    const target = h.runtime.diagnostics().targets.find((t: any) => t.id === 'l1');
    assert.equal(target?.overridden, true);
  });
});

describe('pre-staging that turns out to be unsafe', () => {
  test('strikes that one lamp off, persists that, and does not switch it back off', async () => {
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

    // One lamp's verdict, not the device's: l2 passed its own test, and one
    // integration switching a lamp on is no evidence about another.
    assert.deepEqual(h.runtime.currentPlan.preStageLights, ['l2'], 'only l1 loses its pass');
    assert.equal(h.runtime.currentPlan.preStage, true, 'the household\'s choice stays');
    assert.deepEqual(h.plans.at(-1)?.preStageLights, ['l2'], 'and the verdict must be persisted');
    assert.equal(
      h.writes.filter(w => w.capability === 'onoff').length, 0,
      'switching off a room somebody may have just lit is the worse failure',
    );
    assert.ok(h.runtime.diagnostics().preStageDisabled, 'and it is reported, not hidden');
  });

  /**
   * "Test my {n} lights": every lamp, in parallel, each put back.
   *
   * The probe waits twice per lamp (settle off, then the check), and each wait
   * is an injected timer — so this drives timers until it answers.
   */
  async function finish<T>(h: ReturnType<typeof harness>, pending: Promise<T>): Promise<T> {
    let done = false;
    pending.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 30 && !done; i += 1) {
      await h.settle();
      h.runTimers();
    }
    return pending;
  }

  test('the per-lamp test passes a lamp that stays off and fails one that comes on', async () => {
    const h = harness({
      plan: plan({ preStage: true, preStageLights: [] }),
      devices: [light('l1', undefined, { onoff: false }), light('l2', undefined, { onoff: false })],
      turnsOnWhenSet: ['l2'],
    });
    await h.runtime.startIdle();

    const outcome = await finish(h, h.runtime.probePreStageAll(0));

    assert.deepEqual(outcome.lights.map(lamp => [lamp.deviceId, lamp.ok]), [['l1', true], ['l2', false]]);
    assert.match(String(outcome.lights[1]!.reason), /came on/);
    // Both put back: l2 came on by itself and is switched off again, because
    // here the user asked for the test and is standing in front of it.
    assert.equal(outcome.lights.every(lamp => lamp.restored), true);
    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff'),
      [{ deviceId: 'l2', capability: 'onoff', value: false }],
    );
  });

  test('a lamp that is ON is switched off to be tested, then put back as it was', async () => {
    // The evening case: every light in the room is on. Testing only the ones
    // that happened to be off would leave nothing to pre-stage at all.
    const h = harness({
      plan: plan({ preStage: true, preStageLights: [], target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: true, dim: 0.7, light_temperature: 0.3 })],
    });
    await h.runtime.startIdle();

    const outcome = await finish(h, h.runtime.probePreStageAll(0));

    assert.equal(outcome.lights[0]!.ok, true);
    assert.equal(outcome.lights[0]!.restored, true);
    const onoff = h.writes.filter(w => w.capability === 'onoff').map(w => w.value);
    assert.deepEqual(onoff, [false, true], 'off to test, on again afterwards');
    // Back to its own brightness and warmth, sent once it is on again.
    const last = (capability: string) => h.writes.filter(w => w.capability === capability).at(-1)?.value;
    assert.equal(last('dim'), 0.7);
    assert.equal(last('light_temperature'), 0.3);
  });

  test('a lamp that refuses a colour while off is a fallback, not an error', async () => {
    const h = harness({
      plan: plan({ preStage: true, preStageLights: [], target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: false })],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) l1 is "soft off", command may not have effect',
        when: device => device.capabilitiesObj.onoff.value === false,
      },
    });
    await h.runtime.startIdle();

    const outcome = await finish(h, h.runtime.probePreStageAll(0));

    assert.equal(outcome.lights[0]!.ok, false);
    assert.match(String(outcome.lights[0]!.reason), /soft off/, 'the integration\'s own words');
  });

  test('a brightness-only lamp is a fallback without being written to', async () => {
    // Nothing to set in advance: a `dim` write is what switches a lamp on.
    const h = harness({
      plan: plan({ preStage: true, preStageLights: [], target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', ['onoff', 'dim'], { onoff: false })],
    });
    await h.runtime.startIdle();

    const outcome = await finish(h, h.runtime.probePreStageAll(0));

    assert.equal(outcome.lights[0]!.ok, false);
    assert.equal(h.writes.length, 0);
  });

  test('a device that was chosen but never tested pre-stages nothing', async () => {
    // Every device paired before the per-lamp test existed, with `preStage:
    // true` stored, reads this way: option 2, untested, behaving as option 1.
    const h = harness({
      plan: plan({ preStage: true, preStageLights: [] }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await settle();

    assert.equal(h.writes.some(w => w.deviceId === 'l1'), false, 'an off lamp was written to');
    assert.ok(h.writes.some(w => w.deviceId === 'l2'), 'the lamp that is on is still driven');
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

  test('a probe whose runtime stops mid-wait writes nothing to the lamp', async () => {
    /**
     * The one timer in this runtime that `stop()` cannot cancel, so the wait is
     * followed by a check rather than made cancellable — a probe is a request
     * the USER made, and pausing the device mid-test must not leave them
     * staring at a button that never answers.
     *
     * What must not happen is the work AFTER the wait: `refresh()` re-creates a
     * cache entry `stop()` has just cleared, and the restore writes
     * `onoff: false` — from a runtime that is no longer running, to a lamp the
     * user's own test has just lit.
     */
    const h = harness({
      plan: plan({ preStage: true }),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.startIdle();

    const probe = h.runtime.probePreStage(0);
    await settle();
    // The device is deleted, or the app is shutting down, while the probe is
    // sitting in its wait.
    await h.runtime.stop();
    const before = h.writes.length;

    h.runTimers();
    const outcome = await probe;

    assert.equal(outcome.stayedOff, false);
    assert.match(String(outcome.reason), /switched off before the test finished/);
    assert.equal(
      h.writes.length, before,
      'a stopped runtime wrote to the lamp after its own teardown',
    );
    assert.equal(
      h.writes.some(w => w.capability === 'onoff' && w.value === false), false,
      'and the restore in particular must not run',
    );
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
   * But not for ever, and this is the half that was missing.
   *
   * "Each off-period re-tests once" is sound in a room somebody enters twice an
   * evening and worthless in one on a motion sensor. Measured on the reference
   * Homey, 17 September 2026: an Activity Room switching every ~112 s, five
   * lamps, every one of them refusing every colour it was ever offered — about
   * 326 deterministic failures a day, HALF that device's whole write volume, for
   * a fact re-derived from scratch every two minutes.
   */
  test('a lamp that refuses off-period after off-period stops being re-tested', async () => {
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

    // Three off-periods, each one refusing everything it is offered. The third
    // is what trips the outer bound.
    const offPeriod = async () => {
      for (let i = 0; i < 3; i += 1) {
        h.advance(60_000);
        await h.runtime.tick();
        await applied(h);
      }
      h.report('l1', 'onoff', true);
      await applied(h);
      h.report('l1', 'onoff', false);
      await applied(h);
    };
    await offPeriod();
    await offPeriod();
    await offPeriod();

    const backoff = h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.preStageBackoff;
    assert.equal(backoff?.periods, 3, 'three fully-declined off-periods in a row');
    assert.ok(typeof backoff?.retestAt === 'number', 'and a moment it is next looked at again');

    // Somebody uses the room again. The rising edge still writes — a lamp that is
    // ON is this device type's whole job, and none of this is about that — so
    // the count is taken after it, and what must not move is the OFF-period.
    h.report('l1', 'onoff', true);
    await applied(h);
    h.report('l1', 'onoff', false);
    await applied(h);
    const before = h.attempts.filter(a => a.capability === 'light_temperature').length;

    for (let i = 0; i < 5; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await applied(h);
    }
    assert.equal(h.attempts.filter(a => a.capability === 'light_temperature').length, before,
      'switching it on no longer re-arms the three futile writes');
    await h.runtime.stop();
  });

  /**
   * The re-test deadline runs from when the backoff was set, and a switch-on
   * must not postpone it — the same trap `noteOverride` fell into, where the one
   * thing that ends a state could be deferred for ever by the one thing that
   * cannot stop happening.
   */
  test('a day later the lamp is offered a colour again', async () => {
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
    for (let period = 0; period < 3; period += 1) {
      for (let i = 0; i < 3; i += 1) {
        h.advance(60_000);
        await h.runtime.tick();
        await applied(h);
      }
      h.report('l1', 'onoff', true);
      await applied(h);
      h.report('l1', 'onoff', false);
      await applied(h);
    }
    assert.ok(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.preStageBackoff);

    // A whole day of the room being used, which must neither re-test it early
    // nor push the deadline out.
    h.advance(25 * 60 * 60_000);
    const before = h.attempts.filter(a => a.capability === 'light_temperature').length;
    h.report('l1', 'onoff', true);
    await applied(h);
    h.report('l1', 'onoff', false);
    await applied(h);

    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.preStageBackoff,
      undefined, 'the backoff is dropped, so the lamp starts from nothing again');
    h.advance(60_000);
    await h.runtime.tick();
    await applied(h);
    assert.ok(h.attempts.filter(a => a.capability === 'light_temperature').length > before,
      'and it is offered a colour once more');
    await h.runtime.stop();
  });

  /**
   * One success is proof, and it has to clear BOTH counts. Leaving the outer one
   * would stand a lamp down tomorrow on the strength of periods it has just
   * disproved.
   */
  test('taking a colour clears the run of refusing off-periods', async () => {
    let refusing = true;
    const h = harness({
      plan: plan({ preStage: true, target: { kind: 'devices', deviceIds: ['l1'] } }),
      devices: [light('l1', undefined, { onoff: false })],
      refuseWrite: {
        capability: 'light_temperature',
        message: 'device (light) abc is "soft off", command (.color_temperature.mirek) '
          + 'may not have effect',
        when: () => refusing,
      },
    });

    await h.runtime.start();
    await applied(h);
    for (let period = 0; period < 2; period += 1) {
      for (let i = 0; i < 3; i += 1) {
        h.advance(60_000);
        await h.runtime.tick();
        await applied(h);
      }
      h.report('l1', 'onoff', true);
      await applied(h);
      h.report('l1', 'onoff', false);
      await applied(h);
    }
    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.preStageBackoff?.periods, 2);

    // The bulb is replaced, and takes the next colour it is offered.
    refusing = false;
    h.advance(60_000);
    await h.runtime.tick();
    await applied(h);

    const target = h.runtime.diagnostics().targets.find(t => t.id === 'l1')!;
    assert.equal(target.preStageBackoff, undefined, 'the run is broken');
    assert.equal(target.preStageDeclined, undefined, 'and so is the within-period streak');
    await h.runtime.stop();
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
   * The health check counted `light_temperature` alone, so a Colour Curve Light whose
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

  /**
   * A lamp that has stopped accepting writes reaches the TILE.
   *
   * `light-target-adapter.ts` says the failure streak exists so that a runtime
   * does not "go on writing to that lamp every minute for ever behind a green
   * tile" — and it did exactly that, because `assessHealth()` ran at start and
   * on a target-set change and nowhere else. A lamp cut at the wall stays
   * `available: true` (platform §6), so the target fingerprint never moves and
   * `unwritableTargets()` was consulted once: at start, when it was empty.
   */
  test('a write-failure streak moves the state off ready', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();
    assert.equal(h.runtime.currentState, 'ready');

    h.refuseWrites('l1');
    // Three failures and five minutes are what the adapter calls unwritable;
    // the two-hour steps are so the curve has genuinely moved each time and a
    // write is actually planned. `applied()` is what dispatches them.
    for (let i = 0; i < 4; i += 1) {
      h.advance(2 * 60 * 60_000);
      await h.runtime.tick();
      await applied(h);
    }

    assert.notEqual(
      h.runtime.currentState, 'ready',
      'the lamp took four failed writes and the tile stayed green',
    );
    assert.equal(h.runtime.currentState, 'partial', 'one of two lamps is gone');
  });

  test('and a healthy runtime does not churn its state once a minute', async () => {
    // The guard: `assessHealth()` awaits `retrySubscriptions()`, so an
    // unconditional re-assess would retry every subscription every minute for
    // as long as the app runs.
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();
    const at = h.runtime.diagnostics().stateRevision;

    for (let i = 0; i < 3; i += 1) {
      h.advance(60_000);
      await h.runtime.tick();
      await settle();
    }

    assert.equal(h.runtime.diagnostics().stateRevision, at, 'the state churned on a quiet room');
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
    // kind is a Colour Curve Light's, which is what this harness builds.
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

describe('the diagnostics can describe a Colour Curve Light', () => {
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
     * one field a "my Colour Curve Light went the wrong colour" report needs.
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

/**
 * "A curve point whose brightness follows the daylight" used to be a block here.
 *
 * `fromDaylight` is gone from a curve point, along with the inline `daylight`
 * response on the plan: brightness from the room is what a Room-sensing Light is
 * for, and offering it on four device types meant four screens carrying the same
 * 250-line card. `daylight-runtime.test.ts` is where following the room lives.
 */


test('circadian power restoration cannot create an override before its write completes', async () => {
  const h = harness({ devices: [light('l1', undefined, { onoff: false })] });
  await h.runtime.start();
  h.advance(10_000);
  h.report('l1', 'onoff', true);
  h.report('l1', 'light_temperature', 0.8);
  assert.equal(h.runtime.diagnostics().targets[0].overridden, false);
  assert.ok(h.runtime.diagnostics().recentControlEvents.some(e => e.reason === 'power_settling'));
  await applied(h);
  h.advance(10_000);
  for (const value of [null, '', '0.9', NaN, -1]) h.report('l1', 'light_temperature', value);
  assert.equal(h.runtime.diagnostics().targets[0].overridden, false);
  h.report('l1', 'light_temperature', 0.5);
  assert.equal(h.runtime.diagnostics().targets[0].override?.capability, 'light_temperature');
  const action = h.runtime.diagnostics().recentActions.find(a => a.batchId);
  assert.ok(action?.completedAt);
  assert.ok(action.outcomes?.length);
  await h.runtime.stop();
});

/**
 * What a 3.83-day recording on the reference Homey showed this device type
 * doing, and the three rules that came out of it.
 *
 * All three are about the same mistake: reading a LAMP as a PERSON. The
 * override machinery above is correct and necessary, and every one of its
 * consequences — stop writing, stay stopped — is wrong when the thing that
 * raised it was not somebody's hand.
 */
describe('what the week-long recording found', () => {
  test('an override lapses, so a lamp that reverts our writes cannot mute the device for ever', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    /**
     * The lamp from the recording: it accepted every write, acknowledged it,
     * and reverted to its own fixed value ninety seconds later, every time.
     * That revert is indistinguishable from a person here — which is the point.
     * Its circadian device stood down for 88 of 93 hours reporting `ready`.
     */
    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);
    h.advance(3 * 60 * 60_000);
    await h.runtime.tick();
    await applied(h);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true, 'three hours in, still stood down');

    h.advance(2 * 60 * 60_000);
    const before = h.writes.length;
    await h.runtime.tick();
    await applied(h);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false);
    assert.equal(d.targets[0].override, null);
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'expired'));
    assert.ok(h.writes.slice(before).some(w => w.deviceId === 'l1'), 'control resumes on the very same pass');
    await h.runtime.stop();
  });

  /**
   * `resolveSnapshot` seeds every capability in WATCHED_CAPABILITIES, but this
   * runtime only SUBSCRIBES to what it plans from — so an unwatched field keeps
   * its boot value and never moves again.
   *
   * Measured on the reference Homey, 17 September 2026: five lamps drawn as
   * `dim: 0` while on, 22.7 hours after the snapshot that said so, with the
   * Room-sensing Light pointed at the same five reading 0.03 in the same
   * capture. Diagnostics is the field's only audience.
   */
  test('reported values leave out the capabilities this device does not follow', async () => {
    const h = harness({ plan: plan({ adjustBrightness: false }) });
    await h.runtime.start();
    await settle();

    const reported = h.runtime.diagnostics().targets[0]!.reported;
    assert.equal('dim' in reported, false,
      'a curve that does not touch brightness must not quote a stale one');
    assert.ok('onoff' in reported && 'light_temperature' in reported,
      'what it does follow is still there');
    await h.runtime.stop();
  });

  test('and keeps them when the plan does adjust brightness', async () => {
    const h = harness({ plan: plan({ adjustBrightness: true }) });
    await h.runtime.start();
    await settle();

    assert.ok('dim' in h.runtime.diagnostics().targets[0]!.reported);
    await h.runtime.stop();
  });

  test('a reported dim of 0 is a lamp going off, whatever onoff has said so far', async () => {
    const h = harness({ now: MORNING, plan: plan({ adjustBrightness: true }) });
    await h.runtime.start();
    await settle();

    // The measured ordering: `dim 0` arrives a median of 29.9 s AHEAD of the
    // `onoff: false` that explains it, so `actualOn` is still true right here.
    h.advance(10_000);
    h.report('l1', 'dim', 0);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false, 'switching a lamp off is not overriding us');
    assert.ok(d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'dim_zero'));
    assert.equal(d.recentControlEvents.filter(e => e.type === 'override').length, 0);
    await h.runtime.stop();
  });

  test('the colour a lamp comes back on at does not stand its runtime down', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    /**
     * The other half of the day-long capture's finding, on the axis this
     * runtime drives. A lamp restores whatever it was last showing and says so
     * — measured at 4.4 s after the `onoff` edge, past a settle window whose
     * length is coupled to OUR write burst rather than to the bridge's.
     */
    h.advance(10_000);
    h.report('l1', 'onoff', false);
    h.report('l1', 'onoff', true);
    await settle();
    h.advance(4_400);
    h.report('l1', 'light_temperature', 0.95);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false);
    assert.ok(d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'power_restore'));

    // And the person who then reaches for the dimmer is still a person.
    h.advance(5_000);
    h.report('l1', 'light_temperature', 0.05);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true);
    await h.runtime.stop();
  });

  test('a bridge exactly one tolerance away is forgiven wherever it sits on the axis', async () => {
    // 08:00 is the MIDPOINT of 06:00 → 10:00, so the value written is 0.25
    // whatever the curve's shape — every transition passes through halfway at
    // halfway. It used to ride on the default plan's eased value at 08:00,
    // which moved when the raised cosine gave way to Balanced and landed on
    // 0.26, where neither direction is a floating-point boundary case.
    const h = harness({
      now: MORNING,
      plan: plan({
        points: [
          { id: 'a', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.2 },
          { id: 'b', anchor: { kind: 'clock', at: 10 * 60 }, warmth: 0.3 },
        ],
      }),
    });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;

    /**
     * `Math.abs(0.83 - 0.86)` is 0.030000000000000027, so the old
     * `<= OVERRIDE_TOLERANCE` forgave a bridge three hundredths out at one end
     * of the axis and called it a person at the other. Seen in the recording as
     * `light_temperature 0.83` against our 0.86.
     */
    h.advance(10_000);
    // UP rather than down, because only one direction is a boundary case from
    // this plan's value: 0.25 vs 0.22 subtracts to exactly 0.03, 0.25 vs 0.28
    // to 0.030000000000000027. The guard below is what keeps that choice
    // honest if the plan ever changes — a test that quietly stopped exercising
    // the boundary would assert nothing at all.
    const reported = Number((written + 0.03).toFixed(2));
    assert.ok(
      Math.abs(reported - written) > 0.03,
      `${reported} vs ${written} is not a floating-point boundary case`,
    );
    h.report('l1', 'light_temperature', reported);

    h.advance(3 * 60 * 60_000);
    const before = h.writes.length;
    await h.runtime.tick();
    await applied(h);

    assert.equal(h.runtime.diagnostics().targets[0].overridden, false);
    assert.equal(h.writes.slice(before).filter(w => w.deviceId === 'l1').length, 1);
    await h.runtime.stop();
  });
});

/**
 * What a capture on the reference Homey found, switching two rooms on at the
 * wall, and the two rules that came out of it.
 *
 * Both are the same mistake the week-long recording found, arriving by a
 * different road: a lamp that comes on holding what it held last is not a
 * person, and a lamp that keeps saying so must not be able to postpone the only
 * way out of the verdict for ever.
 */
describe('what the switch-on capture found', () => {
  test('a lamp that comes on holding its old value has not been taken over', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', undefined, { onoff: false, light_temperature: 0.05 })],
    });
    await h.runtime.start();
    await settle();

    h.advance(10_000);
    h.report('l1', 'onoff', true);
    await applied(h);
    const written = h.writes.filter(w => w.capability === 'light_temperature').at(-1);
    assert.ok(written, 'coming on provokes a forced pass');
    assert.notEqual(written.value, 0.05, 'and it asks for something other than what the lamp held');

    // Well past every settle window: this is the lamp's own answer, minutes
    // later, and it is the value it never left.
    h.advance(60_000);
    h.report('l1', 'light_temperature', 0.05);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false, 'a lamp that ignored us is not a person');
    assert.equal(d.targets[0].override, null);
    assert.ok(
      d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'write_ignored'),
      'and the report is recorded under its own reason rather than swallowed',
    );
    await h.runtime.stop();
  });

  test('a lamp that keeps talking cannot postpone its own override expiry', async () => {
    const h = harness({ now: MORNING });
    await h.runtime.start();
    await settle();

    // A genuine override: somewhere the lamp has never been.
    h.advance(10_000);
    h.report('l1', 'light_temperature', 0.05);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true);

    // Three hours later it says something new. Re-stamping here is what kept
    // four lamps stood down indefinitely in the capture.
    h.advance(3 * 60 * 60_000);
    h.report('l1', 'light_temperature', 0.07);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true, 'still inside the four hours');

    // Four hours and a minute after the FIRST report, though only one hour and
    // a minute after the most recent one.
    h.advance(60 * 60_000 + 60_000);
    await h.runtime.tick();
    await applied(h);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false, 'the deadline runs from the first report');
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'expired'));
    await h.runtime.stop();
  });
});

/**
 * What the Garage capture found: a lamp can take an hour and a half to arrive.
 *
 * Four lamps acked `light_temperature` 0.82, reported 0.57, and then crawled
 * +0.01 every four minutes towards it. The first three steps sat within
 * `OVERRIDE_TOLERANCE` of 0.57 and were forgiven as an ignored write; the
 * fourth cleared the tolerance and was booked as a person, standing all four
 * devices down for the ninety minutes it took the lamps to finish obeying.
 *
 * The rule that came out of it is in `approachingWrite`: a report strictly
 * closer to what we wrote than anything since we wrote it is our write landing
 * late, whatever the distance still left to run.
 */
describe('what the slow-fade capture found', () => {
  /** As a bridge reports it: `light_temperature` declares `decimals: 2`. */
  const asReported = (value: number) => Math.round(value * 100) / 100;

  test('a lamp fading towards what we wrote is not a person', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', undefined, { light_temperature: 0.05 })],
    });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;
    assert.ok(written - 0.05 > 0.1, 'the plan asks for somewhere the lamp is nowhere near');

    // Four steps of the fade, a minute apart: every one of them well outside
    // every settle window, well outside the tolerance around where the lamp
    // started, and still a long way from what we asked for.
    for (const step of [1, 2, 3, 4]) {
      h.advance(60_000);
      h.report('l1', 'light_temperature', asReported(0.05 + (written - 0.05) * step / 5));
    }

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false, 'a lamp on its way is not a person');
    assert.equal(d.targets[0].override, null);
    assert.ok(
      d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'write_approaching'),
      'and each report is recorded under its own reason rather than swallowed',
    );
    assert.equal(
      d.targets[0].approachingWrites?.light_temperature, 1,
      'one write, one count, however many reports it took to arrive',
    );
    await h.runtime.stop();
  });

  test('a lamp that turns back is a person again', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', undefined, { light_temperature: 0.05 })],
    });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;

    // A fifth of the way per report, and far enough that turning back below is
    // a real move rather than a bridge rounding around where the lamp started —
    // one step has to clear `OVERRIDE_TOLERANCE` or the turn-back reads as a
    // lamp that never left, which is `ineffectiveWrite`'s case and not this one.
    assert.ok((written - 0.05) / 5 > 0.03, `one step clears the tolerance (${written})`);
    for (const step of [1, 2, 3]) {
      h.advance(60_000);
      h.report('l1', 'light_temperature', asReported(0.05 + (written - 0.05) * step / 5));
    }
    assert.equal(h.runtime.diagnostics().targets[0].overridden, false, 'still on its way');

    // Somebody takes the lamp the other way. Nothing about this report is our
    // write arriving: it is further from what we asked for than the lamp has
    // already been.
    h.advance(60_000);
    h.report('l1', 'light_temperature', asReported(0.05 + (written - 0.05) / 5));

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, true, 'moving away from our write is a person');
    assert.equal(d.targets[0].override?.capability, 'light_temperature');
    await h.runtime.stop();
  });

  test('a lamp that arrives somewhere else in one move is a person again', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', undefined, { light_temperature: 0.05 })],
    });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;

    // Between where the lamp was and where we sent it, and closer to us than it
    // started — but most of the way there in a single report, which is not a
    // fade. Somebody set this lamp to roughly half of what we asked for.
    h.advance(60_000);
    h.report('l1', 'light_temperature', asReported(0.05 + (written - 0.05) * 0.5));

    assert.equal(
      h.runtime.diagnostics().targets[0].overridden, true,
      'a jump that happens to land on the way is still a jump',
    );
    await h.runtime.stop();
  });

  test('a lamp that sails past what we wrote is a person again', async () => {
    const h = harness({
      now: MORNING,
      devices: [light('l1', undefined, { light_temperature: 0.05 })],
    });
    await h.runtime.start();
    await settle();
    const written = temperatures(h.writes)[0].value as number;

    for (const step of [1, 2]) {
      h.advance(60_000);
      h.report('l1', 'light_temperature', asReported(0.05 + (written - 0.05) * step / 5));
    }
    // Past the value we asked for, by more than a bridge rounds: the fade is
    // over and this is something else moving the lamp.
    h.advance(60_000);
    h.report('l1', 'light_temperature', asReported(Math.min(1, written + 0.1)));

    assert.equal(h.runtime.diagnostics().targets[0].overridden, true, 'an overshoot is not our write');
    await h.runtime.stop();
  });
});

/**
 * `writesLights: false` — the device that only PUBLISHES (lib/runtime/writes-lights.ts).
 *
 * Found on the reference Homey: a remote's "On – with Lightkeeper" button pointed
 * at a Colour Curve Light and a Room-sensing Light that ALSO drove the same five
 * bulbs, so every switch-on was three devices writing to one lamp. The flag is
 * what lets a curve be a source without being a writer.
 */
describe('a device that only publishes', () => {
  const publishOnly = () => plan({ writesLights: false });

  test('writes nothing at start, on a tick, or when a light comes on', async () => {
    const h = harness({
      plan: publishOnly(),
      devices: [light('l1', undefined, { onoff: false }), light('l2')],
    });
    await h.runtime.start();
    await applied(h);
    h.advance(3 * 60 * 60_000);
    await h.runtime.tick();
    await applied(h);
    h.report('l1', 'onoff', true);
    await applied(h);

    assert.deepEqual(h.writes, []);
    assert.equal(h.runtime.diagnostics().lastAction?.detail, 'this device only publishes its values');
  });

  test('still publishes what it wants the lights to be', async () => {
    const h = harness({ plan: publishOnly() });
    await h.runtime.start();

    const warmth = h.runtime.publishedValues()['lightkeeper_temperature'];
    assert.equal(typeof warmth, 'number', 'the remote reads this, so it must be there');
  });

  test('watches no lamp, so a hand on one is never filed as an override', async () => {
    const h = harness({ plan: publishOnly() });
    await h.runtime.start();

    assert.equal(h.isSubscribed('l1', 'onoff'), false);
    assert.equal(h.isSubscribed('l1', 'light_temperature'), false);
    h.report('l1', 'light_temperature', 0.05);
    assert.equal(h.runtime.diagnostics().targets.some(t => t.overridden), false);
  });

  test('is ready even when none of its lights can change colour', async () => {
    // The same lamps are needs_repair for a device that drives them; one that
    // never writes to them has nothing to fail at.
    const h = harness({ plan: publishOnly(), devices: [light('l1', ['onoff']), light('l2', ['onoff'])] });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'ready');
  });

  test('"Try it" still writes, because a person asked to see it on the lamps', async () => {
    const h = harness({ plan: publishOnly() });
    await h.runtime.start();
    await h.runtime.applyNow('preview', { force: true, waitForResults: true, preview: true });
    await applied(h);

    assert.equal(temperatures(h.writes).length, 2);
  });

  test('refuses the pre-stage probe instead of writing to an off lamp', async () => {
    const h = harness({
      plan: plan({ writesLights: false, preStage: true }),
      devices: [light('l1', undefined, { onoff: false })],
    });
    await h.runtime.start();
    const outcome = await h.runtime.probePreStage(0);

    assert.equal(outcome.deviceId, null);
    assert.deepEqual(h.writes, []);
  });

  test('says so in diagnostics, and an absent key still means it writes', async () => {
    const off = harness({ plan: publishOnly() });
    const on = harness();
    await off.runtime.start();
    await on.runtime.start();

    assert.equal(off.runtime.diagnostics().writesLights, false);
    assert.equal(on.runtime.diagnostics().writesLights, true);
  });

  test('switched back on, it subscribes and corrects the room at once', async () => {
    const h = harness({ plan: publishOnly() });
    await h.runtime.start();
    await h.runtime.updatePlan(plan());
    await applied(h);

    assert.equal(h.isSubscribed('l1', 'onoff'), true);
    assert.equal(temperatures(h.writes).length, 2);
  });
});
