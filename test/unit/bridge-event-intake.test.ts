import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { intakeBridgeEvent, type DispatchOutcome } from '../../lib/bridge/bridge-event-intake';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';

/**
 * "Bridge arguments are untrusted" — one of CLAUDE.md's stated safety
 * properties, and until this file it had no test anywhere.
 *
 * It could not have one. The coercion, the fail-closed refusal, the magnitude
 * extraction and the routing decision all lived in `app.ts`, inside a class that
 * `extends Homey.App` — and `require('homey')` resolves to the CLI outside a
 * Homey, so importing that file dies with `Class extends value undefined`
 * (platform §13). `api.ts`'s parallel surface has always been testable because it
 * is a plain object; this half was not.
 *
 * What makes the property matter: a generated Flow's arguments are ordinary
 * editable fields in the user's Flow editor. "The Flow fired" is never on its own
 * permission to write to anybody's lights.
 */

function registries(over: {
  schedule?: (id: string, key: string) => DispatchOutcome;
  controller?: (id: string, key: string, options: { magnitude?: number }) => DispatchOutcome;
} = {}) {
  const calls: Array<{
    to: 'schedule' | 'controller'; id: string; key: string; magnitude?: number;
  }> = [];
  return {
    calls,
    deps: {
      schedule: (id: string, key: string) => {
        calls.push({ to: 'schedule', id, key });
        return over.schedule ? over.schedule(id, key) : { accepted: true };
      },
      controller: (id: string, key: string, options: { magnitude?: number }) => {
        calls.push({ to: 'controller', id, key, ...options });
        return over.controller ? over.controller(id, key, options) : { accepted: true };
      },
    },
  };
}

const CTRL = 'lk-ctrl-3f1c9f7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const SCHED = 'lk-sched-3f1c9f7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

describe('an event with arguments we cannot use is refused', () => {
  test('a missing controller fails closed, and says which half', () => {
    const r = registries();
    const result = intakeBridgeEvent('bridge_event', { event_key: 'k' }, undefined, r.deps);

    assert.equal(result.accepted, false);
    assert.match(result.reason ?? '', /missing controller or event key/);
    assert.deepEqual(r.calls, [], 'nothing was dispatched');
  });

  test('a missing event key fails closed too', () => {
    const r = registries();
    const result = intakeBridgeEvent('bridge_event', { controller: CTRL }, undefined, r.deps);

    assert.equal(result.accepted, false);
    assert.deepEqual(r.calls, []);
  });

  test('arguments emptied out in the Flow editor are the realistic case', () => {
    const r = registries();
    for (const args of [{}, null, undefined, { controller: '', event_key: '' }]) {
      const result = intakeBridgeEvent('bridge_event', args, undefined, r.deps);
      assert.equal(result.accepted, false, JSON.stringify(args));
    }
    assert.deepEqual(r.calls, []);
  });

  test('the refusal is RECORDED, or a Flow that fires into nothing is undiagnosable', () => {
    const r = registries();
    const { record } = intakeBridgeEvent('bridge_numeric_event', {}, undefined, r.deps);

    assert.equal(record.cardId, 'bridge_numeric_event');
    assert.equal(record.accepted, false);
    assert.ok(record.reason);
  });
});

describe('routing is decided by the shape of the key', () => {
  /**
   * Not by trying both registries in turn. A schedule boundary key is
   * unmistakable, and asking the controller registry about one first would
   * produce a refusal reason about a missing mapping catalogue — exactly the
   * wrong sentence to leave in the diagnostics of a schedule that did not fire.
   */
  test('a schedule boundary key goes to the schedule registry', () => {
    const r = registries();
    intakeBridgeEvent(
      'bridge_event',
      { controller: SCHED, event_key: eventKeyFor('night', 'on') },
      undefined,
      r.deps,
    );

    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.to, 'schedule');
  });

  test('anything else goes to the controller registry', () => {
    const r = registries();
    intakeBridgeEvent(
      'bridge_event', { controller: CTRL, event_key: 'n2_on|press' }, undefined, r.deps,
    );

    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.to, 'controller');
  });

  test('a key that only LOOKS like a schedule key is not one', () => {
    const r = registries();
    // parseEventKey is strict on purpose: three parts, the right prefix, a known
    // boundary. Anything else is a controller's own binding key.
    for (const key of ['sched:night', 'sched:night:sideways', 'sched::on', 'other:night:on']) {
      r.calls.length = 0;
      intakeBridgeEvent('bridge_event', { controller: CTRL, event_key: key }, undefined, r.deps);
      assert.equal(r.calls[0]!.to, 'controller', key);
    }
  });

  test('a registry refusal is passed through with its reason intact', () => {
    const r = registries({
      controller: () => ({ accepted: false, reason: 'no running controller' }),
    });
    const result = intakeBridgeEvent(
      'bridge_event', { controller: CTRL, event_key: 'k' }, undefined, r.deps,
    );

    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'no running controller');
    assert.equal(result.record.reason, 'no running controller');
  });
});

