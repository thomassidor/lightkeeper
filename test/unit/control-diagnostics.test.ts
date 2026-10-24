import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetStateCache, OVERRIDE_TOLERANCE, withinOverrideTolerance,
} from '../../lib/outputs/target-state-cache';
import { ControlHistory, type ControlAction } from '../../lib/runtime/control-diagnostics';

test('malformed reports never corrupt a target or classify as an override', () => {
  const cache = new TargetStateCache();
  cache.initialise('lamp', { onoff: true, dim: 0.5 });
  for (const value of [null, undefined, '', '0', {}, false, NaN, Infinity, -1, 2]) {
    assert.equal(cache.applyExternalChange('lamp', 'dim', value), false);
    assert.equal(cache.state('lamp').actualDim, 0.5);
    assert.equal(cache.currentDim('lamp'), 0.5);
  }
  assert.equal(cache.applyExternalChange('lamp', 'onoff', null), false);
  assert.equal(cache.currentOn('lamp'), true);
});

test('in-flight writes suppress intermediate reports until completion plus settling', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  const seq = cache.noteEcho('lamp', 'dim', 0.2);
  now = 10_000;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'write_pending');
  cache.finishWrite('lamp', 'dim', seq);
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'write_settling');
  now += 3001;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), null);
  assert.equal(cache.applyExternalChange('lamp', 'dim', 0.8), true);
});

test('an older completion cannot release a newer write; forgetting clears the guard', () => {
  const cache = new TargetStateCache();
  const first = cache.noteEcho('lamp', 'dim', 0.2);
  cache.noteEcho('lamp', 'dim', 0.3);
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'write_pending');
  cache.forget('lamp');
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), null);
  cache.noteEcho('lamp', 'dim', 0.4);
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'write_pending',
    'a late completion from a removed target cannot finish its replacement write');
});

test('repeated power reports do not indefinitely extend the startup settle window', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false });
  cache.applyExternalChange('lamp', 'onoff', true);
  now = 2000;
  cache.applyExternalChange('lamp', 'onoff', true);
  now = 3001;
  // The lamp's restore allowance is spent first — one report per capability, and
  // this is that report. What the window does is the SECOND one's question.
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'power_restore');
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), null);
});

test('decision history stays bounded independently of the number of lamp writes', () => {
  const history = new ControlHistory<ControlAction>();
  for (let at = 0; at < 65; at++) {
    history.actions.add({ at, reason: 'tick', writes: 0, skipped: 0 });
  }
  assert.deepEqual(history.snapshot().history.actions, { capacity: 60, retained: 60, dropped: 5 });
  assert.equal(history.snapshot().recentActions[0].at, 64);
  assert.equal(history.snapshot().recentActions.at(-1)?.at, 5);
});

/**
 * What a capture on the reference Homey found five lamps doing on one wall
 * switch, and the two rules that came out of it. Both are the same mistake as
 * the week-long recording's: reading a LAMP as a PERSON.
 */
test('the power-settle window outlives the write burst the power event caused', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false, light_temperature: 0.87 });

  cache.applyExternalChange('lamp', 'onoff', true);
  // The forced pass this provokes takes 1.9 s to get its last ack out, which is
  // already past a window anchored at the transition.
  now = 1_900;
  const seq = cache.noteEcho('lamp', 'light_temperature', 0.82);
  cache.finishWrite('lamp', 'light_temperature', seq);

  now = 4_000;
  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.5), 'power_settling',
    'the lamp answers our write after the transition window would have shut');

  now = 5_000;
  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.5), null,
    'and the window still shuts a settle after the burst, rather than never');
});

test('a quiet power transition is not extended by writes that never happened', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false });
  cache.applyExternalChange('lamp', 'onoff', true);
  now = 3_001;
  // As above: the first report after the edge is the restore, and the window is
  // what answers the one after it.
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), 'power_restore');
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.8), null);
});

test('a lamp reporting the value it never left is an ignored write, not a person', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  // The Garage lamps from the capture: sitting at 0.87, sent 0.82, reporting
  // 0.87 back. The delta is 0.05, well outside OVERRIDE_TOLERANCE, so the
  // tolerance alone can never forgive it.
  cache.initialise('lamp', { onoff: true, light_temperature: 0.87 });
  const seq = cache.noteEcho('lamp', 'light_temperature', 0.82);
  cache.finishWrite('lamp', 'light_temperature', seq);
  now = 60_000;

  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.87), 'write_ignored');
  assert.equal(cache.ignoredCount('lamp', 'light_temperature'), 1);

  // However many times it repeats itself, that is still one write ignored.
  cache.overrideSuppression('lamp', 'light_temperature', 0.87);
  assert.equal(cache.ignoredCount('lamp', 'light_temperature'), 1);

  const next = cache.noteEcho('lamp', 'light_temperature', 0.80);
  cache.finishWrite('lamp', 'light_temperature', next);
  now = 120_000;
  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.87), 'write_ignored');
  assert.equal(cache.ignoredCount('lamp', 'light_temperature'), 2, 'a second write, a second count');
});

