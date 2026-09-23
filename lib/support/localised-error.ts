/**
 * An error whose message is a locale KEY, for `lib/` code a pairing screen shows.
 *
 * `lib/` has no `homey.__` (CLAUDE.md, "Translation belongs to the device
 * layer"), so a refusal thrown here in English could never be translated
 * whatever the locale files say — and a pair handler's error IS the text on the
 * screen. The key travels on the error; `handlerRegistrar` in
 * `lib/pairing/pair-session.ts` resolves it through the host on the way out, so
 * no handler has to remember to.
 *
 * `message` is the key itself rather than English, so a key that somehow reaches
 * a log unresolved says exactly which string is missing.
 */
export class LocalisedError extends Error {
  constructor(
    readonly key: string,
    readonly tokens: Record<string, string | number> = {},
  ) {
    super(key);
    this.name = 'LocalisedError';
  }
}
