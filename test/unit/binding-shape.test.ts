import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCards, type DiscoveredTriggerCard } from '../../lib/inputs/event-normalizer';
import { numericValuesOf } from '../../lib/inputs/magnitude-collapser';
import {
  compileBinding, findUncompilableBindings,
  InvalidRangeError, RangeExpansionTooLargeError,
  type BridgeCardRefs,
} from '../../lib/bridge/flow-binding-compiler';
import type { LogicalSourceBinding } from '../../lib/inputs/selectable-input';
import { migrateProfile } from '../../lib/profiles/migrations';
import { CURRENT_SCHEMA_VERSION } from '../../lib/profiles/controller-profile';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';

/**
 * A binding's job is to say EXACTLY which event on which control this is, and
 * two things stopped it doing that.
 *
 * The trigger arguments that pin an event down — which button, which way — used
 * to reach three of the four flow kinds. `flow_range` took the magnitude argument
 * alone, so a card with a selector AND a direction AND an enumerated step
 * compiled into one flow per step, none of them naming the button or the
 * direction: every variant fired on every control of the remote.
 *
 * And a range was stored as `[min, max]`, which cannot tell {1, 2, 3} from
 * {1, 3}. Walking the second one invents a flow asking the card for a value it
 * does not accept, which `createFlow` refuses with a 404 that reads like a
 * permission problem.
 */

const CARDS: BridgeCardRefs = {
  event: { id: 'app:bridge_event', uri: 'homey:flowcardaction:app:bridge_event' },
  numeric: { id: 'app:bridge_numeric_event', uri: 'homey:flowcardaction:app:bridge_numeric_event' },
  token: { id: 'app:bridge_token_event', uri: 'homey:flowcardaction:app:bridge_token_event' },
};

const DEVICE = 'wheel-0000-0000-0000-000000000001';

/**
 * A card with all three dimensions at once: a button selector, a rotation
 * direction, and an enumerated step count.
 *
 * Not one of the four reference devices — none of them exposes all three — but
 * the shape is not exotic: BILRESA already ships a selector plus an enumerated
 * count, and the Tap Dial a direction plus a magnitude. One integration
 * combining them is exactly the case the old code could not express.
 */
const THREE_DIMENSION_CARD: DiscoveredTriggerCard = {
  id: `homey:device:${DEVICE}:scrollwheel_rotation_started`,
  shortId: 'scrollwheel_rotation_started',
  uri: `homey:flowcardtrigger:homey:device:${DEVICE}:scrollwheel_rotation_started`,
  title: 'A wheel was rotated',
  args: [
    { name: 'button', type: 'dropdown', values: [{ id: '1' }, { id: '2' }] },
    {
      name: 'rotate_direction',
      type: 'dropdown',
      values: [{ id: 'clock_wise' }, { id: 'counter_clock_wise' }],
    },
    { name: 'steps', type: 'dropdown', values: [{ id: '1' }, { id: '2' }, { id: '3' }] },
  ],
  tokens: [],
};

