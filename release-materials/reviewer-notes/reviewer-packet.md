# Light Link reviewer packet

## App identity

- App ID: `com.thomassidor.lightlink`
- Version: `0.1.0`
- Publisher: Thomas Sidor
- Brand represented: Light Link, an original independent community app; no third-party brand represented
- Target platform: Homey Pro / `local`
- Category: lights
- Primary support: GitHub issue tracker configured in the manifest
- Backup technical contact: [OWNER ACTION - provide privately]

## Scope

- Purpose: Turn an already-paired remote, switch, button or rotary dial into a controller for already-paired lights without hand-authoring one Flow per event and target.
- Supported families: Sources whose owning Homey integration exposes a usable capability change or a bindable Flow trigger; lights exposing the relevant standard light capabilities.
- Fixture-backed examples: IKEA STYRBAR, Philips Hue Dimmer v2, Philips Hue Tap Dial and IKEA BILRESA through the pairing paths recorded in the repository.
- Exact models/SKUs: Not claimed as a closed compatibility list; event availability depends on the owning Homey app and pairing path.
- Countries/regions: No cloud account or regional endpoint.
- Minimum Homey firmware: 12.3.0.
- Required account: none.
- Required bridge/subscription: none beyond whatever the already-paired source or light requires.
- Required prerequisite: Homey Pro 2023 or later and a user-created Personal API Key with Flow permissions.
- Unsupported: Homey Pro 2019 and earlier, Homey Cloud, and sources for which Homey exposes neither usable capabilities nor bindable trigger cards.

## Pairing and lifecycle

- Prerequisites: Pair the desired source and target lights through their owning integrations. Create a Personal API Key in the Homey Web App with Flow permissions.
- App pairing: Paste and validate the key; choose a source; choose lights or a zone; map events; test; save.
- Discovery time: local enumeration; expected within seconds under normal Homey load.
- Login/OAuth/2FA: not applicable.
- Repair: reopen repair to replace the API key, reselect a re-added source, targets or mappings without recreating the virtual controller.
- Unpairing: removes only Flows demonstrably created for that controller. User-edited generated Flows are not silently overwritten.

## Review access and hardware

- Dedicated test account: not applicable; no vendor cloud account.
- Credential delivery: reviewer creates a Personal API Key on the review Homey; never commit or send one publicly.
- Sample sources: [OWNER ACTION - list supplied devices and firmware]. Suggested set: one ordinary button remote and one rotary remote, including IKEA BILRESA if available.
- Target lights: [OWNER ACTION - list representative on/off, dimmable and colour-temperature lights].

## Reviewer test script

1. Install the app on Homey Pro 2023 or later running firmware 12.3.0 or newer.
2. Open Devices, add Light Link, and follow the API-key instructions.
3. Select an already-paired source and confirm discovered events.
4. Select individual lights; map on/off and brightness; use Test on each row; save.
5. Press and turn the physical source. Confirm actual hardware changes and recent-event/write diagnostics.
6. Repair the controller, switch targets to a zone and save. Add or move a lamp in that zone and confirm dynamic resolution.
7. Change a target outside Light Link and confirm subsequent relative brightness begins from the reconciled state.
8. Revoke the API key. Confirm existing mappings still control lights while maintenance requests a new key.
9. Edit a generated Flow manually and confirm Light Link requests repair rather than overwriting it.
10. Delete the controller and confirm only its attributable generated Flows are removed.
11. Restart the app and Homey, then repeat a mapped action.

## Known limitations

- Compatibility is determined by what the source's owning integration exposes, not solely by the hardware model.
- Controls requiring more than 12 Flow variants are declined.
- A ramp always stops after 10 seconds as a safety limit.
- Numeric/rotary behaviour can differ by pairing path; Matter BILRESA exposes stepping without a release event.
- Verified end to end on a Homey Pro 2023 (firmware 13.4.0) against IKEA STYRBAR (Zigbee local), Philips Hue Dimmer v2 and Hue Tap Dial (Hue Bridge), and IKEA BILRESA (Matter/Thread). Per-transport output latency beyond the Hue Bridge is untested, since every light on the test Homey is behind that bridge.
