import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEAVE_ALONE,
  intentsFor,
  resolveSources,
  settingsFrom,
  type ColourSource,
  type SourceRegistry,
  type ValueSource,
} from '../../lib/outputs/lightkeeper-settings';
import {
  isLightkeeperPreset, namesASource, FUNCTION_CAPABILITY, FUNCTION_PRESET,
} from '../../lib/mapping/mapping-types';
import { intentForLightFunction, availableFunctions } from '../../lib/mapping/mapping-engine';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import {
  isSourceKind, sourceColour, sourceLevel, sourceRows,
} from '../../lib/pairing/source-picker';
import { toDevice } from '../../lib/outputs/light-intent';

/**
 * "On – with Lightkeeper": a button that comes on the way the rest of the house
 * already knows it should look.
 *
 * Three promises are why this is a file rather than a few assertions bolted on
 * to the mapping suite.
 *
 *  - **A chosen device that is not running degrades to plain "on", never to
 *    nothing and never to half.** The opposite of what the Flow card does with
 *    the same finding, and both are right: a card reports `false` somewhere a
 *    person can read it, a button press reports nowhere at all, so refusing is
 *    indistinguishable from a broken remote.
 *  - **The colour list and the brightness list are different lists**, and every
 *    place that asks — the card's autocompletes, the pairing picker, and the
 *    press itself — has to agree, or a screen offers a device the press will
 *    then call missing.
 *  - **The screen's percentages are perceptual and the board's are not.** The
 *    published brightness is a device value through γ = 2.2, and drawing it raw
 *    beside the job screen's own slider would put two axes under one sign.
 */

function source(values: Record<string, unknown>): ValueSource {
  return { publishedValues: () => values as any };
}

function curve(
  values: Record<string, unknown>,
  color?: { hue: number; saturation: number },
): ColourSource {
  return {
    publishedValues: () => values as any,
    currentValue: () => (color ? { color } : {}),
  };
}

/** The four registries, as the two questions a press asks of them. */
function registry(
  colours: Record<string, ColourSource>,
  brightnesses: Record<string, ValueSource> = {},
): SourceRegistry {
  return {
    colour: id => colours[id],
    brightness: id => brightnesses[id] ?? colours[id],
  };
}

describe('the job itself', () => {
  test('it is a job, it needs a value, and it is offered where a lamp switches on', () => {
    assert.equal(FUNCTION_CAPABILITY.lightkeeper_on, 'onoff');
    assert.equal(FUNCTION_PRESET.lightkeeper_on, 'lightkeeper');

    // On the power gate rather than `dim`: a plain switched lamp in the same
    // room keeps the job, and the planner skips the brightness half for it.
    assert.ok(availableFunctions({ onoff: 1, dim: 0, light_temperature: 0, light_hue: 0 })
      .includes('lightkeeper_on'));
  });

  test('the pure translator degrades to "on", because it cannot reach a runtime', () => {
    /**
     * The one arm of `intentForLightFunction` that is a fallback rather than a
     * behaviour. It is reached by the app's HTTP test route and by anything else
     * that translates a function without a live registry, and it has to stay
     * truthful: a `throw` would turn "the curve is not running" into a button
     * that does nothing, which is the failure this whole app exists to prevent.
     */
    assert.deepEqual(
      intentForLightFunction('lightkeeper_on', DEFAULT_BEHAVIOR, 1, {
        colourSource: 'lk-curve-1', brightnessSource: LEAVE_ALONE, pressAgainOff: true,
      }),
      { type: 'power', value: true },
    );
  });

  test('a preset naming neither source is recognisable as an answer to nothing', () => {
    const none = { colourSource: LEAVE_ALONE, brightnessSource: LEAVE_ALONE, pressAgainOff: true };
    assert.ok(isLightkeeperPreset(none), 'still a lightkeeper preset — both ids are always stored');
    assert.equal(namesASource(none), false);
    assert.ok(namesASource({ ...none, brightnessSource: 'lk-daylight-1' }));
  });

  test('the union narrows on a field only this kind has', () => {
    // The discriminator has to survive a preset with neither source set, which
    // is why both ids are stored rather than left off when unanswered.
    assert.ok(!isLightkeeperPreset({ brightness: 0.5 }));
    assert.ok(!isLightkeeperPreset({ color: 'amber' }));
  });
});

