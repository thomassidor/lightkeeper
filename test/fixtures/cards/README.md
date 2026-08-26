# Recorded trigger-card schemas

One JSON file per reference device, holding the trigger cards that device exposes
in the shape `getFlowCardTriggers()` returns them.

Why they exist separately from `../reference-devices.ts`: that file is TypeScript
and its `card()`/`dropdown()` helpers do a small amount of assembly. These are
flat data, so a real capture can replace one wholesale without anybody having to
re-express it as helper calls — and `card-fixtures.test.ts` fails if the two ever
disagree, so the corpus cannot quietly describe a device the tests no longer use.

## Provenance

Every file carries a `provenance` field, and every file currently says
**`reconstructed`**: they were rebuilt from `reference-devices.ts`, which was
itself hand-transcribed from a live Homey Pro 2023 on firmware 13.4.0. The
transcription is faithful to what mattered for normalisation, but a transcription
drops whatever nobody was looking at — and Phase 5's wider fingerprint
(`fingerprintV2`) now hashes some of exactly that: argument `filter` strings,
numeric `min`/`max`/`step`, token titles.

So these are good enough to test the normalizer and not good enough to settle a
question about the platform. Anything load-bearing still needs hardware.

## Replacing one with a real capture

On a Homey with the device paired, from the app's own diagnostics or a scratch
app with `homey:manager:api`:

```js
const cards = Object.values(await client.flow.getFlowCardTriggers());
const mine = cards.filter(c => String(c.id ?? '').startsWith(`homey:device:${deviceId}:`));
console.log(JSON.stringify(mine, null, 2));
```

Then, in the JSON file:

1. Replace `cards` with the captured array.
2. Replace the real device id with the file's existing placeholder id, everywhere
   it appears — in `id` and in `uri`. **Nothing else may be edited.** A capture
   that has been tidied is a transcription again.
3. Set `provenance` to `captured`, and add `firmware` and `capturedAt`.
4. Run `npm test`. `card-fixtures.test.ts` will now fail against
   `reference-devices.ts`; update the TS fixture to match the capture, not the
   other way round.

**Never commit an untouched capture.** Real ones carry device and zone names, the
owner's display name and Athom user ID — see `test/fixtures/README.md`. The
placeholder-substitution step above is not cosmetic.
