import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCards } from '../../lib/inputs/event-normalizer';
import { localiseInputLabel, localisedInputLine, GESTURE_WORDS } from '../../lib/inputs/input-label';
import {
  STYRBAR_CARDS, STYRBAR_DEVICE_ID, HUE_DIMMER_CARDS, HUE_DIMMER_DEVICE_ID,
  TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID, BILRESA_CARDS, BILRESA_DEVICE_ID,
} from '../fixtures/reference-devices';
import { localised } from '../support/fake-homey';

/**
 * The stored English gesture label, read back into the user's language.
 *
 * The label is English and stays so — it is in every profile and in every
 * generated Flow's name — so the screens translate it by parsing the
 * normalizer's own closed vocabulary back out. These tests are what keep that
 * vocabulary closed: every label the four reference remotes produce must parse
 * into parts that are either OUR words (translated) or the vendor's (kept).
 */

const REMOTES = [
  ['STYRBAR', STYRBAR_CARDS, STYRBAR_DEVICE_ID],
  ['Hue dimmer', HUE_DIMMER_CARDS, HUE_DIMMER_DEVICE_ID],
  ['Tap Dial', TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID],
  ['BILRESA', BILRESA_CARDS, BILRESA_DEVICE_ID],
] as const;

/** A translator that marks everything it translated, so a test can see which parts were ours. */
const marking = (key: string, tokens?: Record<string, string | number>) => {
  const text = localised(key, tokens);
  return key.startsWith('input.control.') || key.startsWith('input.gesture.') || key.startsWith('input.direction.')
    ? `«${text}»`
    : text;
};

describe('a gesture label, in the user\'s language', () => {
  test('in English it reads as the stored label always did, with " · " for " — "', () => {
    for (const [name, cards, id] of REMOTES) {
      for (const input of normalizeCards([...cards], { sourceDeviceId: id }).inputs) {
        assert.equal(localisedInputLine(input.label, localised), input.label.replace(' — ', ' · '), `${name}: ${input.label}`);
      }
    }
  });

  test('every action a reference remote produces is one of our words, and so gets translated', () => {
    for (const [name, cards, id] of REMOTES) {
      for (const input of normalizeCards([...cards], { sourceDeviceId: id }).inputs) {
        const { action } = localiseInputLabel(input.label, marking);
        // A control-only label ("1 up rotary") has no action of ours to translate.
        if (action === '') continue;
        assert.match(action, /«/, `${name}: "${input.label}" has an action the parser does not know`);
      }
    }
  });

  test('the generic control names are ours; a vendor\'s own name passes through', () => {
    assert.deepEqual(localiseInputLabel('Dial — Turn right', marking), { control: '«Dial»', action: '«Turn right»' });
    assert.deepEqual(localiseInputLabel('Dial 1 — Press', marking), { control: '«Dial» 1', action: '«Press»' });
    assert.deepEqual(localiseInputLabel('Scroll up — Long press', marking), { control: 'Scroll up', action: '«Long press»' });
    assert.deepEqual(localiseInputLabel('1 up rotary', marking), { control: '1 up rotary', action: '' });
    // "Dialer" is a vendor's word that happens to start with ours.
    assert.deepEqual(localiseInputLabel('Dialer — Press', marking), { control: 'Dialer', action: '«Press»' });
  });

  test('a gesture with a direction appended is translated as a whole phrase', () => {
    assert.deepEqual(localiseInputLabel('Button — Press up', marking).action, '«Press» «up»');
    assert.deepEqual(localiseInputLabel('1 up rotary — down', marking).action, '«down»');
  });

  test('an action that is not ours is left exactly as it was', () => {
    assert.equal(localiseInputLabel('Top — Wiggle', marking).action, 'Wiggle');
  });

  test('every gesture word has a locale key', () => {
    for (const key of Object.keys(GESTURE_WORDS)) {
      assert.notEqual(localised(`input.gesture.${key}`), `input.gesture.${key}`, key);
    }
  });
});
