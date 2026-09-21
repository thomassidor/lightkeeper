import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
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
