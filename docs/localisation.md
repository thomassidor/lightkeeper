# Localisation

**Lightkeeper ships English only.** It previously shipped Danish too, and that was
removed in 0.1.0 — maintaining two languages doubled the cost of every copy change
before anyone had asked for the second one.

What was deliberately *not* removed is the machinery, because that is what makes
adding a language cheap rather than a rewrite:

- `lib/` still returns a locale key plus tokens via `StateDetail`
  (`lib/profiles/controller-profile.ts`) instead of an English sentence, and the
  driver layer (`drivers/*/device.ts` — both of them) resolves it. `lib/` has no
  access to `homey.__`, so a string built there can *never* be translated — this
  indirection is the only reason it can be.
- Every `data-i18n` / `data-i18n-placeholder` attribute and every `Homey.__()`
  call is still in place.
- Manifest fields keep their `{ "en": … }` object form rather than collapsing to
  bare strings, so a second language is a sibling key, never a reshape.
- `test/unit/locales.test.ts` discovers `locales/*.json` from disk rather than
  importing a language by name. Its key-parity and `__token__` checks re-arm by
  themselves the moment a second file exists.

## Adding a language back

Say Danish, `da`. Nothing below requires touching a test or a build script.

1. **`locales/da.json`** — copy `locales/en.json` and translate the values. Keep
   every key and every `__token__` exactly as it is; `locales.test.ts` will fail on
   a missing key, an extra key, or a token that changed.
2. **`.homeycompose/app.json`** — add `da` to `name`, `description` and `tags`.
3. **`.homeycompose/flow/actions/*.json`** — all three cards. Each needs `da` for
   `title`, `titleFormatted`, `hint`, and the `title` of every entry in `args`.
   These strings appear in the user's Flow editor, so they are user-facing even
   though the cards are internal.
4. **`drivers/controller/driver.compose.json`** and
   **`drivers/schedule/driver.compose.json`** — add `da` to `name`, and to the
   schedule driver's `capabilitiesOptions.onoff.title` (the "Schedule active"
   label on its tile).
5. **`.homeychangelog.json`** — add `da` to each released version you want
   translated.
6. **`README.da.txt`** — the App Store long description. Homey uploads
   `README.<lang>.txt` as the listing body for that language; `README.txt` is the
   English one. This is *not* `README.md`.
7. Run `npx homey app build` to regenerate `app.json`, then `npm test` and
   `npx homey app validate --level publish`.

One group of strings is deliberately English and is not in `locales/`: the labels
inside generated Flow names, built by `lib/schedules/schedule-bindings.ts` —
"On at 22:00, Mon–Fri". They are part of a Flow's title in the user's own Flow
list, `lib/` has no access to `homey.__`, and a Flow title has nowhere to carry a
locale key. Translating them would mean the device layer renaming Flows, which is
the one thing reconciliation treats as a user's own edit.

One thing that cannot be translated, and should not be attempted: the "could not
reach the Homey pairing API" banner in the pair views. It fires precisely
when `window.Homey` never arrives, so `Homey.__` does not exist at that moment.
The failure mode *is* the absence of the translator.

## English → Danish glossary

Kept from the removed translation. This is the part worth preserving — the term
choices took thought, and re-deriving them would produce a different and worse set.

| English | Danish | Note |
|---|---|---|
| controller | betjening | The virtual Lightkeeper device. **Avoid *controller* in Danish UI** — it reads as a hardware controller. |
| schedule | tidsplan | The virtual schedule device, and one window inside it |
| remote | fjernbetjening | The physical source device |
| switch | kontakt | Physical source type |
| rotary dial | drejeknap | Physical source type |
| button | trykknap / knap | *trykknap* as a search noun, *knap* inside sentences |
| mapping | tildeling | The association from an event to a lighting action |
| event | hændelse | A source event Homey exposes |
| Flow | Flow | Homey product term — preserve the capital F, do not translate |
| API key | API-nøgle | Preserve the capitalisation of API |
| colour temperature | farvetemperatur | Note the English copy uses British spelling |
| brightness | lysstyrke | |
| warmer / cooler | varmere / koldere | Lighting-temperature direction |
| zone | zone | |
| unavailable | utilgængelig | |
| repair | reparér / reparation | Verb / noun |

Brand and protocol names are never translated: Lightkeeper, Homey, Zigbee, Matter,
IKEA BILRESA, Philips Hue.
