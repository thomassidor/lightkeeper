import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DaylightRuntime } from '../../lib/daylight/daylight-runtime';
import { DEFAULT_RESPONSE, type DaylightPlan, type DaylightResponse } from '../../lib/daylight/daylight-types';
import type { DaylightEvaluator, DaylightVerdict } from '../../lib/daylight/daylight-evaluator';
import type { LuminanceSource } from '../../lib/daylight/luminance-source';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { toDevice, toPerceptual } from '../../lib/outputs/light-intent';
import { settle as sharedSettle } from '../support/deferred';
import { zoneLights } from '../support/fake-catalog';

/**
 * What a Daylight runtime is responsible for is everything the response is not:
 * whose lamp it is safe to write to, when a write is worth making at all, and
 * how fast it is allowed to move.
 *
 * The two dampers are the reason this file exists. A light sensor in the room
 * whose lamps this drives reads those lamps too, so it is a closed loop, and an
 * undamped closed loop hunts - a room that visibly pulses once a minute for as
 * long as the app runs. The deadband is what makes it SETTLE (inside the band
 * there is no next write to provoke the next reading) and the slew limit is what
 * makes any residual movement gentle. Neither is provable on hardware in less
 * than ten minutes of watching a wall, so both are pinned here.
 *
 * Two promises are asserted rather than commented, because both are the kind
 * that regress silently:
 *
 *  - **ZERO writes to a lamp that is off.** A dim write turns an off lamp on -
 *    measured, not suspected - so this device type has no pre-stage option at
 *    all, and a regression here switches a household's lights on through the
 *    night one at a time.
 *  - **ZERO writes to a lamp that has left the plan.** It keeps its capability
 *    subscription otherwise, and the rising edge of onoff is THE feature.
 *
 * The harness mirrors the circadian one: `makeCapabilityInstance` KEEPS its
 * listener, so a test can fire a capability change the way Homey would.
 */

interface FakeDevice {
  id: string;
  name: string;
  zoneName: string;
  capabilities: string[];
  capabilitiesObj: Record<string, any>;
  available: boolean;
}

function light(id: string, capabilities = ['onoff', 'dim'], values: Record<string, any> = {}): FakeDevice {
  const capabilitiesObj: Record<string, any> = {};
  if (capabilities.includes('onoff')) capabilitiesObj.onoff = { value: values.onoff ?? true };
  if (capabilities.includes('dim')) {
    capabilitiesObj.dim = { min: 0, max: 1, decimals: 2, value: values.dim ?? 0.5 };
  }
  return { id, name: id, zoneName: 'Kitchen', capabilities, capabilitiesObj, available: true };
}

/**
 * What a perceptual brightness actually lands on the lamp as.
 *
 * Through gamma AND through the capability's own `decimals`, because planIntent
 * quantises: expecting a bare toDevice() value here would be asserting against
 * a number the lamp never sees, and would hide a change to either conversion.
 */
/** Comfortably past the runtime's 3 s settle window. */
const SETTLE_PAST = 10_000;

function dimFor(perceptual: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(toDevice(perceptual) * factor) / factor;
}

function plan(response: Partial<DaylightResponse> = {}, enabled = true): DaylightPlan {
  return {
    schemaVersion: 1,
    enabled,
    target: { kind: 'zone', zoneId: 'z1', includeSubzones: false },
    response: { ...DEFAULT_RESPONSE, ...response },
  };
}