test('a write that landed leaves later movement to the ordinary override rules', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: true, dim: 0.50 });
  const seq = cache.noteEcho('lamp', 'dim', 0.79);
  cache.finishWrite('lamp', 'dim', seq);
  now = 60_000;

  // The lamp got there, so the snapshot stops describing anything.
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.79), null);
  // A person then puts it back near where it started. Without the landed-write
  // check this reads as "the lamp ignored us" and is silently forgiven.
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.51), null,
    'a person is still a person, even landing where the lamp began');
  assert.equal(cache.ignoredCount('lamp', 'dim'), 0);
});

test('a real nudge on a stuck lamp is still an override', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: true, dim: 0.10 });
  const seq = cache.noteEcho('lamp', 'dim', 0.05);
  cache.finishWrite('lamp', 'dim', seq);
  now = 60_000;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.10), 'write_ignored');
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.60), null,
    'somewhere the lamp has never been is news, whatever it ignored before');
});

/**
 * A tolerance is compared with an epsilon, never with a bare `<=`.
 *
 * `Math.abs(0.83 - 0.86)` is 0.030000000000000027, so the same three hundredths
 * was forgiven at one end of the axis and prosecuted at the other — and an
 * override, once raised, stood a device down for hours. The values are written
 * as the subtractions a lamp's reports actually produce, not as literals, because
 * the literal 0.03 is the one case that never goes wrong.
 */
test('three hundredths is within tolerance wherever on the axis it falls', () => {
  assert.equal(OVERRIDE_TOLERANCE, 0.03, 'the tolerance this test was written against');
  assert.ok(Math.abs(0.83 - 0.86) > OVERRIDE_TOLERANCE, 'the float error this guards against');
  assert.equal(withinOverrideTolerance(0.83 - 0.86), true);
  assert.equal(withinOverrideTolerance(0.86 - 0.83), true);
  assert.equal(withinOverrideTolerance(0.10 - 0.13), true);
  // And the slack is an epsilon, not a widening: anything a lamp could really
  // express past three hundredths is still outside.
  assert.equal(withinOverrideTolerance(0.035), false);
  assert.equal(withinOverrideTolerance(-0.035), false);
  assert.equal(withinOverrideTolerance(0.03 + 1e-6), false);
});

test('a stuck lamp re-reporting its old level three hundredths off is still an ignored write', () => {
  // The same float error, one layer down: `sameReportedValue` decides whether a
  // report is the value the lamp sat at before our write, and it must go
  // through the epsilon too. Sitting at 0.86, sent 0.50, re-reporting 0.83 —
  // a bridge restating an unchanged level, not a person — must be forgiven as
  // the lamp ignoring us, not filed as an override because 0.86 − 0.83 came out
  // a hair over 0.03.
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: true, light_temperature: 0.86 });
  const seq = cache.noteEcho('lamp', 'light_temperature', 0.50);
  cache.finishWrite('lamp', 'light_temperature', seq);
  now = 60_000;

  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.83), 'write_ignored');
  assert.equal(cache.ignoredCount('lamp', 'light_temperature'), 1);
});

test('forgetting a target drops what it was reporting before its last write', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: true, dim: 0.10 });
  const seq = cache.noteEcho('lamp', 'dim', 0.05);
  cache.finishWrite('lamp', 'dim', seq);
  now = 60_000;
  assert.equal(cache.ignoredCount('lamp', 'dim'), 0);
  cache.overrideSuppression('lamp', 'dim', 0.10);
  assert.equal(cache.ignoredCount('lamp', 'dim'), 1);
  cache.forget('lamp');
  assert.equal(cache.ignoredCount('lamp', 'dim'), 0);
});

/**
 * The Garage, from a 19.8-hour capture on the reference Homey. Four lamps on
 * one bridge came on together and reported the levels they had been left at
 * 4.4 s later, within 0.4 s of each other — 80 ms after the power-settle window
 * had shut, because the pass had little to write and `finishWrite` only pushes
 * an OPEN window out. All four were read as somebody reaching for the vendor
 * app, and the Room-sensing Light driving them did nothing for the 29 minutes
 * they were on.
 */
