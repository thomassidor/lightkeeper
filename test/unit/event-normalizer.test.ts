import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCards, actionOf, controlIdentityOf } from '../../lib/inputs/event-normalizer';
import {
  STYRBAR_CARDS, STYRBAR_DEVICE_ID,
  HUE_DIMMER_CARDS, HUE_DIMMER_DEVICE_ID,
  TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID,
  BILRESA_CARDS, BILRESA_DEVICE_ID,
} from '../fixtures/reference-devices';

const labels = (inputs: { label: string }[]) => inputs.map(i => i.label).sort();

describe('IKEA STYRBAR', () => {
  const { inputs } = normalizeCards(STYRBAR_CARDS, { sourceDeviceId: STYRBAR_DEVICE_ID });

  test('offers exactly the six real gestures and no capability cards', () => {
    assert.deepEqual(labels(inputs), [
      'Higher brightness — Long press',
      'Higher brightness — Press',
      'Left button — Press',
      'Lower brightness — Long press',
      'Lower brightness — Press',
      'Right button — Press',
    ]);
  });

  test('groups press and long-press onto ONE control — what the supersede gate needs', () => {
    const up = inputs.filter(i => i.controlId === 'higher_brightness');
    assert.equal(up.length, 2, 'up button should carry both a press and a long press');
    assert.deepEqual(up.map(i => i.action).sort(), ['long_press', 'press']);

    // The supersede gate only engages where one control carries both;
    // left and right must not.
    const right = inputs.filter(i => i.controlId === 'right_button');
    assert.deepEqual(right.map(i => i.action), ['press']);
  });

  test('binds as fixed cards with no arguments', () => {
    for (const input of inputs) {
      assert.equal(input.binding.kind, 'flow_fixed');
      assert.equal(input.carriesMagnitude, false);
    }
  });
});

describe('Philips Hue Dimmer v2', () => {
  const { inputs } = normalizeCards(HUE_DIMMER_CARDS, { sourceDeviceId: HUE_DIMMER_DEVICE_ID });

  test('expands the button dropdown into four separate controls', () => {
    assert.deepEqual(labels(inputs), [
      'Decrease brightness — Press',
      'Increase brightness — Press',
      'Off — Press',
      'On — Press',
    ]);
    assert.equal(new Set(inputs.map(i => i.controlId)).size, 4);
  });

  test('never invents a long press the integration does not expose', () => {
    assert.equal(inputs.some(i => i.action === 'long_press'), false);
  });

  test('binds each value as a flow_enum on the button argument', () => {
    const on = inputs.find(i => i.label === 'On — Press');
    assert.ok(on);
    assert.deepEqual(on.binding, {
      kind: 'flow_enum',
      cardId: `homey:device:${HUE_DIMMER_DEVICE_ID}:dimmerswitch_button_pressed`,
      cardOwnerUri: `homey:flowcardtrigger:homey:device:${HUE_DIMMER_DEVICE_ID}:dimmerswitch_button_pressed`,
      // The selector IS the enum here, so it belongs to the variant rather than
      // to the fixed set — the compiler merges the two and would set it twice.
      fixedArgs: {},
      argument: 'button',
      value: 'on',
    });
  });
});

describe('Philips Hue Tap Dial', () => {
  const { inputs } = normalizeCards(TAP_DIAL_CARDS, { sourceDeviceId: TAP_DIAL_DEVICE_ID });

  test('offers four buttons plus one entry per dial direction', () => {
    assert.deepEqual(labels(inputs), [
      'Button 1 — Press',
      'Button 2 — Press',
      'Button 3 — Press',
      'Button 4 — Press',
      'Dial — Turn left',
      'Dial — Turn right',
    ]);
  });

  test('collapses overlapping rotation cards into one entry per direction', () => {
    // rotation_started and rotation_stopped both describe "turn right".
    const right = inputs.filter(i => i.label === 'Dial — Turn right');
    assert.equal(right.length, 1);
  });

  test('keeps the magnitude-carrying rotation variant, not the bare one', () => {
    const right = inputs.find(i => i.label === 'Dial — Turn right');
    assert.ok(right);
    assert.equal(right.carriesMagnitude, true);
    assert.equal(right.binding.kind, 'flow_token');
    assert.equal((right.binding as { tokenId: string }).tokenId, 'steps');
  });

  test('never offers "either way" as a direction', () => {
    assert.equal(inputs.some(i => /either/i.test(i.label)), false);
  });

  test('all dial entries share one controlId', () => {
    const dial = inputs.filter(i => i.controlId === 'dial');
    assert.equal(dial.length, 2);
    assert.deepEqual(dial.map(i => i.direction).sort(), [-1, 1]);
  });
});

describe('IKEA BILRESA — the count-vs-detent trap', () => {
  const { inputs, rejected } = normalizeCards(BILRESA_CARDS, { sourceDeviceId: BILRESA_DEVICE_ID });

  test('declines the 9x18 multi-press card rather than generating 162 entries', () => {
    const declined = rejected.find(r => r.cardId.endsWith('switch_multi_press_multi'));
    assert.ok(declined, 'switch_multi_press_multi must be rejected');
    assert.match(declined.reason, /above the ceiling/);
  });

  test('never exposes a count value as a picker entry', () => {
    assert.equal(inputs.some(i => /multiple times|count/i.test(i.label)), false);
  });

  test('collapses initial-press and click into one press per button', () => {
    const button3 = inputs.filter(i => i.controlId === 'button:3' && i.action === 'press');
    assert.equal(button3.length, 1);
  });

  test('offers long press only on the three buttons that support it', () => {
    const held = inputs.filter(i => i.action === 'long_press').map(i => i.controlId).sort();
    assert.deepEqual(held, ['button:3', 'button:6', 'button:9']);
  });
});

describe('gesture classification', () => {
  test('"long pressed" is a hold, not a press', () => {
    assert.equal(actionOf({
      id: 'x', shortId: 'n2_dim_up', uri: 'x',
      title: 'Higher brightness was long pressed', args: [], tokens: [],
    }), 'long_press');
  });

  test('"stops rotating" is a rotate stop, not a release', () => {
    assert.equal(actionOf({
      id: 'x', shortId: 'tapdial_dial_rotation_stopped', uri: 'x',
      title: 'Dial stops rotating', args: [], tokens: [],
    }), 'rotate_stop');
  });

  test('unrecognised semantics return null rather than a guess', () => {
    assert.equal(actionOf({
      id: 'x', shortId: 'something_odd', uri: 'x',
      title: 'The vibe changed', args: [], tokens: [],
    }), null);
  });

  test('a dial is identified however the card is worded', () => {
    assert.deepEqual(controlIdentityOf({
      id: 'x', shortId: 'tapdial_dial_rotation_started', uri: 'x',
      title: 'Dial rotated', args: [], tokens: [],
    }, 'rotate_stop'), { id: 'dial', label: 'Dial' });
  });

  test('a vendor prefix containing "dial" does not turn buttons into a dial', () => {
    assert.deepEqual(controlIdentityOf({
      id: 'x', shortId: 'tapdial_button_pressed', uri: 'x',
      title: 'A button is pressed', args: [], tokens: [],
    }, 'press'), { id: 'button', label: 'Button' });
  });
});
