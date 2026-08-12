import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../locales/en.json' with { type: 'json' };
import da from '../../locales/da.json' with { type: 'json' };

/**
 * Localisation regressions are silent: a missing Danish key falls back to
 * English and nothing fails, and an unused key is a string someone wrote and
 * then quietly rendered as hardcoded English somewhere else. Both happened —
 * the settings page shipped with zero data-i18n attributes while fifteen
 * `settings.*` keys sat unreferenced, and every credential failure hint reached
 * the user in English despite having Danish translations.
 *
 * These tests make both failure modes loud.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Every leaf path in a nested locale object, as `a.b.c`. */
function keysOf(object: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? keysOf(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`]);
}

/** Source files that can reference a locale key. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.homeybuild' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|html)$/.test(entry) && !full.includes(join('test', 'unit'))) found.push(full);
    }
  };
  for (const dir of ['lib', 'drivers', 'settings']) walk(join(ROOT, dir));
  found.push(join(ROOT, 'app.ts'), join(ROOT, 'api.ts'));
  return found;
}

/**
 * Keys referenced anywhere in the source.
 *
 * Matching is KEY-shaped, not call-shaped: a key reaches the UI through
 * `Homey.__()`, a `data-i18n` attribute, a `messageKey` field, a `StateDetail`
 * literal in lib/, or the settings page's `t()` helper — and enumerating those
 * call sites is how a real reference gets missed. Instead, look for any quoted
 * `<group>.<name>` where `<group>` is a top-level group in en.json.
 */
function referencedKeys(): Set<string> {
  const referenced = new Set<string>();
  const allKeys = keysOf(en as Record<string, unknown>);
  const groups = Object.keys(en as Record<string, unknown>);
  const groupPattern = groups.join('|');

  // 'state.noTargets' | "state.noTargets" | `state.noTargets`
  const literal = new RegExp(`['"\`](${groupPattern})\\.([\\w.]+)['"\`]`, 'g');
  // `functions.${fn}` — a dynamic lookup that uses the whole group.
  const dynamic = new RegExp(`['"\`](${groupPattern})\\.\\$\\{`, 'g');
  // The settings page's helper: t('keyValid') means settings.keyValid.
  const helper = /(?<![\w.])t\(\s*'([\w]+)'/g;

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');

    for (const m of text.matchAll(literal)) referenced.add(`${m[1]}.${m[2]}`);

    for (const m of text.matchAll(dynamic)) {
      const prefix = `${m[1]}.`;
      for (const key of allKeys) if (key.startsWith(prefix)) referenced.add(key);
    }

    if (file.endsWith(join('settings', 'index.html'))) {
      for (const m of text.matchAll(helper)) referenced.add(`settings.${m[1]}`);
    }
  }

  return referenced;
}

describe('locales', () => {
  test('Danish covers exactly the same keys as English', () => {
    const english = keysOf(en as Record<string, unknown>);
    const danish = keysOf(da as Record<string, unknown>);

    assert.deepEqual(
      english.filter(k => !danish.includes(k)), [],
      'keys present in en.json but missing from da.json',
    );
    assert.deepEqual(
      danish.filter(k => !english.includes(k)), [],
      'keys present in da.json but missing from en.json',
    );
  });

  test('every defined key is actually referenced by the UI', () => {
    const referenced = referencedKeys();
    const unused = keysOf(en as Record<string, unknown>).filter(k => !referenced.has(k));

    assert.deepEqual(
      unused, [],
      'defined but never rendered — either wire it up or delete it',
    );
  });

  test('every referenced key is defined', () => {
    const defined = new Set(keysOf(en as Record<string, unknown>));
    const missing = [...referencedKeys()].filter(k => !defined.has(k));

    assert.deepEqual(missing, [], 'referenced in source but absent from en.json');
  });

  test('token placeholders match between the two languages', () => {
    const tokensIn = (value: string) =>
      [...value.matchAll(/__(\w+)__/g)].map(m => m[1]!).sort();

    const walk = (a: Record<string, any>, b: Record<string, any>, path = '') => {
      for (const [key, value] of Object.entries(a)) {
        const here = `${path}${key}`;
        if (value !== null && typeof value === 'object') {
          walk(value, b[key] ?? {}, `${here}.`);
        } else if (typeof value === 'string' && typeof b[key] === 'string') {
          assert.deepEqual(
            tokensIn(b[key]), tokensIn(value),
            `${here}: Danish uses different __tokens__ than English`,
          );
        }
      }
    };

    walk(en as Record<string, any>, da as Record<string, any>);
  });
});
