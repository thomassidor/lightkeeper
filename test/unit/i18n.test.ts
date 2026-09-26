import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { localise, translatorFor, type Translate } from '../../lib/support/i18n';

/**
 * Plural-aware translation, for the driver and device layer.
 *
 * A stand-in locale per language rather than the real files, so these say what
 * the MECHANISM does — which form `Intl.PluralRules` picks, and what happens
 * when a form or the language is missing — independently of any translation.
 */

function locale(language: string, strings: Record<string, unknown>): Translate {
  const tree: Record<string, unknown> = { meta: { language }, ...strings };
  return (key, tokens = {}) => {
    let node: unknown = tree;
    for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
    if (typeof node !== 'string') return key;
    return node.replace(/__(\w+)__/g, (whole, name: string) => (name in tokens ? String(tokens[name]) : whole));
  };
}

const POLISH = locale('pl', {
  lights: {
    one: '__count__ światło', few: '__count__ światła', many: '__count__ świateł', other: '__count__ światła',
  },
  step: 'Krok __index__ z __count__',
});

describe('localise', () => {
  test('Polish picks one, few and many by the count', () => {
    assert.equal(localise(POLISH, 'lights', { count: 1 }), '1 światło');
    assert.equal(localise(POLISH, 'lights', { count: 3 }), '3 światła');
    assert.equal(localise(POLISH, 'lights', { count: 5 }), '5 świateł');
    assert.equal(localise(POLISH, 'lights', { count: 22 }), '22 światła');
  });

  test('a plain string that happens to carry a count is left a plain string', () => {
    assert.equal(localise(POLISH, 'step', { index: 2, count: 4 }), 'Krok 2 z 4');
  });

  test('a missing form falls back to other, which every language has', () => {
    const thin = locale('pl', { lights: { one: '__count__ światło', other: '__count__ światła' } });
    assert.equal(localise(thin, 'lights', { count: 5 }), '5 światła');
  });

  test('a locale file that does not say its language reads as English', () => {
    const unnamed: Translate = (key, tokens) =>
      key === 'meta.language' ? 'meta.language' : locale('en', { n: { one: 'one __count__', other: 'many __count__' } })(key, tokens);
    assert.equal(localise(unnamed, 'n', { count: 1 }), 'one 1');
    assert.equal(localise(unnamed, 'n', { count: 2 }), 'many 2');
  });

  test('a key that does not exist comes back as itself', () => {
    assert.equal(localise(POLISH, 'no.such.key', { count: 2 }), 'no.such.key');
  });

  test('translatorFor wraps homey.__', () => {
    const homey = { __: (key: string, tokens?: object) => String(POLISH(key, tokens as Record<string, string | number>)) };
    assert.equal(translatorFor(homey)('lights', { count: 5 }), '5 świateł');
  });
});