function harness(options: {
  plan?: DaylightPlan;
  devices?: FakeDevice[];
  /** What the evaluator reports. Mutable, because a cloud passing is the point. */
  verdict?: Partial<DaylightVerdict>;
  reading?: { lux: number; deviceIds: string[] } | null;
  /** When the watched sensor last reported. Defaults to the moving `now`. */
  sensorAt?: () => number | null;
} = {}) {
  /**
   * Which lamps refuse every write, settable after start.
   *
   * A lamp cut at the wall is the case this exists for: on a real Homey it
   * stays `available: true` (platform §6) and only the write failures say
   * anything is wrong. Settable rather than a constructor option because the
   * finding is about a lamp that goes wrong AFTER a healthy start.
   */
  const refusing = new Set<string>();
  const devices = options.devices ?? [light('l1'), light('l2')];
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  const states: Array<{ state: string; detail?: unknown }> = [];
  const logs: string[] = [];
  /** deviceId:capability -> the listener Homey would call. */
  const listeners = new Map<string, (value: unknown) => void>();
  let now = Date.UTC(2026, 5, 21, 10, 0);

  let verdict: DaylightVerdict = {
    level: 0.5, brightness: 0.5, source: 'sensors', elevation: 40,
    ...options.verdict,
  };

  const retained: Array<{ ids: string[]; owner: string }> = [];
  const released: string[] = [];
  const luminance = {
    async retain(ids: string[], owner: string) { retained.push({ ids, owner }); },
    async release(owner: string) { released.push(owner); },
    read: () => options.reading ?? null,
    watched: () => [{ deviceId: 's1', name: 'Hall', lux: 42, at: now, available: true }],
  } as unknown as LuminanceSource;

  const daylight = {
    evaluate: () => verdict,
    sky: () => ({ elevation: verdict.elevation, level: verdict.level, location: null }),
    // `at` defaults to "just now", so a sensor is fresh unless a test freezes
    // it. Its own hook because `now` moves and the reading's timestamp must be
    // able not to — a frozen sensor is the one thing a live clock cannot fake.
    sensors: () => [{
      deviceId: 's1', name: 'Hall', lux: 42, available: true,
      at: options.sensorAt === undefined ? now : options.sensorAt(),
    }],
  } as unknown as DaylightEvaluator;

  const deviceHandle = (id: string) => {
    const device = devices.find(d => d.id === id)!;
    return {
      ...device,
      async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
        if (refusing.has(id)) throw new Error(`${id} did not respond`);
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
    async read() {
      return { devices: { getDevice: async ({ id }: { id: string }) => deviceHandle(id) } };
    },
    track: (unsubscribe: unknown) => unsubscribe,
  } as unknown as HomeyApiService;

  let inCatalogue = [...devices];
  const catalog = {
    async device(id: string) { return inCatalogue.find(d => d.id === id); },
    async devicesInZone() { return inCatalogue; },
    lightsInZone: zoneLights(async () => inCatalogue),
  } as unknown as DeviceCatalog;

  const runtime = new DaylightRuntime('dayl-1', options.plan ?? plan(), {
    api,
    catalog,
    daylight,
    luminance,
    displayName: () => 'Kitchen daylight',
    now: () => now,
    log: (...args) => logs.push(args.map(String).join(' ')),
    onStateChange: (state, detail) => states.push({ state, detail }),
  });

  return {
    runtime, writes, states, logs, retained, released, devices,
    setVerdict(next: Partial<DaylightVerdict>) { verdict = { ...verdict, ...next }; },
    /** A lamp switched off at the wall: still `available`, accepts nothing. */
    refuseWrites(id: string) { refusing.add(id); },
    acceptWrites(id: string) { refusing.delete(id); },
    advance(ms: number) { now += ms; },
    /** Fire a capability change the way Homey's own event dispatch would. */
    report(id: string, capability: string, value: unknown) {
      listeners.get(`${id}:${capability}`)?.(value);
    },
    subscribed(id: string, capability: string) { return listeners.has(`${id}:${capability}`); },
    removeFromCatalogue(id: string) { inCatalogue = inCatalogue.filter(d => d.id !== id); },
    /** A lamp added to the zone after the runtime started. */
    addToCatalogue(device: FakeDevice) {
      devices.push(device);
      inCatalogue = [...inCatalogue, device];
    },
    dimWrites() { return writes.filter(w => w.capability === 'dim'); },
    async settle(times = 3) { await sharedSettle(times); },
  };
}

/**
 * One tick, fully flushed.
 *
 * `lastSent` is recorded BEHIND the batch's completion promise - deliberately,
 * because recording a write that was coalesced away or failed tells both gates
 * the lamp is already where it needs to be and stops it ever moving again. On a
 * Homey the next tick is sixty seconds later so that always has resolved; in a
 * test it has to be waited for, or every tick reads as the first one.
 */
async function tick(h: ReturnType<typeof harness>): Promise<void> {
  await h.runtime.tick();
  await h.runtime.drain();
  await h.settle();
}

/**
 * Tick until nothing is moving any more, and report how many ticks that took.
 *
 * The single most important property of this device type: the loop TERMINATES.
 * A run that never goes quiet is a room that pulses once a minute for as long as
 * the app runs, which is exactly what an undamped closed loop does.
 *
 * "Nothing moving" is deliberately BOTH the write count and every lamp's aim,
 * not just the writes. On a lamp whose `dim` resolution swallows a slew step the
 * aim climbs across a plateau with no writes at all, so a quiet tick is not on
 * its own evidence that anything has settled - and a converge() that stopped
 * there would report success in the middle of a fade.
 */
async function converge(h: ReturnType<typeof harness>, limit = 60): Promise<number> {
  const aims = () => h.runtime.diagnostics().targets.map(t => t.aim).join(',');
  for (let ticks = 1; ticks <= limit; ticks += 1) {
    const writesBefore = h.dimWrites().length;
    const aimsBefore = aims();
    await tick(h);
    if (h.dimWrites().length === writesBefore && aims() === aimsBefore) return ticks;
  }
  assert.fail(`still moving after ${limit} ticks: this device type hunts`);
}

describe('DaylightRuntime - a lamp that is off is never written to', () => {
  test('an off lamp gets ZERO writes, and there is no option to change that', async () => {
    // A dim write turns an off lamp on. Measured on Hue, not suspected - which
    // is why brightness is never pre-staged anywhere in this app, and why this
    // device type has no pre-stage setting to get wrong.
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { onoff: false })] });
    await h.runtime.start();
    await h.runtime.drain();

    assert.deepEqual(h.dimWrites(), []);
    assert.equal(h.runtime.diagnostics().lastAction?.skipped, 1);
  });

  test('a lit lamp beside an off one is written to, and only it', async () => {
    const h = harness({
      devices: [light('l1'), light('l2', ['onoff', 'dim'], { onoff: false })],
    });
    await h.runtime.start();
    await h.runtime.drain();

    assert.deepEqual(h.dimWrites().map(w => w.deviceId), ['l1']);
  });

  test('no onoff write is ever planned, in either direction', async () => {
    // The promise the two curve-driven types make and this one inherits: it
    // adjusts lights that are already on and never switches one on or off.
    const h = harness();
    await h.runtime.start();
    h.setVerdict({ brightness: 0.95 });
    await h.runtime.tick();
    h.setVerdict({ brightness: 0.1 });
    await h.runtime.tick();
    await h.runtime.drain();

    assert.deepEqual(h.writes.filter(w => w.capability === 'onoff'), []);
  });

  test('every planned write is on the dim axis and nothing else', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.drain();

    assert.deepEqual([...new Set(h.writes.map(w => w.capability))], ['dim']);
  });
});

describe('DaylightRuntime - the rising edge of onoff is the feature', () => {
  test('switching a lamp on writes its level at once, forced past both gates', async () => {
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { onoff: false })] });
    await h.runtime.start();
    await h.runtime.drain();
    assert.deepEqual(h.dimWrites(), []);

    // The lamp comes on - the wall switch, the vendor app, another Flow.
    h.devices[0].capabilitiesObj.onoff.value = true;
    h.report('l1', 'onoff', true);
    await h.settle();
    await h.runtime.drain();

    assert.equal(h.dimWrites().length, 1);
    assert.equal(h.dimWrites()[0].value, dimFor(0.5));
  });

  test('and the write is NOT slewed, because that would look like a fault', async () => {
    // The lamp has just restored whatever level it was last at, so what we sent
    // it an hour ago says nothing about where it is now. Easing up to the right
    // level over ninety seconds after somebody flicked a switch reads as broken.
    const h = harness({
      devices: [light('l1', ['onoff', 'dim'], { onoff: false, dim: toDevice(0.1) })],
      verdict: { brightness: 0.95 },
    });
    await h.runtime.start();
    h.devices[0].capabilitiesObj.onoff.value = true;
    h.report('l1', 'onoff', true);
    await h.settle();
    await h.runtime.drain();

    assert.equal(h.dimWrites().at(-1)!.value, dimFor(0.95));
  });

  test('switching a lamp off forgets what was sent, so the next on is fresh', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.drain();
    assert.notEqual(h.runtime.diagnostics().targets[0].aim, null);

    h.report('l1', 'onoff', false);
    assert.equal(h.runtime.diagnostics().targets[0].aim, null);
  });
});