describe('every compiled variant carries every fixed argument', () => {
  const { inputs } = normalizeCards([THREE_DIMENSION_CARD], { sourceDeviceId: DEVICE });

  test('two buttons times two directions is four selectable inputs', () => {
    assert.equal(inputs.length, 4);
    // The step count is collapsed into magnitude and never reaches the picker.
    assert.equal(inputs.some(i => /step/i.test(i.label)), false);
  });

  test('the binding keeps the selector and the direction alongside the range', () => {
    const binding = inputs[0].binding as Extract<LogicalSourceBinding, { kind: 'flow_range' }>;
    assert.equal(binding.kind, 'flow_range');
    assert.equal(binding.argument, 'steps');
    assert.deepEqual(binding.values, [1, 2, 3]);
    assert.deepEqual(Object.keys(binding.fixedArgs).sort(), ['button', 'rotate_direction']);
  });

  test('and so does every flow it compiles to — the actual bug', () => {
    for (const input of inputs) {
      const flows = compileBinding({
        controllerId: 'lk-ctrl-1',
        bindingKey: input.key,
        binding: input.binding,
        cards: CARDS,
        label: input.label,
        sourceName: 'Scroll wheel',
      });

      assert.equal(flows.length, 3, `${input.label} should compile to one flow per step`);
      for (const flow of flows) {
        assert.deepEqual(
          Object.keys(flow.trigger.args).sort(),
          ['button', 'rotate_direction', 'steps'],
          `${input.label} / ${flow.variantKey} lost an argument`,
        );
      }
    }
  });

  test('the four inputs compile to twelve DISTINCT triggers', () => {
    const seen = new Set<string>();
    for (const input of inputs) {
      for (const flow of compileBinding({
        controllerId: 'lk-ctrl-1',
        bindingKey: input.key,
        binding: input.binding,
        cards: CARDS,
        label: input.label,
        sourceName: 'Scroll wheel',
      })) {
        seen.add(JSON.stringify(flow.trigger.args));
      }
    }
    // Without the fix there were three distinct triggers, repeated four times —
    // which is what made every variant fire on every control.
    assert.equal(seen.size, 12);
  });

  test('token and fixed bindings are unchanged in shape', () => {
    const token: LogicalSourceBinding = {
      kind: 'flow_token',
      cardId: 'homey:device:x:rot_stopped',
      cardOwnerUri: 'homey:flowcardtrigger:homey:device:x:rot_stopped',
      fixedArgs: { rotate_direction: 'clock_wise' },
      tokenId: 'steps',
    };
    const [flow] = compileBinding({
      controllerId: 'lk-ctrl-1',
      bindingKey: 'k',
      binding: token,
      cards: CARDS,
      label: 'Dial — Turn right',
      sourceName: 'Tap Dial',
    });
    assert.deepEqual(flow.trigger.args, { rotate_direction: 'clock_wise' });
    assert.equal(flow.actions[0].droptoken, 'steps');
    assert.equal(flow.variantKey, 'token');
  });

  test('an enum binding sets its value once, not twice', () => {
    const [flow] = compileBinding({
      controllerId: 'lk-ctrl-1',
      bindingKey: 'k',
      binding: {
        kind: 'flow_enum',
        cardId: 'homey:device:x:button_pressed',
        cardOwnerUri: 'homey:flowcardtrigger:homey:device:x:button_pressed',
        fixedArgs: {},
        argument: 'button',
        value: 'on',
      },
      cards: CARDS,
      label: 'On — Press',
      sourceName: 'Hue Dimmer',
    });
    assert.deepEqual(flow.trigger.args, { button: 'on' });
    // The variant key still carries the value: reuse is keyed on it, and a
    // controller's stored references must keep matching across this change.
    assert.equal(flow.variantKey, 'enum:on');
  });
});

