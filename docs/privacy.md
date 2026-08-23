# Lightkeeper privacy notice

Lightkeeper runs entirely on your own Homey Pro. Nothing it reads, stores or
generates is transmitted anywhere.

## What it reads

Paired device and zone metadata, the events your remotes report, the capability
state of the lights you point a controller or a schedule at, your Homey's own
timezone, and the Flows it generated itself. All of it through Homey's local Web
API, all of it needed to do the two things the app does.

## What it stores

Two things, in two places on your own Homey.

**With each device you add:** a controller's profile — which remote, which
lights, which gesture does what — or a schedule's plan: which lights, the times,
the days, and any brightness and warmth you set. Each is stored with that
virtual device, so removing the device removes it.

**In the app's settings:** the Personal API Key you provide, and nothing else.

The API key is used only to create, update and delete the Flows Lightkeeper
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

Until you remove them. Deleting a controller or a schedule removes its own
configuration and the Flows demonstrably created for it. Removing the API key in
settings deletes the key. Uninstalling the app removes its settings, the stored
key included.

## Reporting a problem

Bugs, and anything else: <https://github.com/thomassidor/lightkeeper/issues>.

For anything security-sensitive, use GitHub's private vulnerability reporting on
that repository rather than a public issue — it goes to the maintainer without
disclosing the detail first. Please do not include an API key in any report; the
diagnostics export deliberately contains no key material, which is what makes it
safe to attach.
