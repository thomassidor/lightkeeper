# Customer-service brief

## Product in one sentence

Light Link maps events from already-paired remotes, switches and dials to already-paired lights and maintains the required Homey Flows.

## First questions

1. Is the user on Homey Pro 2023 or later and firmware 12.3.0 or newer?
2. Which owning integration and pairing path exposes the source?
3. Does pairing show usable events for that source?
4. Is the Personal API Key complete and created with Flow permissions?
5. Does Recent remote presses show the input? Does Writes to lights show an attempted target write?

## Standard responses

**“My remote is not listed / has no events.”** Compatibility depends on what the owning integration exposes. If Homey exposes neither a usable capability event nor a bindable Flow trigger for that device, Light Link cannot observe it. Ask for model, owning app and pairing path.

**“Why do you need an API key?”** Homey does not allow the app's own session to write Flows. The user-created key is used only for Flow writes, remains on the Homey, is never logged and is excluded from diagnostics.

**“It stopped maintaining Flows.”** Ask the user to replace the API key. Existing runtime control should continue; mappings do not need to be recreated.

**“It changed a Flow I edited.”** This should not happen. Light Link detects material user edits and requests repair instead of overwriting. Escalate with redacted diagnostics and the generated Flow structure.

## Escalation package

- App and Homey firmware versions
- Source model, owning app and pairing path
- Target models and owning apps
- Exact mapping and whether Test works
- Redacted diagnostics copied from app settings
- Reproduction steps and approximate time
- Never request the API key

[OWNER ACTION] Set support hours, response target, severity owner and private security escalation channel.
