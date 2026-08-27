import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hasBeenUserEdited } from '../../lib/bridge/flow-bridge-manager';
import type { CompiledFlow } from '../../lib/bridge/flow-binding-compiler';

/**
 * The promise is "a Flow you have edited is never overwritten", and it is only
 * as good as what counts as an edit.
 *
 * Two ways of saying "not this one" used to read as untouched, both of them
 * the obvious thing a person would do in the Flow editor:
 *
 *   switching the flow OFF        — the flow stayed off and the app went on
 *                                   saying the gesture was configured
 *   adding a CONDITION            — "only after sunset" survived until the
 *                                   binding changed, and was then thrown away
 *                                   with the flow that carried it
 *
 * And two ways that must NOT count, because the folder migration depends on
 * them not counting (platform §11): renaming a flow, and moving it.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const CARD = `${APP_ID}:bridge_event`;

const expected: CompiledFlow = {
  variantKey: 'fixed',
  name: 'Lightkeeper — STYRBAR: Up — Press',
  trigger: { id: 'homey:device:remote-1:n2_on', uri: 'homey:flowcardtrigger:homey:device:remote-1:n2_on', args: {} },
  actions: [{
    id: CARD,
    uri: `homey:flowcardaction:${CARD}`,
    group: 'then',
    args: { controller: 'lk-ctrl-1755500000000-100001', event_key: 'n2_on|press' },
  }],
};

/** Exactly what we would have written, as Homey serialises it back. */
function asWritten(over: Record<string, unknown> = {}) {
  return {
    id: 'flow-1',
    name: expected.name,
    enabled: true,
    folder: 'folder-1',
    conditions: [],
    trigger: { ...expected.trigger, args: {} },
    actions: [{ ...expected.actions[0]!, droptoken: null }],
    ...over,
  };
}

describe('what counts as a user edit', () => {

  test('an untouched flow is untouched', () => {
    assert.equal(hasBeenUserEdited(asWritten(), expected), false);
  });

  test('a DISABLED flow is an edit', () => {
    // Nothing in this app ever disables a flow, so `false` can only be a
    // person saying "not this one".
    assert.equal(hasBeenUserEdited(asWritten({ enabled: false }), expected), true);
  });

  test('a flow with no `enabled` field at all is not an edit', () => {
    // Homey may simply omit it. Absent is not disabled, and reading it as
    // disabled would send every device on such a firmware to repair.
    const flow = asWritten();
    delete (flow as Record<string, unknown>).enabled;
    assert.equal(hasBeenUserEdited(flow, expected), false);
  });

  test('a flow given a CONDITION is an edit', () => {
    assert.equal(hasBeenUserEdited(asWritten({
      conditions: [{ id: 'homey:manager:logic:variable', args: {} }],
    }), expected), true);
  });

  test('a missing conditions array is not an edit', () => {
    const flow = asWritten();
    delete (flow as Record<string, unknown>).conditions;
    assert.equal(hasBeenUserEdited(flow, expected), false);
  });

  test('a RENAMED flow is still ours, and is reused in place', () => {
    // Load-bearing: placeExisting() distinguishes "still where we left it"
    // from "the user filed this somewhere" and would break if a rename
    // dragged a flow back into our folder (platform §11).
    assert.equal(hasBeenUserEdited(asWritten({ name: 'Kitchen up button' }), expected), false);
  });

  test('a MOVED flow is still ours, and is reused in place', () => {
    assert.equal(hasBeenUserEdited(asWritten({ folder: 'the-users-own-folder' }), expected), false);
  });

  test('a changed trigger card is an edit', () => {
    assert.equal(hasBeenUserEdited(asWritten({
      trigger: { id: 'homey:device:other:n2_off', uri: 'x', args: {} },
    }), expected), true);
  });

  test('a changed trigger ARGUMENT is an edit', () => {
    // The schedule case: the user retimed it in the Flow editor. Trigger id
    // and our action arguments are both untouched.
    const timed: CompiledFlow = {
      ...expected,
      trigger: { id: 'homey:manager:cron:time_exactly', uri: 'x', args: { time: '22:00' } },
    };
    const live = asWritten({
      trigger: { id: 'homey:manager:cron:time_exactly', uri: 'x', args: { time: '06:30' } },
    });
    assert.equal(hasBeenUserEdited(live, timed), true);
  });

  test('a SECOND action is an edit', () => {
    assert.equal(hasBeenUserEdited(asWritten({
      actions: [
        { ...expected.actions[0]!, droptoken: null },
        { id: 'homey:manager:notifications:create_notification', args: {} },
      ],
    }), expected), true);
  });

  test('a changed action argument is an edit', () => {
    assert.equal(hasBeenUserEdited(asWritten({
      actions: [{ ...expected.actions[0]!, args: { controller: 'somebody-else', event_key: 'n2_on|press' }, droptoken: null }],
    }), expected), true);
  });

  test('extra trigger arguments Homey echoed back are not an edit', () => {
    // Only the keys we generated are compared: a superset is not an edit.
    assert.equal(hasBeenUserEdited(asWritten({
      trigger: { ...expected.trigger, args: { somethingHomeyAdded: true } },
    }), expected), false);
  });

  test('no live flow is not an edit', () => {
    assert.equal(hasBeenUserEdited(null, expected), false);
    assert.equal(hasBeenUserEdited(undefined, expected), false);
  });
});
