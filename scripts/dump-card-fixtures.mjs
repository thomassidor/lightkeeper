/**
 * Write `test/fixtures/cards/*.json` from the hand-transcribed TS fixtures.
 *
 * Run once, by hand, and only when the TS fixtures change. The JSON is the
 * committed artefact — `test/unit/card-fixtures.test.ts` fails if the two drift,
 * which is what stops the corpus quietly describing a device the tests no longer
 * use. See `test/fixtures/cards/README.md` for what replacing these with real
 * captures involves.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const out = join(here, '..', 'test', 'fixtures', 'cards');

/**
 * Indexed by name, so the device table below stays a table.
 *
 * The specifier is built rather than literal because `tsc` refuses a `.ts`
 * import extension without `allowImportingTsExtensions`, and this file runs
 * under `tsx`, where the extension is exactly what makes it resolve. One is a
 * type-check of a build script; the other is the script working.
 */
const SPECIFIER = '../test/fixtures/reference-devices.ts';
const fixtures = /** @type {Record<string, any>} */ (await import(SPECIFIER));

const DEVICES = [
  ['styrbar', 'com.ikea.tradfri:remote_control_n2', 'STYRBAR_DEVICE_ID', 'STYRBAR_CARDS'],
  ['hue-dimmer-v2', 'nl.philips.hue:dimmerswitch', 'HUE_DIMMER_DEVICE_ID', 'HUE_DIMMER_CARDS'],
  ['hue-tap-dial', 'nl.philips.hue:tapdial', 'TAP_DIAL_DEVICE_ID', 'TAP_DIAL_CARDS'],
  ['bilresa', 'com.ikea.tradfri:matter_bilresa_scroll_wheel', 'BILRESA_DEVICE_ID', 'BILRESA_CARDS'],
];

for (const [slug, driverId, idKey, cardsKey] of DEVICES) {
  const payload = {
    provenance: 'reconstructed',
    note: 'Rebuilt from test/fixtures/reference-devices.ts, which was hand-transcribed '
      + 'from a live Homey Pro 2023 on firmware 13.4.0. Replace with a real capture '
      + 'when one is available — see README.md in this folder.',
    driverId,
    deviceId: fixtures[idKey],
    cards: fixtures[cardsKey],
  };
  writeFileSync(join(out, `${slug}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`wrote ${slug}.json (${payload.cards.length} cards)`);
}