describe('resolving the two chosen devices', () => {
  test('"leave it alone" is not a missing device', () => {
    const sources = resolveSources(registry({}), LEAVE_ALONE, LEAVE_ALONE);
    assert.deepEqual(sources, { colour: null, brightness: null, missing: [] });
  });

  test('a device that is not running lands in missing, once', () => {
    const sources = resolveSources(registry({}), 'lk-curve-gone', 'lk-daylight-gone');
    assert.deepEqual(sources.missing, ['lk-curve-gone', 'lk-daylight-gone']);
    assert.equal(sources.colour, null);
    assert.equal(sources.brightness, null);
  });

  test('a colour source is looked up in the colour registry and nowhere else', () => {
    /**
     * The rule the three call sites have to agree about: only a curve-driven
     * device computes a hue, and only a curve-driven device publishes a warmth
     * it is actively driving. A Room-sensing Light publishes neither, so asking
     * it for a colour must come back missing rather than silently null — null
     * would write the brightness in last week's colour, which is the outcome
     * both callers refuse in their own way.
     */
    const brightnessOnly = source({ [VALUE_CAPABILITIES.brightness]: 0.5 });
    const sources = resolveSources(
      registry({}, { 'lk-daylight-1': brightnessOnly }), 'lk-daylight-1', 'lk-daylight-1',
    );
    assert.deepEqual(sources.missing, ['lk-daylight-1']);
    assert.equal(sources.brightness, brightnessOnly);
  });

  test('anything that is not a string is "leave it alone", not a missing device', () => {
    // A stored preset reaches this from a pair session, which is a scriptable
    // Web API surface (platform §14). Junk must not become a refusal that hides
    // the brightness the other half chose.
    for (const junk of [undefined, null, 42, {}, '']) {
      assert.deepEqual(resolveSources(registry({}), junk, junk).missing, []);
    }
  });
});

describe('what one press is made of', () => {
  test('the switch first, then the colour, then the level', () => {
    /**
     * The order is what makes one submit an ordered burst: `WRITE_ORDER` inside
     * the queue puts `light_mode` ahead of the hue it enables and `onoff` ahead
     * of the level, and it can only order writes it is given at once. A press
     * that submitted these one at a time would reproduce, inside one button,
     * the stepping three built-in Flow cards produce.
     */
    const sources = resolveSources(
      registry(
        { 'lk-curve-1': curve({ [VALUE_CAPABILITIES.temperature]: 0.86 }, { hue: 0.1, saturation: 0.6 }) },
        { 'lk-daylight-1': source({ [VALUE_CAPABILITIES.brightness]: 0.26 }) },
      ),
      'lk-curve-1', 'lk-daylight-1',
    );

    assert.deepEqual(intentsFor(settingsFrom(sources), 'on'), [
      { type: 'power', value: true },
      { type: 'color_absolute', hue: 0.1, saturation: 0.6 },
      { type: 'brightness_absolute', value: 0.26 },
    ]);
  });

  test('a warmth stretch of the curve sends a warmth instead, never both', () => {
    const sources = resolveSources(
      registry(
        { 'lk-curve-1': curve({ [VALUE_CAPABILITIES.temperature]: 0.86 }) },
        { 'lk-sched-1': source({ [VALUE_CAPABILITIES.brightness]: 0.5 }) },
      ),
      'lk-curve-1', 'lk-sched-1',
    );

    const intents = intentsFor(settingsFrom(sources), 'on');
    assert.ok(intents.some(intent => intent.type === 'temperature_absolute'));
    assert.ok(!intents.some(intent => intent.type === 'color_absolute'),
      'a lamp told both ends up wherever its mode handling leaves it');
  });

  test('one source alone still produces a pass', () => {
    // Half the buttons this job is for: the level follows the room and the
    // colour is left to the lamps, or the other way round.
    const sources = resolveSources(
      registry({}, { 'lk-daylight-1': source({ [VALUE_CAPABILITIES.brightness]: 0.26 }) }),
      LEAVE_ALONE, 'lk-daylight-1',
    );

    assert.deepEqual(intentsFor(settingsFrom(sources), 'on'), [
      { type: 'power', value: true },
      { type: 'brightness_absolute', value: 0.26 },
    ]);
  });

  test('a source that is running but publishing nothing is still a switch-on', () => {
    // A curve between plans publishes null on every axis. The lamps still come
    // on, because "on" is what the button says on it.
    const sources = resolveSources(
      registry({ 'lk-curve-1': curve({ [VALUE_CAPABILITIES.temperature]: null }) }),
      'lk-curve-1', LEAVE_ALONE,
    );

    assert.deepEqual(intentsFor(settingsFrom(sources), 'on'), [{ type: 'power', value: true }]);
  });

  test('the job is always the "on" branch, so no target is ever filtered out', () => {
    /**
     * The `set_lights` card offers "only lights already on" and enforces it on
     * the targets. This job does not offer it at all: a button called "On" that
     * declined to switch a lamp on would be a button that does nothing in the
     * one situation anybody presses it in.
     */
    const intents = intentsFor(
      { brightness: 0.26, temperature: null, colour: null }, 'on',
    );
    assert.deepEqual(intents[0], { type: 'power', value: true });
  });
});