describe('exact enumerated values, not endpoints', () => {
  const range = (values: number[]): LogicalSourceBinding => ({
    kind: 'flow_range',
    cardId: 'homey:device:x:wheel',
    cardOwnerUri: 'homey:flowcardtrigger:homey:device:x:wheel',
    fixedArgs: {},
    argument: 'count',
    values,
  });

  const compile = (binding: LogicalSourceBinding, ceiling?: number) => compileBinding({
    controllerId: 'lk-ctrl-1',
    bindingKey: 'k',
    binding,
    cards: CARDS,
    label: 'Wheel — Turn',
    sourceName: 'Wheel',
    ...(ceiling !== undefined ? { ceiling } : {}),
  });

  test('a sparse set compiles to exactly its own values', () => {
    const flows = compile(range([1, 3]));
    assert.equal(flows.length, 2, 'no invented 2');
    assert.deepEqual(flows.map(f => f.trigger.args.count), ['1', '3']);
    assert.deepEqual(flows.map(f => f.actions[0].args.value), [1, 3]);
  });

  test('decimals survive, which endpoints could not express at all', () => {
    const flows = compile(range([0.5, 1]));
    assert.deepEqual(flows.map(f => f.trigger.args.count), ['0.5', '1']);
    assert.deepEqual(flows.map(f => f.variantKey), ['range:0.5', 'range:1']);
  });

  test('the ceiling counts values, not the span between endpoints', () => {
    // Two values a thousand apart is two flows, not a thousand.
    assert.equal(compile(range([1, 1000])).length, 2);
    assert.throws(
      () => compile(range([1, 2, 3, 4]), 3),
      (error: unknown) => error instanceof RangeExpansionTooLargeError,
    );
  });

  test('a corrupted range refuses rather than compiling to nothing', () => {
    // The old loop over [NaN, NaN] was not an error — it was an empty loop, and
    // the control silently stopped working with nothing anywhere to read.
    for (const bad of [[], [Number.NaN], [1, Number.POSITIVE_INFINITY]]) {
      assert.throws(
        () => compile(range(bad)),
        (error: unknown) => error instanceof InvalidRangeError,
        JSON.stringify(bad),
      );
    }
  });

  test('the preflight declines a corrupted range instead of throwing', () => {
    const declined = findUncompilableBindings(
      [{ key: 'k', label: 'Wheel — Turn', binding: range([]) }],
      new Set(['k']),
      'Wheel',
    );
    assert.equal(declined.length, 1);
    assert.match(declined[0].reason, /cannot be expanded/);
  });

  test('numericValuesOf sorts, de-duplicates and refuses non-numbers', () => {
    const arg = (ids: string[]) => ({
      name: 'count', type: 'dropdown', values: ids.map(id => ({ id })),
    });
    assert.deepEqual(numericValuesOf(arg(['3', '1', '2'])), [1, 2, 3]);
    assert.deepEqual(numericValuesOf(arg(['2', '2', '1'])), [1, 2]);
    assert.deepEqual(numericValuesOf(arg(['0.5', '1.0'])), [0.5, 1]);
    assert.equal(numericValuesOf(arg(['1', 'many'])), null);
    assert.equal(numericValuesOf(arg([])), null);
  });
});

describe('the controller profile chain, after the reset', () => {
  /**
   * Emptied with the other four as part of the pairing rewrite. This one changed
   * because a mapping rule gained a `preset` — the value a "set brightness"
   * button needs, which no earlier profile can supply for a rule it does not
   * have.
   *
   * `args` → `fixedArgs` and the range expansion went with the table. Both are
   * still covered where it matters: `validateBinding` refuses a binding with no
   * `fixedArgs`, and that refusal is what quarantines an older profile here.
   */
  const CURRENT = () => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: true,
    source: { deviceId: 'remote-1', eventSurfaceFingerprint: 'fp' },
    target: { kind: 'devices', deviceIds: ['l1'] },
    mappings: [{ id: 'r1', function: 'toggle', inputKey: 'k1', target: null }],
    behavior: DEFAULT_BEHAVIOR,
    managedFlows: [],
  });

  test('a current profile passes through untouched', () => {
    const stored = CURRENT();
    const { plan, migrated, steps } = migrateProfile(stored);
    assert.equal(migrated, false);
    assert.deepEqual(steps, []);
    assert.deepEqual(plan, stored as never);
  });

  test('a profile from before the reset is quarantined, not guessed at', () => {
    assert.throws(() => migrateProfile({ ...CURRENT(), schemaVersion: undefined }));
    assert.throws(() => migrateProfile({ ...CURRENT(), schemaVersion: 0 }));
  });

  test('a profile from a NEWER build is refused rather than downgraded', () => {
    assert.throws(() => migrateProfile({
      ...CURRENT(), schemaVersion: CURRENT_SCHEMA_VERSION + 1,
    }));
  });

  test('the chain still ends in its validator', () => {
    // A `brightness_set` with no preset is the rule this chain's reset was
    // about: a button whose job is "a set brightness", carrying no brightness.
    assert.throws(() => migrateProfile({
      ...CURRENT(),
      mappings: [{ id: 'r1', function: 'brightness_set', inputKey: 'k1', target: null }],
    }), /cannot run without one/);
  });
});
