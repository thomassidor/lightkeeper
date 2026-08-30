import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileBinding, findUncompilableBindings, RangeExpansionTooLargeError,
} from '../../lib/bridge/flow-binding-compiler';
import type { SelectableInput } from '../../lib/inputs/selectable-input';

/**
 * A control the flow compiler declines.
 *
 * The ceiling exists for a real device: BILRESA's `switch_multi_press_multi`
 * is 9 buttons x 18 counts = 162 flow variants, thirteen times over
 * (platform §7). Declining it is right — filling somebody's Flow list with
 * 162 generated rows would be worse — but until now the decline went to the
 * app log and nowhere else. The user finished pairing, the mapping row said
 * the control was configured, and the gesture did nothing.
 *
 * Two places now say so:
 *
 *   at SAVE       the pairing screen refuses, naming the control, while the
 *                 user is still looking at it
 *   at RECONCILE  the device goes to needs_repair with state.unsupportedMapping
 *                 — for a profile that compiled once and stopped, e.g. after a
 *                 re-attach onto a device with a wider range
 */

const CARD = { id: 'preflight', uri: 'preflight' };
const cards = { event: CARD, numeric: CARD, token: CARD };

function rangeInput(key: string, from: number, to: number): SelectableInput {
  return {
    key,
    controlId: 'wheel',
    label: 'Scroll wheel — Turn',
    action: 'rotate_delta',
    carriesMagnitude: false,
    binding: {
      kind: 'flow_range',
      cardId: 'homey:device:bilresa:switch_multi_press_multi',
      cardOwnerUri: 'homey:flowcardtrigger:homey:device:bilresa:switch_multi_press_multi',
      argument: 'count',
      values: Array.from({ length: to - from + 1 }, (_, i) => from + i),
    },
  } as SelectableInput;
}

function compile(input: SelectableInput) {
  return compileBinding({
    controllerId: 'lk-ctrl-1755500000000-100001',
    bindingKey: input.key,
    binding: input.binding,
    cards,
    label: input.label,
    sourceName: 'BILRESA',
  });
}

describe('the range expansion ceiling', () => {

  test('a range within the ceiling compiles to one flow per value', () => {
    const flows = compile(rangeInput('wheel|turn', 1, 4));
    assert.equal(flows.length, 4);
  });

  test('a range at exactly the ceiling still compiles', () => {
    assert.equal(compile(rangeInput('wheel|turn', 1, 12)).length, 12);
  });

  test('one over the ceiling is declined, and says how far over', () => {
    assert.throws(
      () => compile(rangeInput('wheel|turn', 1, 13)),
      (error: unknown) => {
        assert.ok(error instanceof RangeExpansionTooLargeError);
        assert.equal(error.variants, 13);
        assert.equal(error.ceiling, 12);
        return true;
      },
    );
  });

  test("BILRESA's 18 counts are declined — the case the ceiling exists for", () => {
    assert.throws(() => compile(rangeInput('wheel|turn', 1, 18)), RangeExpansionTooLargeError);
  });
});

/**
 * The pairing screen's own check.
 *
 * Pure and offline: `compileBinding` needs no Homey, no API key and no cards
 * that exist, because the card refs are read only for an `id` and `uri` to
 * echo into a flow this throws away. Nothing here can reach a real flow, which
 * is the one thing platform §3's "never construct a card URI" protects.
 *
 * It returns the declined inputs and no sentence — `lib/` cannot translate
 * one, so the driver phrases it from `mapping.unsupportedControl`.
 */
describe('the pairing screen refuses a save it cannot build', () => {

  const preflight = (catalogue: SelectableInput[], mappedKeys: string[]) =>
    findUncompilableBindings(catalogue, new Set(mappedKeys), 'BILRESA');

  test('a mapped control over the ceiling is declined, and named', () => {
    const declined = preflight([rangeInput('wheel|turn', 1, 18)], ['wheel|turn']);

    assert.equal(declined.length, 1);
    assert.equal(declined[0]!.bindingKey, 'wheel|turn');
    assert.equal(declined[0]!.label, 'Scroll wheel — Turn', 'the control as the user saw it');
    assert.match(declined[0]!.reason, /18 flow variants/, 'and why');
  });

  test('the same control left UNMAPPED does not block the save', () => {
    // Discovery offers every event surface it finds; only what the user
    // actually assigned has to compile.
    assert.deepEqual(preflight([rangeInput('wheel|turn', 1, 18)], []), []);
  });

  test('a workable mapping is not declined', () => {
    assert.deepEqual(preflight([rangeInput('wheel|turn', 1, 4)], ['wheel|turn']), []);
  });

  test('every declined control is reported, not just the first', () => {
    const declined = preflight(
      [rangeInput('wheel|turn', 1, 18), rangeInput('wheel|back', 1, 20)],
      ['wheel|turn', 'wheel|back'],
    );

    assert.equal(declined.length, 2);
    assert.match(declined[0]!.reason, /18 flow variants/);
    assert.match(declined[1]!.reason, /20 flow variants/);
  });

  test('a mix reports only the ones that failed', () => {
    const declined = preflight(
      [rangeInput('wheel|fine', 1, 3), rangeInput('wheel|coarse', 1, 30)],
      ['wheel|fine', 'wheel|coarse'],
    );

    assert.deepEqual(declined.map(item => item.bindingKey), ['wheel|coarse']);
  });

  test('the sentence the driver builds names the control and the fix', () => {
    // Not the driver's own code — it needs a Homey — but the string it feeds,
    // so a locale edit that dropped either token would fail here.
    const en = require('../../locales/en.json') as any;
    const template = String(en.mapping.unsupportedControl);

    assert.match(template, /__controls__/, 'the control has to be nameable');
    assert.match(template, /Assign that control to something else/, 'and the user told what to do');
  });
});
