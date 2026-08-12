# Light Link privacy notice

Light Link runs entirely on your own Homey Pro. Nothing it reads, stores or
generates is transmitted anywhere.

## What it reads

Paired device and zone metadata, the events your remote reports, the capability
state of the lights you point it at, and the Flows it generated itself. All of it
through Homey's local Web API, all of it needed to do the one thing the app does.

## What it stores

Controller profiles — which remote, which lights, which gesture does what — and
the Personal API Key you provide. Both live in the app's settings on your Homey.

The API key is used only to create, update and delete the Flows Light Link
manages. It is never logged, never returned through the app's own API, and never
included in a diagnostics report. Errors are classified before they are logged,
because an error object can carry the token that caused it.

## What it does not do

No telemetry, opt-in or otherwise. No analytics, no advertising, no vendor cloud
backend, no external data processor. Device inventories, events, configuration and
diagnostics are never transmitted by the app. A diagnostics report is produced
only when you ask for it, and is shared only if you choose to attach it to a
report yourself.

## How long it keeps things

Until you remove them. Deleting a controller removes its profile and the Flows
demonstrably created for it. Removing the API key in settings deletes the key.
Uninstalling the app removes its settings.

## Reporting a problem

Bugs, and anything else: <https://github.com/thomassidor/lightlink/issues>.

For anything security-sensitive, use GitHub's private vulnerability reporting on
that repository rather than a public issue — it goes to the maintainer without
disclosing the detail first. Please do not include an API key in any report; the
diagnostics export deliberately contains no key material, which is what makes it
safe to attach.
