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
    sensors: () => [{ deviceId: 's1', name: 'Hall', lux: 42, at: now, available: true }],
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
    const h = harness({ plan: plan({ sensors: ['s1', 's2'] }) });
    await h.runtime.start();

    assert.deepEqual(h.retained, [{ ids: ['s1', 's2'], owner: 'dayl-1' }]);
  });

  test('stopping releases this device claim and no other', async () => {
    // Ref-counted: a sensor another Lightkeeper device also named keeps its
    // subscription.
    const h = harness({ plan: plan({ sensors: ['s1'] }) });
    await h.runtime.start();
    await h.runtime.stop();

    assert.deepEqual(h.released, ['dayl-1']);
  });

  test('a plan change re-retains, so a dropped sensor is released', async () => {
    // retain() is TOTAL for its owner, which is why a runtime can pass its whole
    // list and not work out the difference itself.
    const h = harness({ plan: plan({ sensors: ['s1'] }) });
    await h.runtime.start();
    await h.runtime.updatePlan(plan({ sensors: ['s2'] }));

    assert.deepEqual(h.retained.at(-1), { ids: ['s2'], owner: 'dayl-1' });
  });

  test('diagnostics report only THIS device sensors', async () => {
    // The service is shared, and a report listing another device's sensors is a
    // report that sends the reader to the wrong room.
    const h = harness({ plan: plan({ sensors: ['s1'] }) });
    await h.runtime.start();
    assert.deepEqual(h.runtime.diagnostics().sensors.map(s => s.deviceId), ['s1']);

    const other = harness({ plan: plan({ sensors: ['s-elsewhere'] }) });
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
    const h = harness({ plan: plan({ sensors: ['s1'], dark: 0.25, bright: 0.7 }) });
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