test('the level a lamp comes back on at is the lamp, not a person', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false, dim: 0.30 });

  cache.applyExternalChange('lamp', 'onoff', true);
  now = 4_400;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_restore',
    'the restored level, past the settle window and nowhere near what we wanted');
});

test('the restore allowance is one report, and the next one is judged', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false, dim: 0.30 });

  cache.applyExternalChange('lamp', 'onoff', true);
  now = 4_400;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_restore');
  now = 6_000;
  // Somebody switched the light on and then dimmed it, which is exactly what
  // the override machinery exists to honour. A longer settle window would have
  // eaten this; spending the allowance on the lamp's own report does not.
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.90), null,
    'a person arriving after the lamp has spoken is still a person');
});

test('a restore inside the settle window still spends the allowance', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false, dim: 0.30 });

  cache.applyExternalChange('lamp', 'onoff', true);
  now = 1_000;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_settling',
    'the more specific reason still wins while the window is open');
  now = 5_000;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.90), null,
    'the allowance cannot be saved up and handed to whoever turns up next');
});

test('each capability gets its own restore allowance, and only near the edge', () => {
  let now = 0;
  const cache = new TargetStateCache(() => now);
  cache.initialise('lamp', { onoff: false, dim: 0.30, light_temperature: 0.50 });

  cache.applyExternalChange('lamp', 'onoff', true);
  now = 4_400;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_restore');
  assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.50), 'power_restore',
    'a lamp restores every axis it has, and each one speaks once');

  // A second power cycle re-arms it; a report long after one does not get it.
  cache.applyExternalChange('lamp', 'onoff', false);
  cache.applyExternalChange('lamp', 'onoff', true);
  now += 20_000;
  assert.equal(cache.overrideSuppression('lamp', 'dim', 0.90), null,
    'twenty seconds after switch-on, a lamp has finished restoring');
});

test('a run of identical reports is one row, counted, not a hundred', () => {
  const history = new ControlHistory<ControlAction>();
  for (let at = 0; at < 100; at++) {
    history.ignored({ at, type: 'report_ignored', deviceId: 'lamp', capability: 'dim', value: 0.5, reason: 'write_pending' });
  }
  const events = history.snapshot().recentControlEvents;
  assert.equal(events.length, 1);
  assert.deepEqual(
    { at: events[0].at, count: events[0].count, lastAt: events[0].lastAt },
    { at: 0, count: 100, lastAt: 99 },
    'the first occurrence dates the row; the count and the last one say how it went on',
  );
  assert.equal(history.snapshot().history.events.dropped, 0);
});

test('folding looks past the rows interleaved with it, and a new reason starts a row', () => {
  const history = new ControlHistory<ControlAction>();
  // Five lamps in a room echo one write each, in turn: a newest-only test would
  // match none of them, which is the case this exists for.
  for (let round = 0; round < 20; round++) {
    for (const lamp of ['a', 'b', 'c', 'd', 'e']) {
      history.ignored({ at: round, type: 'report_ignored', deviceId: lamp, capability: 'dim', value: 0.5, reason: 'write_pending' });
    }
  }
  assert.equal(history.snapshot().recentControlEvents.length, 5);

  history.ignored({ at: 99, type: 'report_ignored', deviceId: 'a', capability: 'dim', value: 0.5, reason: 'write_ignored' });
  assert.equal(history.snapshot().recentControlEvents.length, 6,
    'a different reason is different news');
  history.ignored({ at: 99, type: 'report_ignored', deviceId: 'a', capability: 'light_hue', value: 0.5, reason: 'write_pending' });
  assert.equal(history.snapshot().recentControlEvents.length, 7,
    'and so is a different capability');
});

/**
 * The power-settle window and the restore allowance, at their edges.
 *
 * The tests above show each rule doing its job once. These pin the bounds that
 * make them safe to have at all: a window extended only while it is OPEN, an
 * allowance that lasts 15 s and no longer, and one that each power-on edge
 * re-arms and each power-off edge withdraws. Get any of those wrong the
 * permissive way and a person's own dimming is forgiven as the lamp's.
 */