describe('DaylightRuntime - the loop terminates, which is the whole point', () => {
  test('a steady reading is reached and then left alone, for ever', async () => {
    // The single most important property here. An undamped closed loop - a
    // sensor reading the lamps it drives - pulses once a minute for as long as
    // the app runs, and this is what says it does not.
    const h = harness();
    await h.runtime.start();
    await h.runtime.drain();
    await h.settle();

    const ticksToSettle = await converge(h);
    assert.ok(ticksToSettle < 20, `took ${ticksToSettle} ticks to settle`);

    // And it STAYS settled: ten more ticks, nothing written.
    const settled = h.dimWrites().length;
    for (let i = 0; i < 10; i += 1) await tick(h);
    assert.equal(h.dimWrites().length, settled);
  });

  test('a sensor wobbling under the deadband moves nothing once settled', async () => {
    // A measure_luminance sensor reports to two decimals and sits in the room
    // whose lamps this drives, so its reading twitches constantly. Without a
    // deadband every twitch is a write, and every write changes the reading.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    for (const brightness of [0.505, 0.495, 0.51, 0.49, 0.5, 0.512, 0.489, 0.5]) {
      h.setVerdict({ brightness });
      await tick(h);
    }
    assert.equal(h.dimWrites().length, settled, 'wobble inside the band moved the lamp');
  });

  test('a real change past the deadband is followed, and then settles again', async () => {
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    // A cloud passes: well outside the band.
    h.setVerdict({ brightness: 0.85 });
    const ticks = await converge(h);

    assert.ok(h.dimWrites().length > settled, 'a visible change was not followed');
    assert.ok(ticks > 1, 'it arrived in one step, so the slew limit is not applied');
  });

  test('a slow drift of sub-deadband steps is still followed', async () => {
    // The band is measured against what was WRITTEN, not against the previous
    // request. Measured against the request, every step of a slow dusk would be
    // refused on its own and the lamps would never follow it at all.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    for (let i = 1; i <= 8; i += 1) {
      h.setVerdict({ brightness: 0.5 + i * 0.008 });
      await tick(h);
    }
    assert.ok(h.dimWrites().length > settled, 'the accumulated drift was never written');
  });
});

describe('DaylightRuntime - the slew limit', () => {
  test('a big change arrives as a fade rather than a jump', async () => {
    // Both jobs at once: any residual hunting is gentle instead of a room
    // flashing, and a genuine change reads as a fade.
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { dim: dimFor(0.1) })] });
    await h.runtime.start();
    await converge(h);
    const settledAt = toPerceptual(h.dimWrites().at(-1)!.value as number);

    h.setVerdict({ brightness: 0.9 });
    await tick(h);
    const afterOneTick = toPerceptual(h.dimWrites().at(-1)!.value as number);

    // One tick must not have arrived anywhere near the target. Measured from
    // where it had settled, not from where the lamp started: converge() has
    // already brought it to the previous target.
    assert.ok(
      afterOneTick - settledAt < 0.07,
      `one tick moved from ${settledAt} to ${afterOneTick}`,
    );
    assert.ok(afterOneTick < 0.8, `one tick jumped to ${afterOneTick}`);
  });

  test('every step is within the limit, on the perceptual axis', async () => {
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { dim: dimFor(0.1) })] });
    await h.runtime.start();
    await converge(h);
    const from = h.dimWrites().length;

    h.setVerdict({ brightness: 0.95 });
    await converge(h);

    const levels = h.dimWrites().slice(from).map(w => toPerceptual(w.value as number));
    for (let i = 1; i < levels.length; i += 1) {
      const step = Math.abs(levels[i] - levels[i - 1]);
      // A little headroom for the round trip through gamma and `decimals`: the
      // limit is applied to the value we aim at, and what comes back is that
      // value quantised.
      assert.ok(step <= 0.06, `step ${i} was ${step}`);
    }
  });

  test('the slew moves in the right direction, downwards too', async () => {
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { dim: dimFor(0.9) })] });
    await h.runtime.start();
    h.setVerdict({ brightness: 0.15 });
    await converge(h);

    const levels = h.dimWrites().map(w => toPerceptual(w.value as number));
    for (let i = 1; i < levels.length; i += 1) {
      assert.ok(levels[i] <= levels[i - 1] + 1e-9, `step ${i} went the wrong way`);
    }
    assert.ok(levels.at(-1)! < 0.2, `ended at ${levels.at(-1)}`);
  });

  test('it converges on the target rather than stalling short of it', async () => {
    // The failure the slew's ORIGIN was got wrong for first. Slewing from the
    // lamp's reported dim looks more honest, but that value is quantised by the
    // capability's own decimals through gamma - so at the bottom of the axis a
    // whole step can round away, the lamp never moves, and the next tick
    // computes the same step from the same place. A creep that stalls.
    const h = harness({ devices: [light('l1', ['onoff', 'dim'], { dim: dimFor(0.1) })] });
    await h.runtime.start();
    h.setVerdict({ brightness: 0.42 });
    await converge(h);

    const landed = toPerceptual(h.dimWrites().at(-1)!.value as number);
    assert.ok(Math.abs(landed - 0.42) < 0.03, `stalled at ${landed} instead of reaching 0.42`);
  });

  test('a lamp reporting a null level is not darkened on the first tick', async () => {
    // The trap CLAUDE.md records for lux, one axis over: `Number(null)` is 0,
    // and 0 is pitch dark. `liveValuesOf()` used to cast a snapshot's `dim`
    // straight to `number | undefined`, so a `null` — an integration that has
    // not reported yet, or one whose sensor battery went flat — arrived typed
    // as a reading. `aimFor` tests `=== undefined` to mean "the lamp never told
    // us", `null` is not undefined, so the aim seeded from a perceptual ZERO
    // and the first tick wrote `dim 0.01` to a lamp that was already lit before
    // fading it back up at 0.05 a tick.
    const unreported = light('l1', ['onoff', 'dim']);
    unreported.capabilitiesObj.dim.value = null;
    const h = harness({ devices: [unreported], verdict: { brightness: 0.6 } });

    await h.runtime.start();
    await tick(h);

    const first = h.dimWrites()[0];
    assert.ok(first !== undefined, 'the lamp was never written to at all');
    // Unknown means unknown: with nothing to slew FROM, the aim is the target,
    // which is what `aimFor` already does for a genuinely absent level.
    assert.ok(
      Math.abs(toPerceptual(first.value as number) - 0.6) < 0.02,
      `first write was ${first.value} (perceptual ${toPerceptual(first.value as number)}), not the target`,
    );
    // The failure this pins: nothing near the floor, ever.
    for (const write of h.dimWrites()) {
      assert.ok((write.value as number) > 0.02, `wrote ${write.value} to a lit lamp`);
    }
  });

  test('and it converges from the bottom of the axis, where quantisation bites', async () => {
    // decimals: 1 is the cruel case - dim moves in tenths, so a 0.05 perceptual
    // step near the floor is invisible to the lamp entirely.
    const coarse = light('l1', ['onoff', 'dim'], { dim: 0.1 });
    coarse.capabilitiesObj.dim.decimals = 1;
    const h = harness({ devices: [coarse] });
    await h.runtime.start();
    h.setVerdict({ brightness: 0.95 });
    await converge(h);

    const landed = h.dimWrites().at(-1)!.value as number;
    assert.ok(landed >= 0.8, `stalled at ${landed} on a lamp with one decimal`);
  });
});

