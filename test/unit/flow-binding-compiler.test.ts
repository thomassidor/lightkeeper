import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileBinding,
  managedKey,
  RangeExpansionTooLargeError,
  type BridgeCardRefs,
  type CompileRequest,
} from '../../lib/bridge/flow-binding-compiler';
import type { LogicalSourceBinding } from '../../lib/inputs/selectable-input';

const CARDS: BridgeCardRefs = {
  event: { id: 'homey:app:com.thomassidor.lightlink:bridge_event', uri: 'homey:flowcardaction:homey:app:com.thomassidor.lightlink:bridge_event' },
  numeric: { id: 'homey:app:com.thomassidor.lightlink:bridge_numeric_event', uri: 'homey:flowcardaction:homey:app:com.thomassidor.lightlink:bridge_numeric_event' },
  token: { id: 'homey:app:com.thomassidor.lightlink:bridge_token_event', uri: 'homey:flowcardaction:homey:app:com.thomassidor.lightlink:bridge_token_event' },
};

const request = (binding: LogicalSourceBinding, over: Partial<CompileRequest> = {}): CompileRequest => ({
  controllerId: 'ctrl-1',
  bindingKey: 'n2_on|press',
  binding,
  cards: CARDS,
  label: 'Higher brightness — Press',
  sourceName: 'Kitchen STYRBAR',
  ...over,
});

const CARD_ID = 'homey:device:abc:n2_on';
const CARD_URI = 'homey:flowcardtrigger:homey:device:abc:n2_on';

describe('fixed bindings', () => {
  const flows = compileBinding(request({
    kind: 'flow_fixed', cardId: CARD_ID, cardOwnerUri: CARD_URI, args: {},
  }));

  test('produces exactly one flow', () => {
    assert.equal(flows.length, 1);
  });

  test('echoes the trigger card id and uri verbatim, never constructing them', () => {
    assert.equal(flows[0]!.trigger.id, CARD_ID);
    assert.equal(flows[0]!.trigger.uri, CARD_URI);
  });

  test('calls the bridge action with the controller and event key', () => {
    assert.deepEqual(flows[0]!.actions[0]!.args, {
      controller: 'ctrl-1',
      event_key: 'n2_on|press',
    });
  });

  test('names the flow so a user can tell what it is', () => {
    assert.equal(flows[0]!.name, 'Light Link — Kitchen STYRBAR: Higher brightness — Press');
  });
});

describe('enum bindings', () => {
  test('sets the chosen dropdown value on the trigger', () => {
    const flows = compileBinding(request({
      kind: 'flow_enum',
      cardId: 'homey:device:def:dimmerswitch_button_pressed',
      cardOwnerUri: 'homey:flowcardtrigger:homey:device:def:dimmerswitch_button_pressed',
      argument: 'button',
      value: 'on',
    }));

    assert.equal(flows.length, 1);
    assert.deepEqual(flows[0]!.trigger.args, { button: 'on' });
  });
});

describe('token bindings (§6.4)', () => {
  const flows = compileBinding(request({
    kind: 'flow_token',
    cardId: 'homey:device:ghi:tapdial_dial_rotation_stopped',
    cardOwnerUri: 'homey:flowcardtrigger:homey:device:ghi:tapdial_dial_rotation_stopped',
    args: { rotate_direction: 'clock_wise' },
    tokenId: 'steps',
  }));

  test('uses the token bridge card', () => {
    assert.equal(flows[0]!.actions[0]!.id, CARDS.token.id);
  });

  test('puts droptoken at the TOP LEVEL of the action, not inside args', () => {
    const action = flows[0]!.actions[0]!;
    assert.equal(action.droptoken, 'steps');
    assert.equal('droptoken' in action.args, false);
  });

  test('references a trigger-owned token by its bare id', () => {
    assert.equal(flows[0]!.actions[0]!.droptoken, 'steps',
      'a local token is not "<ownerUri>|<tokenId>"');
  });
});

describe('range expansion (§6.4)', () => {
  const rangeBinding = (from: number, to: number): LogicalSourceBinding => ({
    kind: 'flow_range',
    cardId: 'homey:device:jkl:wheel',
    cardOwnerUri: 'homey:flowcardtrigger:homey:device:jkl:wheel',
    argument: 'count',
    valueRange: [from, to],
  });

  test('compiles one flow per value, each carrying its own literal amount', () => {
    const flows = compileBinding(request(rangeBinding(1, 4)));

    assert.equal(flows.length, 4);
    assert.deepEqual(flows.map(f => f.trigger.args.count), ['1', '2', '3', '4']);
    assert.deepEqual(flows.map(f => f.actions[0]!.args.value), [1, 2, 3, 4]);
  });

  test('every variant uses the numeric bridge card', () => {
    const flows = compileBinding(request(rangeBinding(1, 3)));
    assert.ok(flows.every(f => f.actions[0]!.id === CARDS.numeric.id));
  });

  test('variant keys are distinct and stable', () => {
    const flows = compileBinding(request(rangeBinding(1, 3)));
    assert.deepEqual(flows.map(f => f.variantKey), ['range:1', 'range:2', 'range:3']);
  });

  test('declines rather than generating fifty flows', () => {
    assert.throws(
      () => compileBinding(request(rangeBinding(1, 18))),
      RangeExpansionTooLargeError,
      'BILRESA count 1-18 must be refused, not expanded',
    );
  });

  test('honours a custom ceiling', () => {
    assert.throws(
      () => compileBinding(request(rangeBinding(1, 5), { ceiling: 4 })),
      RangeExpansionTooLargeError,
    );
    assert.doesNotThrow(() => compileBinding(request(rangeBinding(1, 4), { ceiling: 4 })));
  });
});

describe('idempotency', () => {
  test('compilation is deterministic', () => {
    const binding: LogicalSourceBinding = {
      kind: 'flow_fixed', cardId: CARD_ID, cardOwnerUri: CARD_URI, args: {},
    };
    assert.deepEqual(compileBinding(request(binding)), compileBinding(request(binding)));
  });

  test('managed keys are unique per controller, binding and variant', () => {
    assert.equal(managedKey('c1', 'b1', 'range:1'), 'c1::b1::range:1');
    assert.notEqual(managedKey('c1', 'b1', 'range:1'), managedKey('c1', 'b1', 'range:2'));
    assert.notEqual(managedKey('c1', 'b1', 'fixed'), managedKey('c2', 'b1', 'fixed'));
  });
});

describe('capability bindings', () => {
  test('need no flow at all (§2.1, interface only in MVP)', () => {
    const flows = compileBinding(request({
      kind: 'direct_capability', capabilityId: 'button', interpreter: 'boolean_press',
    }));
    assert.deepEqual(flows, []);
  });
});
