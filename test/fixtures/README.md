# Fixtures

## `reference-devices.ts`

Raw flow-card schemas, transcribed by hand from four real remotes on a Homey Pro 2023
(firmware 13.4.0) during the Phase 0 spike. Device IDs are replaced with stable placeholders;
nothing else is altered.

| Remote | Transport | Notable for |
|---|---|---|
| IKEA STYRBAR E2001/E2002 | Zigbee, local | Fixed cards, no arguments or tokens. Up and down carry both press and long-press; left and right press only. |
| Philips Hue Dimmer v2 | Hue Bridge | Argument-based card selection. |
| Philips Hue Tap Dial | Hue Bridge | The rotation token — `steps`, 1000 per turn — that made magnitude scaling necessary. |
| IKEA BILRESA | Matter/Thread | Cards that vanish after a Homey restart, which is what §9.4 one-tap re-attach exists for. |

## Why the expectations are written by hand

§11.2 requires that raw fixture data stay separate from the normalised catalogue the tests
assert against. The expected catalogues live in the test files, authored independently of these
captures.

That separation is the whole point: it proves the **normalizer** is doing the work rather than
the fixture. Three real bugs were caught this way, including a regex that failed to match
"long pressed" — a space, not an underscore — which would have left the app's headline
press-versus-hold behaviour as dead code.

## Never commit captures from a real home

A verbatim `getDevices` / `getFlows` dump from a live Homey contains personal data:

- every device and zone name in the house
- the Homey owner's display name and Athom user ID, embedded in flow action arguments
- notification text from existing flows, including push-message bodies

An earlier `raw/` directory here held exactly that and has been removed. `/test/fixtures/raw/`
is in `.gitignore` so a fresh capture cannot be committed by accident.

If you need a capture to reproduce a bug locally, take one, keep it out of git, and scrub it
before attaching anything to a bug report. When scrubbing, note that device **IDs** are
load-bearing — trigger cards are keyed `homey:device:<deviceId>:<card>`, so IDs must stay
internally consistent even when names are replaced with pseudonyms.