describe('DaylightRuntime - somebody changed a lamp by hand', () => {
  test('a manual dim stands the device down for that lamp only', async () => {
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    // Outside the settle window, and well past the tolerance.
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.95);

    h.setVerdict({ brightness: 0.9 });
    await converge(h);

    assert.deepEqual(
      h.dimWrites().slice(settled).map(w => w.deviceId).filter(id => id === 'l1'),
      [],
      'wrote to a lamp somebody had taken over',
    );
    assert.ok(h.dimWrites().length > settled, 'the other lamp still followed');
    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, true);
  });

  test('our own echo is not read as somebody reaching for a dimmer', async () => {
    // Within the settle window after our own write. Without this the app stands
    // itself down on the strength of its own write arriving back.
    const h = harness();
    await h.runtime.start();
    await converge(h);

    const ours = h.dimWrites().at(-1)!.value;
    h.report('l1', 'dim', ours);

    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, false);
  });

  test('a bridge rounding our value is not an override either', async () => {
    const h = harness();
    await h.runtime.start();
    await converge(h);
    h.advance(SETTLE_PAST);

    const ours = h.dimWrites().at(-1)!.value as number;
    h.report('l1', 'dim', ours + 0.02);

    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, false);
  });

  test('switching it off and on again hands the lamp back', async () => {
    // The gesture people already have for "put this back how it ought to be",
    // and the only way out of an override.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.95);
    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, true);

    h.report('l1', 'onoff', false);
    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, false);

    h.report('l1', 'onoff', true);
    await h.settle();
    await h.runtime.drain();
    assert.ok(h.dimWrites().some(w => w.deviceId === 'l1'));
  });

  test('an override is never persisted, so a restart is a clean slate', async () => {
    // The right bias for a feature whose whole job is to be correct by default.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.95);

    await h.runtime.stop();
    await h.runtime.start();

    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l1')!.overridden, false);
  });

  test('an echo of our own write is ignored whatever the timing', async () => {
    // The cache's `external` verdict is the first gate, and it is what makes one
    // write produce one response rather than two (echoes arrive duplicated).
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    // Fired twice, the way a duplicated echo arrives.
    const ours = h.dimWrites().at(-1)!.value;
    h.report('l1', 'dim', ours);
    h.report('l1', 'dim', ours);
    await tick(h);

    assert.equal(h.dimWrites().length, settled);
  });
});

describe('DaylightRuntime - health', () => {
  test('a paused device reports disabled and writes nothing', async () => {
    const h = harness({ plan: plan({}, false) });
    await h.runtime.start();
    await h.runtime.drain();

    assert.equal(h.runtime.currentState, 'disabled');
    assert.deepEqual(h.dimWrites(), []);
    assert.equal(h.runtime.diagnostics().lastAction?.detail, 'the plan is switched off');
  });

  test('lamps that cannot dim are needs_repair, because it can do nothing at all', async () => {
    const h = harness({ devices: [light('l1', ['onoff']), light('l2', ['onoff'])] });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.equal(h.runtime.currentDetail?.key, 'state.noDimTargets');
  });

  test('one dimmable lamp among two is READY, not partial', async () => {
    // Worth pinning, because the obvious guess is wrong. `partial` in this app
    // is about lights that are unavailable or refusing to be driven, never
    // about capabilities they do not have - a group where one of two lamps dims
    // does exactly what was asked of it for that lamp. The circadian runtime
    // draws the same line, and only reports needs_repair when NONE are drivable.
    const h = harness({ devices: [light('l1'), light('l2', ['onoff'])] });
    await h.runtime.start();
    await h.runtime.drain();

    assert.equal(h.runtime.currentState, 'ready');
    assert.deepEqual(h.dimWrites().map(w => w.deviceId), ['l1']);
  });

  test('an unavailable lamp among two IS partial', async () => {
    const gone = light('l2');
    gone.available = false;
    const h = harness({ devices: [light('l1'), gone] });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'partial');
  });

  test('no sensor and no location is needs_repair, and names which', async () => {
    const h = harness({ verdict: { source: 'none', elevation: null } });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.equal(h.runtime.currentDetail?.key, 'state.noDaylightSource');
  });

  test('and it writes nothing rather than guessing a brightness', async () => {
    // The device type whose plan IS a response has no fixed value to fall back
    // to, so the honest act is to leave the lamps exactly as they are.
    const h = harness({ verdict: { source: 'none', elevation: null } });
    await h.runtime.start();
    await h.runtime.drain();

    assert.deepEqual(h.dimWrites(), []);
    assert.match(String(h.runtime.diagnostics().lastAction?.detail), /no sun position and no usable sensor/);
  });

  test('gone lamps are reported ahead of a missing daylight source', async () => {
    // Both wrong at once: "your lamps are gone" is the one a person can act on.
    const h = harness({ devices: [], verdict: { source: 'none', elevation: null } });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.equal(h.runtime.currentDetail?.key, 'state.noTargets');
  });

  test('a working device with a working sky is ready', async () => {
    const h = harness({ verdict: { source: 'sky', elevation: 30 } });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'ready');
  });

  test('there is no credential leg at all, because it writes no Flows', async () => {
    // Asserted rather than commented: a needs_credential verdict on a device
    // type with no API key would be unresolvable from the user's side.
    const h = harness();
    await h.runtime.start();
    h.setVerdict({ source: 'none' });
    await h.runtime.assessHealth();

    assert.deepEqual(
      h.states.map(s => s.state).filter(state => state === 'needs_credential'),
      [],
    );
  });
});