describe('power settle and power restore, at their edges', () => {
  test('a write finishing after the window shut does not re-open it', () => {
    // "Only an open window is extended" is what keeps the settle window
    // bounded. Were a shut one re-opened by any late write, every pass the
    // runtime makes would buy the lamp another three seconds of immunity, and
    // a person's change landing just after one would never be read as theirs.
    let now = 0;
    const cache = new TargetStateCache(() => now);
    cache.initialise('lamp', { onoff: false, dim: 0.30, light_temperature: 0.50 });

    cache.applyExternalChange('lamp', 'onoff', true);
    // Spend the temperature axis's restore allowance after the window has shut,
    // so the report under test below is judged by the window alone.
    now = 3_500;
    assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.50), 'power_restore');

    now = 4_000;
    const seq = cache.noteEcho('lamp', 'dim', 0.40);
    cache.finishWrite('lamp', 'dim', seq);

    now = 5_000;
    assert.equal(cache.overrideSuppression('lamp', 'light_temperature', 0.90), null,
      'a write after the window shut is not one the power event caused');
  });

  test('a second power-on re-arms the restore allowance', () => {
    // The comment on the per-capability test above claims this and never
    // asserted it. Each power-on is a new restore: a lamp that has already
    // spoken once tonight still restores its level the next time it comes on,
    // and reading that as a person stands the device down for four hours.
    let now = 0;
    const cache = new TargetStateCache(() => now);
    cache.initialise('lamp', { onoff: false, dim: 0.30 });

    cache.applyExternalChange('lamp', 'onoff', true);
    now = 4_400;
    assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_restore');

    now = 10_000;
    cache.applyExternalChange('lamp', 'onoff', false);
    now = 20_000;
    cache.applyExternalChange('lamp', 'onoff', true);
    // Past the new edge's settle window, so only the allowance can answer.
    now = 24_400;
    assert.equal(cache.overrideSuppression('lamp', 'dim', 0.30), 'power_restore',
      'the second power-on gets its own restore');
  });

  test('the allowance lasts fifteen seconds from the edge, and not a moment more', () => {
    // POWER_RESTORE_MS is the measured envelope: lamps on a bridge report their
    // restored levels a few seconds after coming on. Shorter and a slow bridge
    // is read as a person; longer and a person's first change after switch-on
    // is forgiven as the lamp's.
    let now = 0;
    const inside = new TargetStateCache(() => now);
    inside.initialise('lamp', { onoff: false, dim: 0.30 });
    inside.applyExternalChange('lamp', 'onoff', true);
    now = 14_900;
    assert.equal(inside.overrideSuppression('lamp', 'dim', 0.30), 'power_restore');

    now = 0;
    const outside = new TargetStateCache(() => now);
    outside.initialise('lamp', { onoff: false, dim: 0.30 });
    outside.applyExternalChange('lamp', 'onoff', true);
    now = 15_100;
    assert.equal(outside.overrideSuppression('lamp', 'dim', 0.30), null);
  });

  test('switching off withdraws the allowance the last power-on granted', () => {
    // An off edge resets the set of capabilities that have spoken, so without
    // also clearing when the lamp came on, the next report — from a lamp that
    // is now OFF — would be forgiven as a restore it is not.
    let now = 0;
    const cache = new TargetStateCache(() => now);
    cache.initialise('lamp', { onoff: false, dim: 0.30 });

    cache.applyExternalChange('lamp', 'onoff', true);
    now = 1_000;
    cache.applyExternalChange('lamp', 'onoff', false);
    // Past the off edge's settle window, still inside fifteen seconds of the on.
    now = 5_000;
    assert.equal(cache.overrideSuppression('lamp', 'dim', 0.90), null,
      'there is no power-on to restore from');
  });
});

/**
 * The override rules under DUPLICATED echoes (platform §6).
 *
 * "Setting `dim` once produces two identical callbacks" — on twenty-two of
 * twenty-seven lamps measured, and on every Hue bulb. Every test above hands
 * the cache exactly one report per write. These run a real CircadianRuntime
 * over the `homey-api` fake with `duplicateEchoes` on, so each write and each
 * external change reaches the real adapter, subscription and cache twice, as
 * on a Homey.
 *
 * What must hold: our own write echoed twice is still ours — no override, no
 * event, no second write provoked; a person's change echoed twice is ONE
 * override, said once; and one power-on is one forced write, not two.
 *
 * The imports are dynamic so this block stays self-contained in a file whose
 * other tests are about the cache alone.
 */
