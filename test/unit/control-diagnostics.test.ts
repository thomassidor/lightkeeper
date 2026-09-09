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
  assert.equal(cache.overrideSuppression('lamp', 'dim'), 'write_pending');
  cache.finishWrite('lamp', 'dim', seq);
  assert.equal(cache.overrideSuppression('lamp', 'dim'), 'write_settling');
  now += 3001;
  assert.equal(cache.overrideSuppression('lamp', 'dim'), null);
  assert.equal(cache.applyExternalChange('lamp', 'dim', 0.8), true);
});

test('an older completion cannot release a newer write; forgetting clears the guard', () => {
  const cache = new TargetStateCache();
  const first = cache.noteEcho('lamp', 'dim', 0.2);
  cache.noteEcho('lamp', 'dim', 0.3);
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim'), 'write_pending');
  cache.forget('lamp');
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim'), null);
  cache.noteEcho('lamp', 'dim', 0.4);
  cache.finishWrite('lamp', 'dim', first);
  assert.equal(cache.overrideSuppression('lamp', 'dim'), 'write_pending',
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
  assert.equal(cache.overrideSuppression('lamp', 'dim'), null);
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