/**
 * A lamp that has stopped accepting writes reaches the TILE.
 *
 * `light-target-adapter.ts` says the failure streak exists so that a runtime
 * does not "go on writing to that lamp every minute for ever behind a green
 * tile" — and it did exactly that, because `assessHealth()` ran at start and
 * on a target-set change and nowhere else. A lamp cut at the wall stays
 * `available: true` (platform §6), so the target fingerprint never moves,
 * `refreshTargets()` returns early, and `unwritableTargets()` was consulted
 * once: at start, when it was empty.
 */
describe('DaylightRuntime - a lamp that stops responding', () => {
  test('a write-failure streak moves the state off ready', async () => {
    const h = harness();
    await h.runtime.start();
    assert.equal(h.runtime.currentState, 'ready');

    // Cut at the wall. Nothing about the catalogue changes; only writes fail.
    h.refuseWrites('l1');

    // Three failures and five minutes are what the adapter calls unwritable.
    for (let i = 0; i < 4; i += 1) {
      h.setVerdict({ brightness: 0.2 + i * 0.15 });
      h.advance(2 * 60_000);
      await tick(h);
    }

    assert.notEqual(
      h.runtime.currentState, 'ready',
      'the lamp took four failed writes and the tile stayed green',
    );
    assert.equal(h.runtime.currentState, 'partial', 'one of two lamps is gone');
  });

  test('and it goes back to ready when the lamp comes back', async () => {
    const h = harness();
    await h.runtime.start();
    h.refuseWrites('l1');
    for (let i = 0; i < 4; i += 1) {
      h.setVerdict({ brightness: 0.2 + i * 0.15 });
      h.advance(2 * 60_000);
      await tick(h);
    }
    assert.equal(h.runtime.currentState, 'partial');

    h.acceptWrites('l1');
    h.setVerdict({ brightness: 0.5 });
    h.advance(2 * 60_000);
    await tick(h);

    // Still partial, and correctly so: a write's outcome is recorded BEHIND
    // the batch's completion promise (see `noteOutcomes`), which resolves
    // after `tick()` has already re-assessed. So the streak clears a moment
    // after the verdict is computed and the recovery shows on the NEXT pass.
    // A minute's lag on good news, and the alternative — holding every tick
    // open until its writes come back — is what `waitForResults` exists to
    // keep out of the tick path.
    assert.equal(h.runtime.currentState, 'partial');

    h.setVerdict({ brightness: 0.55 });
    h.advance(2 * 60_000);
    await tick(h);

    assert.equal(h.runtime.currentState, 'ready', 'a recovered lamp must clear the verdict');
  });

  test('the "no daylight source" verdict clears by itself when a source appears', async () => {
    // The other half of this device type's own verdict, and the one nothing
    // else would ever re-ask. A Homey that was never told where it is, or a
    // sensor with a flat battery, is `source: 'none'` — and the fix happens
    // OUTSIDE the app: the household sets the location, or changes a battery.
    // No target changes when they do, so before this the device sat in repair
    // until the app was restarted.
    const h = harness({ verdict: { source: 'none' } });
    await h.runtime.start();
    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.deepEqual(h.runtime.currentDetail?.key, 'state.noDaylightSource');

    h.setVerdict({ source: 'sky' });
    h.advance(60_000);
    await tick(h);

    assert.equal(h.runtime.currentState, 'ready');
  });

  test('a healthy runtime does not re-assess on every tick', async () => {
    // The guard, and why it is there: `assessHealth()` awaits
    // `retrySubscriptions()`, so an unconditional re-assess would retry every
    // subscription once a minute for as long as the app runs.
    const h = harness();
    await h.runtime.start();
    const at = h.runtime.diagnostics().stateRevision;

    for (let i = 0; i < 3; i += 1) {
      h.advance(60_000);
      await tick(h);
    }

    assert.equal(h.runtime.diagnostics().stateRevision, at, 'the state churned on a quiet room');
  });
});

describe('DaylightRuntime - targets coming and going', () => {
  test('a light that leaves the plan gets ZERO writes when switched on', async () => {
    // The acceptance bar. It keeps its capability subscription otherwise, and
    // the rising edge of onoff is THE feature - so the runtime dutifully dims a
    // lamp that is no longer any of its business.
    const h = harness();
    await h.runtime.start();
    await converge(h);

    h.removeFromCatalogue('l2');
    await h.runtime.refreshTargets();
    const settled = h.dimWrites().length;

    assert.equal(h.subscribed('l2', 'onoff'), false, 'still subscribed after leaving the plan');
    h.report('l2', 'onoff', true);
    await h.settle();
    await h.runtime.drain();

    assert.deepEqual(h.dimWrites().slice(settled).filter(w => w.deviceId === 'l2'), []);
  });

  test('a light that leaves also loses its aim and its override', async () => {
    // Or a light that leaves and later rejoins is gated against what we sent it
    // while it was ours.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    h.advance(SETTLE_PAST);
    h.report('l2', 'dim', 0.95);
    assert.equal(h.runtime.diagnostics().targets.find(t => t.id === 'l2')!.overridden, true);

    h.removeFromCatalogue('l2');
    await h.runtime.refreshTargets();

    assert.deepEqual(h.runtime.diagnostics().targetIds, ['l1']);
  });

  test('an unchanged target set is not re-resolved', async () => {
    // The fingerprint, not the id list: cheap, and it keeps a catalogue event
    // for an unrelated device from re-subscribing every lamp.
    const h = harness();
    await h.runtime.start();
    await converge(h);
    const settled = h.dimWrites().length;

    await h.runtime.refreshTargets();

    assert.equal(h.dimWrites().length, settled);
  });

  test('a new light joining the plan is picked up and driven', async () => {
    const h = harness({ devices: [light('l1')] });
    await h.runtime.start();
    await converge(h);

    h.addToCatalogue(light('l3'));
    await h.runtime.refreshTargets();
    await h.runtime.drain();

    assert.deepEqual(h.runtime.diagnostics().targetIds, ['l1', 'l3']);
  });
});