describe('the picker behind each row', () => {
  test('a level is drawn on the axis every other percentage in pairing uses', () => {
    /**
     * `lightkeeper_brightness` is published as a DEVICE value. A curve set to
     * 40% publishes `toDevice(0.4)` ≈ 0.13, and drawing that as "13%" beside
     * the job screen's own 40% slider would leave somebody with two numbers for
     * one setting and no way to tell which was lying.
     */
    const level = sourceLevel({ [VALUE_CAPABILITIES.brightness]: toDevice(0.4) } as any);
    assert.ok(level !== null && Math.abs(level - 0.4) < 1e-9);
  });

  test('a level that is not a number is absent rather than dark', () => {
    // `Number(null)` is 0 and 0 is a legitimate reading on this axis, so the
    // guard is explicit — the same trap `lib/daylight/` closes on the way in.
    for (const junk of [null, undefined, 'bright', NaN]) {
      assert.equal(sourceLevel({ [VALUE_CAPABILITIES.brightness]: junk } as any), null);
    }
  });

  test('a colour wins over a warmth, and a warmth over nothing', () => {
    assert.deepEqual(
      sourceColour({} as any, { warmth: 0.8, color: { hue: 0.1, saturation: 0.6 } }),
      { colour: { hue: 0.1, saturation: 0.6 } },
    );
    assert.deepEqual(sourceColour({} as any, { warmth: 0.8 }), { warmth: 0.8 });
    assert.deepEqual(
      sourceColour({ [VALUE_CAPABILITIES.temperature]: 0.4 } as any, null),
      { warmth: 0.4 },
      'a schedule has no currentValue(), so its published warmth is the answer',
    );
    assert.equal(sourceColour({} as any, null), null,
      'nothing to show is null, so the row draws an empty ring rather than a grey one');
  });

  test('"leave it alone" leads the list and carries no value of its own', () => {
    /**
     * Names chosen to sort the same way in every collation this test might run
     * under, which is not a detail: the machine this was written on collates
     * Danish, where "Aa" is "Å" and sorts AFTER Z. A fixture named
     * "Aardvark" and "Zebra" therefore proved the opposite of what it asserted.
     */
    const rows = sourceRows('brightness', [
      { id: 'b', name: 'Second', subtitle: 'Light schedule', values: {} as any },
      { id: 'a', name: 'First', subtitle: 'Room-sensing Light', values: {} as any },
    ], { name: 'Leave it alone', subtitle: 'Do not set this at all' });

    assert.deepEqual(rows.map(row => row.id), [LEAVE_ALONE, 'a', 'b']);
    assert.equal(rows[0]!.level, undefined,
      'it is not a setup, so an empty bar beside it would read as one producing nothing');
    assert.equal(rows[1]!.level, null, 'a setup that published nothing has a level, and it is null');
  });

  test('the colour list carries swatches and the brightness list carries levels', () => {
    const devices = [{
      id: 'lk-curve-1', name: 'Evening curve', subtitle: 'Colour Curve Light · Living room',
      values: {} as any, current: { warmth: 0.8, color: { hue: 0, saturation: 1 } },
    }];

    const colour = sourceRows('colour', devices, { name: 'n', subtitle: 's' })[1]!;
    assert.ok(typeof colour.swatch === 'string' && colour.swatch.startsWith('hsl('));
    assert.equal(colour.level, undefined);

    const brightness = sourceRows('brightness', devices, { name: 'n', subtitle: 's' })[1]!;
    assert.equal(brightness.swatch, undefined);
    assert.equal(brightness.level, null);
  });

  test('only the two questions this app asks open a picker', () => {
    // A pair session is a scriptable Web API surface (platform §14), so a third
    // kind would open a screen for a question nothing can answer.
    assert.ok(isSourceKind('colour') && isSourceKind('brightness'));
    for (const junk of ['warmth', '', null, 0]) assert.ok(!isSourceKind(junk));
  });
});
