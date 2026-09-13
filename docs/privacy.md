# Lightkeeper privacy notice

Lightkeeper runs on your own Homey Pro. It sends no data to a vendor or cloud backend.
Diagnostic exports leave Homey only when you request them.

## What it reads

Paired device and zone metadata, the events your remotes report, the capability
state of the lights you point a controller, a schedule, a circadian light or a
Curve light at,
your Homey's own timezone, and the Flows it generated itself. All of it through
Homey's local Web API, all of it needed to do the three things the app does.

## What it stores

Two things, in two places on your own Homey.

**With each device you add:** a controller's profile — which remote, which
lights, which gesture does what; a schedule's plan: which lights, the times, the
days, and any brightness and warmth you set; or a circadian light's two ends and a
Curve light's points — including which palette colour a point carries, if any: which
lights, and the warmth you chose at each time of day. Each is stored with that
virtual device, so removing the device removes it.

**In the app's settings:** the Personal API Key you provide.

**Nothing else, in the app you installed.** The home-test recorder described below is a
development tool and is not part of a released build: the code, its six Web API routes and its
settings section are all removed at build time, so there is nothing to start and nothing that
could write an archive. It is documented here because the repository contains it, and because a
build made from source with `.dev-build` present does have it.

**In app userdata, only in a development build, and only after you start a home-test recording:**
an encrypted, bounded archive of control decisions, sensor and light reports, write results,
periodic health snapshots and observations you enter, plus its metadata and encryption key in the
app's settings. It can include device and room names. Recording stops after seven days or at
64 MiB. You can export and clear it through the authenticated app API; it is not sent to a
server. See [week-long-testing.md](week-long-testing.md).

The API key is used only to create, update and delete the Flows Lightkeeper
manages. It is never logged, never returned through the app's own API, and never
included in a diagnostics report. Errors are classified before they are logged,
because an error object can carry the token that caused it.

## What it does not do

No remote telemetry. No advertising, no vendor cloud
backend, no external data processor. Device inventories, events, configuration and
diagnostics are never transmitted by the app. A diagnostics report is produced
only when you ask for it. A home-test recording is not present in a released build at all, and
in a development build collects locally only after you explicitly start it. Either is shared only
if you choose to attach the exported file to a report yourself.

## How long it keeps things

Until you remove them. Deleting any of the four removes its own configuration,
and — for a controller or a schedule — the Flows demonstrably created for it. A
a circadian light and a Curve light create none. Removing the API key in
settings deletes the key. Uninstalling the app removes its settings, the stored
key included.

A home-test archive — which only a development build can create — remains on Homey after
recording stops, until you explicitly clear it or uninstall the app. Stopping a recording does not
erase its evidence. Installing a released build over a development one leaves any existing archive
in place and unreachable; uninstalling removes it.

## Reporting a problem

Bugs, and anything else: <https://github.com/thomassidor/lightkeeper/issues>.

For anything security-sensitive, use GitHub's private vulnerability reporting on
that repository rather than a public issue — it goes to the maintainer without
disclosing the detail first. Please do not include an API key in any report; the
diagnostics export deliberately contains no key material, which is what makes it
safe to attach.
