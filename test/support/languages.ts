/**
 * The languages Lightkeeper ships, in one place.
 *
 * Homey's own list: exactly what the pinned CLI's `homey app translate` offers
 * (`Translate.LANGUAGES` in node_modules/homey/lib/app/Translate.js), and every
 * code is valid in homey-lib's `getLocales()`. A test file rather than a
 * `locales/languages.json`, because Homey reads every JSON file in `locales/`
 * as a language of that name.
 *
 * Adding one is docs/localisation.md's checklist; this list is what makes the
 * tests insist on every item of it.
 */
export const LANGUAGES = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'] as const;

/** Written right to left. Every screen sets `dir` from `meta.direction`. */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar']);

/** Every CLDR plural category there is. */
export const PLURAL_CATEGORIES: ReadonlySet<string> = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/**
 * Is this locale node a plural group rather than a group of keys?
 *
 * A group whose keys are ALL plural categories, one of them `other`. Nothing
 * else in the locale files is shaped like that, and the locales test would
 * notice if something were: its forms would be checked against Intl.
 */
export function isPluralGroup(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return keys.includes('other')
    && keys.every(key => PLURAL_CATEGORIES.has(key))
    && Object.values(value).every(form => typeof form === 'string');
}

/** The categories `language` needs: for a cardinal group, or for the `ordinal` group. */
export function categoriesFor(language: string, type: 'cardinal' | 'ordinal'): string[] {
  return [...new Intl.PluralRules(language, { type }).resolvedOptions().pluralCategories].sort();
}
