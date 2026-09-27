/**
 * Plural-aware translation, for the driver and device layer.
 *
 * `homey.__` knows nothing about plurals, and English "(s)" does not survive
 * translation: Polish and Russian have three forms of "light" after a number,
 * Arabic six, Korean one. So a COUNTED string is stored as a group of CLDR
 * plural categories —
 *
 *   "someLights": { "one": "__count__ light", "other": "__count__ lights" }
 *
 * — and `localise()` picks the form with `Intl.PluralRules`, exactly as
 * `views/shared/i18n.js` does in the pairing screens. The categories each
 * language must supply are whatever `Intl.PluralRules(<lang>)` reports, and
 * `test/unit/locales.test.ts` holds every locale file to that.
 *
 * **The count is always the `count` token.** That convention is what lets this
 * be automatic: a `StateDetail` built in `lib/` carries `{ key, tokens }` and
 * never has to know that its key is a plural group, and the device layer's one
 * `translate()` resolves it. The locales test fails if a group's English
 * `other` form does not use `__count__`.
 *
 * The language comes from the locale file itself (`meta.language`), not from
 * `homey.i18n.getLanguage()`: a Homey set to a language the app does not ship
 * reads `en.json`, and choosing plural forms by the Homey's language would then
 * ask English strings for Portuguese categories.
 */

/** What a locale lookup looks like: `homey.__`, or a host's `translate`. */
export type Translate = (key: string, tokens?: Record<string, string | number>) => unknown;

/** A lookup that found a real string, rather than the key echoed back or nothing. */
function found(value: unknown, key: string): value is string {
  return typeof value === 'string' && value !== '' && value !== key;
}

/** The language the active locale file was written in; `en` when unreadable. */
function languageOf(translate: Translate): string {
  const value = translate('meta.language');
  return typeof value === 'string' && /^[a-z]{2}$/.test(value) ? value : 'en';
}

/** The CLDR plural category `n` takes in `language`. */
function pluralCategory(language: string, n: number, type: 'cardinal' | 'ordinal' = 'cardinal'): string {
  try {
    return new Intl.PluralRules(language, { type }).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/**
 * Translate `key`, choosing a plural form when the key is a plural group.
 *
 * A key that is NOT a group costs one extra lookup when it carries a numeric
 * `count` ("Step 2 of 4") and falls through to the plain string. A group's
 * missing form falls back to `other`, which every language has.
 */
export function localise(translate: Translate, key: string, tokens: Record<string, string | number> = {}): string {
  const count = tokens.count;
  if (typeof count === 'number' && Number.isFinite(count)) {
    const form = `${key}.${pluralCategory(languageOf(translate), count)}`;
    const chosen = translate(form, tokens);
    if (found(chosen, form)) return chosen;
    const other = translate(`${key}.other`, tokens);
    if (found(other, `${key}.other`)) return other;
  }
  const plain = translate(key, tokens);
  return typeof plain === 'string' ? plain : key;
}

/** `homey.__`, made plural-aware. What every `translate` a driver hands `lib/` should be. */
export function translatorFor(homey: { __: (key: string, tokens?: object) => string }): (key: string, tokens?: Record<string, string | number>) => string {
  return (key, tokens) => localise((k, t) => homey.__(k, t ?? {}), key, tokens ?? {});
}