describe('DaylightRuntime - the shared sensor service', () => {
  test('starting retains exactly the plan sensors, under this device id', async () => {
    const h = harness({ plan: plan({ sensor: 's1' }) });
    await h.runtime.start();

    assert.deepEqual(h.retained, [{ ids: ['s1'], owner: 'dayl-1' }]);
  });

  test('stopping releases this device claim and no other', async () => {
    // Ref-counted: a sensor another Lightkeeper device also named keeps its
    // subscription.
    const h = harness({ plan: plan({ sensor: 's1' }) });
    await h.runtime.start();
    await h.runtime.stop();

    assert.deepEqual(h.released, ['dayl-1']);
  });

  test('a plan change re-retains, so a dropped sensor is released', async () => {
    // retain() is TOTAL for its owner, which is why a runtime can pass its whole
    // list and not work out the difference itself.
    const h = harness({ plan: plan({ sensor: 's1' }) });
    await h.runtime.start();
    await h.runtime.updatePlan(plan({ sensor: 's2' }));

    assert.deepEqual(h.retained.at(-1), { ids: ['s2'], owner: 'dayl-1' });
  });

  test('diagnostics report only THIS device sensors', async () => {
    // The service is shared, and a report listing another device's sensors is a
    // report that sends the reader to the wrong room.
    const h = harness({ plan: plan({ sensor: 's1' }) });
    await h.runtime.start();
    assert.deepEqual(h.runtime.diagnostics().sensors.map(s => s.deviceId), ['s1']);

    const other = harness({ plan: plan({ sensor: 's-elsewhere' }) });
    await other.runtime.start();
    assert.deepEqual(other.runtime.diagnostics().sensors, []);
  });
});


describe('diagnostics and power restoration regressions', () => {
  test('all six targets have decisions, including the unchanged lamp', async () => {
    const h = harness({ devices: Array.from({ length: 6 }, (_, i) => light('l' + i, undefined, { dim: 0.03 })), verdict: { brightness: 0.2 } });
    await h.runtime.start();
    await sharedSettle(12);
    h.advance(10_000);
    for (let i = 0; i < 5; i++) h.report('l' + i, 'dim', 0.8);
    await h.runtime.tick();
    const d = h.runtime.diagnostics();
    assert.equal(d.lastAction?.writes, 0);
    assert.equal(d.lastAction?.skipped, 5);
    assert.deepEqual(d.lastAction?.targets?.map(t => t.status), [
      'overridden', 'overridden', 'overridden', 'overridden', 'overridden', 'unchanged',
    ]);
    assert.equal(d.targets[0].override?.value, 0.8);
    assert.equal(d.targets[0].override?.expected, 0.03);
    assert.equal(d.targets[0].override?.capability, 'dim');
    assert.equal(d.recentControlEvents.filter(e => e.type === 'override').length, 5);
    await h.runtime.stop();
  });

  test('power-on restoration does not pause control before the first write lands', async () => {
    const h = harness({ devices: [light('l1', undefined, { onoff: false })] });
    await h.runtime.start();
    h.advance(10_000);
    h.report('l1', 'dim', 0.1);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, false);
    h.report('l1', 'onoff', true);
    h.report('l1', 'dim', 0.9);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, false);
    await sharedSettle(12);
    h.advance(10_000);
    h.report('l1', 'dim', 0.7);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true);
    h.report('l1', 'onoff', false);
    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].override, null);
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'power_changed'));
    await h.runtime.stop();
  });

  test('history links sensor input and command results to their original action', async () => {
    const h = harness({ plan: plan({ sensor: 's1', dark: 0.25, bright: 0.7 }) });
    await h.runtime.start();
    await sharedSettle(12);
    const first = h.runtime.diagnostics().recentActions[0];
    assert.ok(first.batchId);
    assert.ok(first.completedAt);
    assert.ok(first.outcomes?.every(o => o.status === 'succeeded'));
    assert.equal(first.sensors?.[0].lux, 42);
    h.advance(60_000);
    h.setVerdict({ brightness: 0.9 });
    await h.runtime.tick();
    await sharedSettle(12);
    const d = h.runtime.diagnostics();
    assert.equal(d.feedbackRisk, 'increasing_sensor_response');
    assert.equal(d.recentActions[1].brightness, 0.5);
    assert.equal(d.recentActions[0].brightness, 0.9);
    assert.notEqual(d.recentActions[0].batchId, first.batchId);
    assert.equal(d.sampledAt, d.lastAction?.at);
    await h.runtime.stop();
  });
});

/**
 * What a 3.83-day recording on the reference Homey found, and the three rules
 * that came out of it.
 *
 * The first two are the same mistake as the circadian runtime's, and for the
 * same reason — the override machinery reads a LAMP as a PERSON. The third is
 * different in kind: the closed loop this whole file is about was not merely
 * possible in that house, it ran, ninety-five times, and nothing said so
 * anywhere a person would look.
 */