describe('the magnitude', () => {
  test('is read by the card that carries one, and reaches the controller', () => {
    const r = registries();
    intakeBridgeEvent(
      'bridge_numeric_event',
      { controller: CTRL, event_key: 'k', value: '151' },
      args => Number(args.value),
      r.deps,
    );

    assert.equal(r.calls[0]!.magnitude, 151);
  });

  /**
   * `droptoken` is a TOP-LEVEL property of the action, not an entry in `args`
   * (platform §5) — which is why the token card's reader is a different lambda
   * rather than another field name.
   */
  test('comes off droptoken for the token card', () => {
    const r = registries();
    intakeBridgeEvent(
      'bridge_token_event',
      { controller: CTRL, event_key: 'k', droptoken: 42 },
      args => Number(args.droptoken),
      r.deps,
    );

    assert.equal(r.calls[0]!.magnitude, 42);
  });

  test('a non-finite magnitude is DROPPED, not passed on as NaN', () => {
    const r = registries();
    // Everything `Number()` cannot make sense of. NaN reaching the planner is an
    // arithmetic hole, and it would arrive looking like a real delta.
    for (const value of ['not a number', undefined, {}, [1, 2]]) {
      r.calls.length = 0;
      intakeBridgeEvent(
        'bridge_numeric_event',
        { controller: CTRL, event_key: 'k', value },
        args => Number(args.value),
        r.deps,
      );
      assert.ok(!('magnitude' in r.calls[0]!), `magnitude survived for ${JSON.stringify(value)}`);
    }
  });

  /**
   * `Number(null)` and `Number('')` are both 0, so those arrive as a magnitude
   * of zero rather than as an absence — and that is left alone deliberately.
   *
   * A zero magnitude is not a hazard: it plans a zero delta, and a zero delta
   * writes nothing (see `advanceDim` in the planner, which returns early on
   * `delta === 0`). Distinguishing "empty field" from "the number nought" would
   * mean guessing at what the Flow editor sends for an emptied numeric argument,
   * which is not something this repo has established on hardware.
   */
  test('an empty numeric argument arrives as zero, which is harmless', () => {
    const r = registries();
    for (const value of [null, '']) {
      r.calls.length = 0;
      intakeBridgeEvent(
        'bridge_numeric_event',
        { controller: CTRL, event_key: 'k', value },
        args => Number(args.value),
        r.deps,
      );
      assert.equal(r.calls[0]!.magnitude, 0, JSON.stringify(value));
    }
  });

  test('the plain card carries none at all', () => {
    const r = registries();
    const result = intakeBridgeEvent(
      'bridge_event', { controller: CTRL, event_key: 'k', value: 7 }, undefined, r.deps,
    );

    assert.ok(!('magnitude' in r.calls[0]!));
    assert.ok(!('magnitude' in result.record));
  });

  test('zero is a magnitude, not an absence', () => {
    const r = registries();
    const zero = intakeBridgeEvent(
      'bridge_numeric_event',
      { controller: CTRL, event_key: 'k', value: 0 },
      args => Number(args.value),
      r.deps,
    );

    assert.equal(zero.record.magnitude, 0);
  });
});

describe('what the record carries', () => {
  test('everything the settings page and a bug report need, and nothing else', () => {
    const r = registries();
    const { record } = intakeBridgeEvent(
      'bridge_event',
      { controller: CTRL, event_key: 'n2_on|press', unrelated: 'not carried' },
      undefined,
      r.deps,
    );

    assert.deepEqual(record, {
      cardId: 'bridge_event',
      controller: CTRL,
      eventKey: 'n2_on|press',
      accepted: true,
    });
  });

  test('the ids are coerced to strings, whatever the editor put there', () => {
    const r = registries();
    const { record } = intakeBridgeEvent(
      'bridge_event', { controller: 12345, event_key: 678 }, undefined, r.deps,
    );

    assert.equal(record.controller, '12345');
    assert.equal(record.eventKey, '678');
    assert.equal(typeof record.controller, 'string');
  });
});
