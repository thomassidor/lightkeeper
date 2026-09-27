import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { LANGUAGES } from '../support/languages';

/**
 * Every user-facing string OUTSIDE `locales/` is in every language too.
 *
 * `locales.test.ts` covers the locale files. The manifests are the other half,
 * and the half nothing used to check: a device type's name, a capability's
 * title on the tile, a Flow card's title and its argument labels all live as
 * inline `{ "en": … }` objects in `.homeycompose/` and the driver compose
 * files — and a language missing from one is a tile or a Flow card in English
 * in the middle of an otherwise translated app, with nothing failing.
 *
 * Plus the two App Store texts, which `homey app publish` uploads per language:
 * `README.<lang>.txt` and the current version's changelog entry.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Every manifest source file that can carry a `{ en: … }` string. */
function manifestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.json')) found.push(full);
    }
  };
  walk(join(ROOT, '.homeycompose'));
  for (const driver of readdirSync(join(ROOT, 'drivers'))) {
    for (const name of ['driver.compose.json', 'driver.flow.compose.json', 'driver.settings.compose.json']) {
      const path = join(ROOT, 'drivers', driver, name);
      if (existsSync(path)) found.push(path);
    }
  }
  return found;
}

/** Every `{ en: … }` object in a JSON tree, with where it is. */
function localisedObjects(node: unknown, path: string, out: Array<[string, Record<string, unknown>]>): void {
  if (Array.isArray(node)) {
    node.forEach((value, i) => localisedObjects(value, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const object = node as Record<string, unknown>;
  if (typeof object.en === 'string' || Array.isArray(object.en)) out.push([path, object]);
  for (const [key, value] of Object.entries(object)) {
    if (!(LANGUAGES as readonly string[]).includes(key)) localisedObjects(value, `${path}.${key}`, out);
  }
}

const args = (text: string) => [...text.matchAll(/\[\[(\w+)\]\]/g)].map(m => m[1]).sort();

describe('manifest strings, in every language', () => {
  const objects: Array<[string, Record<string, unknown>]> = [];
  for (const file of manifestFiles()) {
    const label = relative(ROOT, file).replaceAll('\\', '/');
    localisedObjects(JSON.parse(readFileSync(file, 'utf8')), label, objects);
  }

  test('there is something to check', () => {
    assert.ok(objects.length > 40, `found only ${objects.length} localised strings — is the walk broken?`);
  });

  test('every { en } object carries all thirteen languages, none of them empty', () => {
    const missing: string[] = [];
    for (const [where, object] of objects) {
      for (const language of LANGUAGES) {
        const value = object[language];
        const ok = Array.isArray(object.en)
          ? Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim())
          : typeof value === 'string' && value.trim().length > 0;
        if (!ok) missing.push(`${where}: ${language}`);
      }
    }
    assert.deepEqual(missing, [], 'add the language — docs/localisation.md');
  });

  test('a titleFormatted keeps every [[argument]] English has', () => {
    for (const [where, object] of objects) {
      if (!where.endsWith('.titleFormatted')) continue;
      for (const language of LANGUAGES) {
        assert.deepEqual(args(String(object[language])), args(String(object.en)), `${where}: ${language}`);
      }
    }
  });
});

describe('App Store texts, in every language', () => {
  test('a README.<lang>.txt listing for every language but English', () => {
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      const path = join(ROOT, `README.${language}.txt`);
      assert.ok(existsSync(path), `README.${language}.txt is missing`);
      assert.ok(readFileSync(path, 'utf8').trim().length > 500, `README.${language}.txt is too short to be the listing`);
    }
  });

  test('the current version\'s store changelog is in every language', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, '.homeycompose', 'app.json'), 'utf8')) as { version: string }).version;
    const entry = (JSON.parse(readFileSync(join(ROOT, '.homeychangelog.json'), 'utf8')) as Record<string, Record<string, string>>)[version];
    assert.ok(entry, `.homeychangelog.json has no ${version}`);
    for (const language of LANGUAGES) {
      assert.ok(typeof entry[language] === 'string' && entry[language]!.trim(), `${version}: ${language} is missing`);
    }
  });
});