describe('what the week-long recording found', () => {
  test('an override lapses, so a lamp that reverts our writes cannot mute the device for ever', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.03 })], verdict: { brightness: 0.2 } });
    await h.runtime.start();
    await sharedSettle(12);

    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.8);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true);

    h.advance(3 * 60 * 60_000);
    await tick(h);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true, 'three hours in, still stood down');

    h.advance(2 * 60 * 60_000);
    const before = h.dimWrites().length;
    await tick(h);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false);
    assert.equal(d.targets[0].override, null);
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'expired'));
    assert.ok(h.dimWrites().length > before, 'control resumes on the very same pass');
    await h.runtime.stop();
  });

  test('a reported dim of 0 is a lamp going off, whatever onoff has said so far', async () => {
    const h = harness({ devices: [light('l1')] });
    await h.runtime.start();
    await sharedSettle(12);

    /**
     * The ordering that defeated the `lamp_off` guard: on the reference Homey
     * this integration reports `dim 0` a median of 29.9 s BEFORE the matching
     * `onoff: false` (232 pairs, min 29.2 s), so `actualOn` is still true here
     * and `overrideSuppression` has nothing to say either. 296 of the 327
     * overrides in that recording were this, and nothing else.
     */
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false, 'switching a lamp off is not overriding us');
    assert.ok(d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'dim_zero'));
    assert.equal(d.recentControlEvents.filter(e => e.type === 'override').length, 0);
    await h.runtime.stop();
  });

  /**
   * A sensor that stopped is INVISIBLE without this: the reading it froze on
   * goes on being used — deliberately, because many Zigbee sensors report only
   * on change and a timeout would fall back to the sky precisely when the room
   * is most stable — so the device holds the room at one brightness and reports
   * 'ready' for as long as the app runs.
   *
   * The 12-hour warning existed only on the pairing screen, which is the one
   * moment the sensor is working by definition.
   */
  test('a sensor that has stopped reporting is said out loud', async () => {
    const frozen = Date.UTC(2026, 5, 21, 10, 0);
    const h = harness({ plan: plan({ sensor: 's1' }), sensorAt: () => frozen });
    await h.runtime.start();
    await sharedSettle(12);
    assert.equal(h.runtime.diagnostics().state, 'ready', 'fresh at the start');

    h.advance(13 * 60 * 60_000);
    await h.runtime.assessHealth();

    assert.equal(h.runtime.diagnostics().state, 'partial',
      'partial, not needs_repair: the lamps are still being driven somewhere defensible');
    assert.equal((h.states.at(-1)?.detail as { key?: string })?.key, 'state.daylightSensorStale');
    await h.runtime.stop();
  });

  test('a quiet sensor in a still room is not stale', async () => {
    const h = harness({ plan: plan({ sensor: 's1' }) });
    await h.runtime.start();
    await sharedSettle(12);

    // Eleven hours of silence. Normal on a report-on-change sensor, and the one
    // thing that must not be called a fault.
    h.advance(11 * 60 * 60_000);
    await h.runtime.assessHealth();
    assert.equal(h.runtime.diagnostics().state, 'ready');
    await h.runtime.stop();
  });

  test('a device following the sun alone has no sensor to go quiet', async () => {
    const h = harness({ plan: plan({ sensor: null }) });
    await h.runtime.start();
    await sharedSettle(12);

    h.advance(48 * 60 * 60_000);
    await h.runtime.assessHealth();
    assert.equal(h.runtime.diagnostics().state, 'ready');
    await h.runtime.stop();
  });

  test('a loop watched running away marks the device, and a well-placed sensor never does', async () => {
    // Lamps that start near the bottom, so every pass of the slew raises them:
    // seeded from a lit lamp the aim would spend its first passes coming DOWN,
    // and a falling aim is not the thing under test.
    const h = harness({
      plan: plan({ sensor: 's1', dark: 0.25, bright: 0.9 }),
      devices: [light('l1', undefined, { dim: 0.01 }), light('l2', undefined, { dim: 0.01 })],
      verdict: { level: 0.2, brightness: 0.3 },
    });
    await h.runtime.start();
    await sharedSettle(12);
    assert.equal(h.runtime.diagnostics().feedbackRisk, 'increasing_sensor_response');
    assert.equal(h.runtime.diagnostics().feedbackObservations, 0);

    /**
     * The signature, six times over: we raise the lamps, and the reading then
     * rises. In a room where the sensor cannot see these lamps that is chance
     * and does not repeat; where it can, it is the mechanism, and it ran 95
     * times in 3.83 days with the sensor reading a median of 1 lux with its
     * lamp off and 680 lux with it on.
     */
    for (let pass = 1; pass <= 6; pass += 1) {
      h.advance(60_000);
      h.setVerdict({ level: 0.2 + pass * 0.1, brightness: 0.9 });
      await tick(h);
    }

    const d = h.runtime.diagnostics();
    assert.ok(d.feedbackObservations >= 5, `observed ${d.feedbackObservations} times`);
    assert.equal(d.state, 'partial');
    assert.deepEqual(h.states.at(-1), {
      state: 'partial',
      detail: {
        key: 'state.daylightFeedback',
        text: 'Its lamps are brightening their own sensor. Move the sensor, or lower the bright end.',
      },
    });
    await h.runtime.stop();
  });

  /**
   * The evidence is slow by construction — five raise-then-rise passes, and on
   * the reference Homey two had accumulated in 22.7 hours — so anything that
   * resets it more often than that is not a reset, it is a cap.
   *
   * `updatePlan()` is stop-then-start, and the count used to be cleared in
   * `stop()` alongside `aim` and `committed`. Those two belong there: both
   * describe the OLD plan and would gate the new plan's first write. The count
   * describes the ROOM, so renaming the device threw away the only record that
   * its lamps light their own sensor.
   */
  test('evidence of a loop survives a plan edit that left the response alone', async () => {
    const h = harness({
      plan: plan({ sensor: 's1', dark: 0.25, bright: 0.9 }),
      devices: [light('l1', undefined, { dim: 0.01 }), light('l2', undefined, { dim: 0.01 })],
      verdict: { level: 0.2, brightness: 0.3 },
    });
    await h.runtime.start();
    await sharedSettle(12);
    for (let pass = 1; pass <= 3; pass += 1) {
      h.advance(60_000);
      h.setVerdict({ level: 0.2 + pass * 0.1, brightness: 0.9 });
      await tick(h);
    }
    const observed = h.runtime.diagnostics().feedbackObservations;
    assert.ok(observed > 0, `something has to have been observed; saw ${observed}`);

    // The lights change, the response does not.
    await h.runtime.updatePlan({
      ...plan({ sensor: 's1', dark: 0.25, bright: 0.9 }),
      target: { kind: 'zone', zoneId: 'z1', includeSubzones: true },
    });
    await sharedSettle(12);
    assert.equal(h.runtime.diagnostics().feedbackObservations, observed,
      'the room did not change, so what was watched happening in it still stands');
    await h.runtime.stop();
  });

  test('and is dropped when the response itself is edited', async () => {
    const h = harness({
      plan: plan({ sensor: 's1', dark: 0.25, bright: 0.9 }),
      devices: [light('l1', undefined, { dim: 0.01 }), light('l2', undefined, { dim: 0.01 })],
      verdict: { level: 0.2, brightness: 0.3 },
    });
    await h.runtime.start();
    await sharedSettle(12);
    for (let pass = 1; pass <= 3; pass += 1) {
      h.advance(60_000);
      h.setVerdict({ level: 0.2 + pass * 0.1, brightness: 0.9 });
      await tick(h);
    }
    assert.ok(h.runtime.diagnostics().feedbackObservations > 0);

    // Lowering the bright end is the advice the warning gives, so the evidence
    // for it has to start again from nothing.
    await h.runtime.updatePlan(plan({ sensor: 's1', dark: 0.25, bright: 0.5 }));
    await sharedSettle(12);
    assert.equal(h.runtime.diagnostics().feedbackObservations, 0);
    await h.runtime.stop();
  });

  test('a reading that does not follow the lamps is never called feedback', async () => {
    const h = harness({
      plan: plan({ sensor: 's1', dark: 0.25, bright: 0.9 }),
      devices: [light('l1', undefined, { dim: 0.01 }), light('l2', undefined, { dim: 0.01 })],
      verdict: { level: 0.2, brightness: 0.3 },
    });
    await h.runtime.start();
    await sharedSettle(12);

    // The lamps climb exactly as above; the room does not notice. A sensor
    // placed where it can only see the sky behaves like this, and must stay
    // 'ready' — the configuration is still risky, nothing has been observed.
    for (let pass = 1; pass <= 8; pass += 1) {
      h.advance(60_000);
      h.setVerdict({ brightness: 0.9 });
      await tick(h);
    }

    const d = h.runtime.diagnostics();
    assert.equal(d.feedbackRisk, 'increasing_sensor_response', 'the CONFIGURATION is still risky');
    assert.equal(d.feedbackObservations, 0, 'but nothing was ever watched happening');
    assert.equal(d.state, 'ready');
    await h.runtime.stop();
  });
});

