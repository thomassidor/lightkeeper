import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAGNITUDE_READERS, MISSING_MAGNITUDE, intakeBridgeEvent, readMagnitude, type DispatchOutcome,
} from '../../lib/bridge/bridge-event-intake';

/**
 * The magnitude a numeric bridge card carries, read with a guard rather than
 * `Number()`.
 *
 * `app.ts` used to pass `args => Number(args.value)`. `Number(null)` and
 * `Number('')` are 0 and `Number(true)` is 1, all finite, so an emptied Flow
 * argument dispatched a real-looking amount — and a magnitude of 0 is not the
 * no-op an older test in `bridge-event-intake.test.ts` assumes:
 * `MappingEngine.intentFor` turns it into ONE NOTCH. CLAUDE.md's
 * "`Number(null)` is 0" bullet is the same bug, on the lux path.
 */

const CTRL = 'lk-ctrl-3f1c9f7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

function registries() {
  const calls: Array<{ key: string; magnitude?: number }> = [];
  return {
    calls,
    deps: {
      schedule: (): DispatchOutcome => ({ accepted: true }),
      controller: (_id: string, key: string, options: { magnitude?: number }): DispatchOutcome => {
        calls.push({ key, ...options });
        return { accepted: true };
      },
    },
  };
}

describe('readMagnitude', () => {
  test('a finite number, or a string that is one once trimmed', () => {
    assert.equal(readMagnitude(3), 3);
    assert.equal(readMagnitude(0), 0, 'zero is a number, not an absence');
    assert.equal(readMagnitude(-2.5), -2.5);
    assert.equal(readMagnitude(' 151 '), 151);
    assert.equal(readMagnitude('0'), 0);
  });

  test('everything else is ABSENT — never coerced into an amount', () => {
    for (const value of [null, undefined, '', '   ', 'three', true, false, [3], {}, Number.NaN, Infinity, -Infinity]) {
      assert.equal(readMagnitude(value), undefined, String(value));
    }
  });

  test('the two shipped readers read the field their card carries it in', () => {
    assert.equal(MAGNITUDE_READERS.value({ value: '4', droptoken: 9 }), 4);
    assert.equal(MAGNITUDE_READERS.droptoken({ value: 4, droptoken: 9 }), 9);
    assert.equal(MAGNITUDE_READERS.droptoken({ value: 4 }), undefined);
  });
});

describe('a card that must carry a magnitude', () => {
  test('is refused without one, before any registry is asked, and the refusal is recorded', () => {
    const r = registries();
    const result = intakeBridgeEvent('bridge_numeric_event', { controller: CTRL, event_key: 'k', value: null },
      MAGNITUDE_READERS.value, r.deps, { requireMagnitude: true });

    assert.equal(result.accepted, false);
    assert.equal(result.reason, MISSING_MAGNITUDE);
    assert.deepEqual(result.record, {
      cardId: 'bridge_numeric_event', controller: CTRL, eventKey: 'k', accepted: false, reason: MISSING_MAGNITUDE,
    });
    assert.deepEqual(r.calls, []);
  });

  test('is dispatched with the amount when it has one, zero included', () => {
    const r = registries();
    for (const value of [0, '7']) {
      intakeBridgeEvent('bridge_numeric_event', { controller: CTRL, event_key: 'k', value },
        MAGNITUDE_READERS.value, r.deps, { requireMagnitude: true });
    }
    assert.deepEqual(r.calls, [{ key: 'k', magnitude: 0 }, { key: 'k', magnitude: 7 }]);
  });

  test('a missing controller is still the first refusal, and says so', () => {
    const r = registries();
    const result = intakeBridgeEvent('bridge_numeric_event', { event_key: 'k' },
      MAGNITUDE_READERS.value, r.deps, { requireMagnitude: true });
    assert.equal(result.reason, 'missing controller or event key');
  });
});
