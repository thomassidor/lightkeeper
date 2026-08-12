# Light Link

## Your remotes and lights, finally working together

Light Link turns an already-paired remote, switch, button panel or rotary dial into a controller for the lights already paired with your Homey. Choose a source, choose individual lights or a zone, map each gesture and save. Light Link builds and maintains the repetitive Flows underneath.

### Requirements

- Homey Pro 2023 or later with firmware 12.3.0 or newer
- One or more already-paired source controls and lights
- A Personal API Key created in the Homey Web App with Flow permissions
- Local Homey platform; Homey Cloud and Homey Pro 2019 are not supported

### Compatibility

Compatibility depends on what the source's owning Homey integration exposes. A source works when Homey provides either a usable capability change or a Flow trigger that can be bound to that device. The same hardware can expose different controls through different pairing paths.

Repository fixtures cover IKEA STYRBAR, Philips Hue Dimmer v2, Philips Hue Tap Dial and IKEA BILRESA. These are reference surfaces, not an exhaustive model guarantee. On/off, dimmable and colour-temperature lights are used according to the standard capabilities each target exposes.

### Install and configure

1. Pair your source and lights through their normal Homey integrations.
2. In the Homey Web App, open Settings, API Keys and create a key with Flow permissions. Copy it when shown.
3. In Devices, add Light Link and choose Remote-to-light controller.
4. Paste the key and wait for validation.
5. Choose the remote, switch or dial you want to repurpose.
6. Choose individual lights or select a zone and whether sub-zones are included.
7. Assign an exposed press, hold or turn to each desired lighting action. Use Test before saving.

### Lighting actions

Light Link can map exposed source events to on/off, turn on, turn off, brighter, dimmer, warmer and colder. An action only writes capabilities supported by the selected targets. Controls that would require more than 12 generated Flow variants are declined to protect the user's Flow list.

### Repair and reconnect

- Expired or revoked API key: open repair or app settings and save a new key. Existing controller-to-light actions continue; Flow maintenance resumes after validation.
- Re-added source: open repair and select the matching source. Light Link can retain existing targets and mappings.
- Changed source event surface: open repair and remap the affected actions.
- Manually edited generated Flow: open repair to rebuild it. Light Link does not silently overwrite user edits.

### Removing Light Link

Deleting a Light Link controller removes only generated Flows that it can attribute to that controller. The settings page can identify orphaned Light Link Flows and refuses cleanup if no controller is running, when attribution would be unsafe. Removing the app removes local settings, including the stored API key.

### Privacy and security

Nothing is sent off the Homey. Light Link has no telemetry and no vendor cloud service. The Personal API Key is stored in app settings on the Homey, used only for Flow writes, never logged, never returned by the app API and excluded from diagnostics. Diagnostics are generated locally and shared only when the user chooses to copy them.

### Troubleshooting

**No usable events found** - The owning integration exposes no usable capability change or bindable trigger for this pairing path. Try another official pairing path where available; otherwise the device cannot be observed through Homey's public interfaces.

**The key does not work** - Create a complete new Personal API Key with Flow permissions. A read-only key may validate ordinary reads but cannot maintain Flows.

**A press does nothing** - In app settings, inspect Recent remote presses. No row means the generated Flow did not fire. An ignored row includes the reason. Then inspect Writes to lights to distinguish a missing intent from a refused target write.

**A light is unavailable** - Bring the target and its owning integration online. Zone-based targets resolve dynamically, so newly available lights will be included again.

**Brightness keeps changing** - Every ramp has an unconditional 10-second stop because release events can be lost. If the source exposes no release event, Light Link offers stepping instead of a hold ramp.

### Diagnostics and support

Open Homey settings, Light Link, then Copy for a bug report. Review the output before attaching it to a report; credentials are deliberately excluded. Report public issues through the repository issue tracker configured as the app's support link.

### Support coverage

This support page is currently maintained in English. Danish questions are welcome through the support route; detailed technical responses may fall back to English.

[OWNER ACTION] Publish this page and state the monitored response window and security-contact route before certification.