/**
 * What a 19.8-hour capture on the reference Homey found, a year on from the
 * recording above. Both are the same mistake again — a LAMP read as a PERSON —
 * surviving in the two shapes the guards written for it do not cover: a lamp
 * that fades out through a NONZERO level, and a lamp announcing what it came
 * back on at.
 */
describe('what the day-long capture found', () => {
  test('a lamp fading out is recorded as one, not as a household taking its lights back', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.61 })], verdict: { brightness: 0.8 } });
    await h.runtime.start();
    await sharedSettle(12);

    /**
     * The Activity Room, where all five overrides in the capture were this: a
     * `dim` report below what we wanted, 29.0-29.9 s before that lamp's own
     * `onoff: false`. `dim_zero` cannot catch it — the value is 0.11, not 0 —
     * and `lamp_off` cannot either, because `actualOn` is still true.
     */
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.11);
    assert.equal(h.runtime.diagnostics().targets[0].overridden, true,
      'raised as before: the evidence that explains it has not arrived yet');

    h.advance(29_000);
    h.report('l1', 'onoff', false);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].override, null);
    assert.equal(d.targets[0].fadeOutOverrides, 1);
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'power_fade_out'));
    await h.runtime.stop();
  });

  test('dimming a room and switching it off a second later is a person, not a fade', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.61 })], verdict: { brightness: 0.8 } });
    await h.runtime.start();
    await sharedSettle(12);

    /**
     * What the first build carrying this rule got wrong, caught on hardware
     * within the hour: somebody pressed dim-down on a Light Remote and switched
     * the room off a second afterwards, and all five lamps — 0.5 s to 2.1 s from
     * the override to the off — were filed as lamps fading out. The fade report
     * is not merely within a minute of the off, it is about half a minute ahead
     * of it (29.2 s minimum over 232 measured pairs), so the rule has a floor.
     */
    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.32);
    h.advance(2_000);
    h.report('l1', 'onoff', false);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].fadeOutOverrides, undefined,
      'a lamp cannot begin fading out two seconds before it reports itself off');
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'power_changed'));
    await h.runtime.stop();
  });

  test('a lamp switched off long after being dimmed is still a person who dimmed it', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.61 })], verdict: { brightness: 0.8 } });
    await h.runtime.start();
    await sharedSettle(12);

    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.11);
    h.advance(10 * 60_000);
    h.report('l1', 'onoff', false);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].fadeOutOverrides, undefined);
    assert.ok(d.recentControlEvents.some(e => e.type === 'override_cleared' && e.reason === 'power_changed'));
    await h.runtime.stop();
  });

  test('a lamp raised ABOVE what we wanted and then switched off is not a fade-out', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.03 })], verdict: { brightness: 0.2 } });
    await h.runtime.start();
    await sharedSettle(12);

    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.9);
    h.advance(20_000);
    h.report('l1', 'onoff', false);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].fadeOutOverrides, undefined,
      'somebody turned it up and then off, which is two decisions and neither is a fade');
    await h.runtime.stop();
  });

  test('one override is one row, however many times the lamp restates it', async () => {
    const h = harness({ devices: [light('l1', undefined, { dim: 0.03 })], verdict: { brightness: 0.2 } });
    await h.runtime.start();
    await sharedSettle(12);

    h.advance(SETTLE_PAST);
    h.report('l1', 'dim', 0.8);
    const raisedAt = h.runtime.diagnostics().targets[0].override?.at;

    /**
     * The Garage lamps from the capture: creeping a hundredth every couple of
     * minutes, under something outside this app, each new value re-noting the
     * override that was already standing. An IDENTICAL repeat never gets this
     * far — `applyExternalChange` reports no change and the runtime is not
     * called — so a drift is the shape this actually takes.
     */
    for (let step = 1; step <= 19; step++) {
      h.advance(120_000);
      h.report('l1', 'dim', Number((0.8 + step * 0.01).toFixed(2)));
    }

    const d = h.runtime.diagnostics();
    assert.equal(d.recentControlEvents.filter(e => e.type === 'override').length, 1,
      'twenty reports, one override, one row — where twenty rows used to evict the history');
    assert.equal(d.targets[0].override?.repeats, 20);
    assert.equal(d.targets[0].override?.value, 0.99, 'the record follows the lamp');
    assert.equal(d.targets[0].override?.at, raisedAt,
      'and the four-hour deadline is still anchored to the first report');
    await h.runtime.stop();
  });

  test('the level a lamp comes back on at does not stand its runtime down', async () => {
    const h = harness({ devices: [light('l1', undefined, { onoff: false, dim: 0.30 })], verdict: { brightness: 0.05 } });
    await h.runtime.start();
    await sharedSettle(12);

    // The Garage: four lamps on one bridge, reporting the levels they had been
    // left at 4.4 s after the `onoff` edge — past the settle window, because the
    // pass had little to write and only an OPEN window is pushed out.
    h.advance(SETTLE_PAST);
    h.report('l1', 'onoff', true);
    await sharedSettle(12);
    h.advance(4_400);
    h.report('l1', 'dim', 0.30);

    const d = h.runtime.diagnostics();
    assert.equal(d.targets[0].overridden, false,
      'a whole ON period of doing nothing began exactly here');
    assert.ok(d.recentControlEvents.some(e => e.type === 'report_ignored' && e.reason === 'power_restore'));
    await h.runtime.stop();
  });
});