describe('override classification under duplicated echoes (platform §6)', () => {
  async function curveOverDuplicatingHomey(lampValues: Record<string, unknown> = {}) {
    const { CircadianRuntime } = await import('../../lib/circadian/circadian-runtime');
    const { fakeApiClient, fakeApiService, realCatalog, lamp, ZONES } = await import('../support/fake-homey-api');
    const { FakeTimers } = await import('../support/fake-timers');
    const { settle } = await import('../support/deferred');

    const timers = new FakeTimers(Date.UTC(2026, 9, 24, 12, 0));
    const client = fakeApiClient([lamp('l1', 'Sofa lamp', 'z-living', lampValues)], ZONES, { duplicateEchoes: true });
    // A flat curve: the same warmth and brightness all day, so nothing but a
    // first pass or a power-on ever has a reason to write.
    const runtime = new CircadianRuntime('circ-dup', {
      schemaVersion: 2, enabled: true, target: { kind: 'devices', deviceIds: ['l1'] },
      adjustBrightness: true, transition: 'balanced', preStage: false,
      points: [0, 720].map(at => ({
        id: String(at), anchor: { kind: 'clock' as const, at }, warmth: 0.7, brightness: 0.8,
      })),
    }, {
      api: fakeApiService(client), catalog: realCatalog(client),
      timezone: () => 'UTC', displayName: () => 'Sofa curve', timers,
      log: () => undefined, onStateChange: () => undefined, onPlanChange: async () => undefined,
    });
    return {
      client, runtime, timers,
      /** Let the write queue and every echo it provokes run out. */
      async drain() {
        for (let i = 0; i < 6; i += 1) { timers.advance(1_000); await settle(12); }
      },
      /** Somebody else — the vendor app, a wall switch — sets the lamp. */
      async external(capabilityId: string, value: unknown) {
        const device = await client.devices.getDevice({ id: 'l1' });
        await device.setCapabilityValue({ capabilityId, value });
        await settle(12);
      },
      lampWrites: () => client.writes.filter(w => w.capabilityId !== 'onoff'),
    };
  }

  test('our own write, echoed twice, is still ours: no override, no event, no second write', async () => {
    const rig = await curveOverDuplicatingHomey();
    await rig.runtime.start();
    await rig.drain();

    assert.deepEqual(
      rig.lampWrites().map(w => w.capabilityId), ['dim', 'light_mode', 'light_temperature'],
      'one write per axis — a duplicate read as external would have the desired state fight itself',
    );
    const diagnostics = rig.runtime.diagnostics();
    assert.equal(diagnostics.targets[0]!.overridden, false);
    assert.deepEqual(diagnostics.recentControlEvents, [], 'six echoes of three writes, and nothing to say about them');
    await rig.runtime.destroy();
  });

  test('a person\'s change, echoed twice, is ONE override, said once', async () => {
    const rig = await curveOverDuplicatingHomey();
    await rig.runtime.start();
    await rig.drain();
    // Well past the settle window after our own write, so the report is judged.
    rig.timers.advance(10_000);

    await rig.external('dim', 0.25);

    const diagnostics = rig.runtime.diagnostics();
    const target = diagnostics.targets[0]!;
    assert.equal(target.overridden, true, 'somebody dimmed the lamp, and the curve stands down');
    assert.deepEqual(
      { capability: target.override!.capability, value: target.override!.value, repeats: target.override!.repeats ?? 1 },
      { capability: 'dim', value: 0.25, repeats: 1 },
      'the duplicate is the platform repeating itself, not the lamp restating an override',
    );
    assert.equal(
      diagnostics.recentControlEvents.filter(e => e.type === 'override').length, 1,
      'one override is one row, however many times the platform says it',
    );
    await rig.runtime.destroy();
  });

  test('one power-on, echoed twice, is one forced write — not two', async () => {
    // "because echoes arrive duplicated (§6), [the cache's verdict] is also
    // what makes one power-on produce one write rather than two" — platform §12.
    const rig = await curveOverDuplicatingHomey({ onoff: false });
    await rig.runtime.start();
    await rig.drain();
    assert.deepEqual(rig.lampWrites(), [], 'nothing is written to a lamp that is off, without pre-staging');

    await rig.external('onoff', true);
    await rig.drain();

    assert.deepEqual(
      rig.lampWrites().map(w => w.capabilityId), ['dim', 'light_mode', 'light_temperature'],
      'the switched-on pass ran once',
    );
    const power = rig.runtime.diagnostics().recentControlEvents.filter(e => e.type === 'power');
    assert.equal(power.length, 1, 'and the power edge was recorded once');
    await rig.runtime.destroy();
  });
});
