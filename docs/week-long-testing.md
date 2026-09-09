# Recording a week at home

Install this build persistently with `npx homey app install`. A temporary `homey app run`
session is not suitable for an unattended week. The recorder starts only when you ask;
installing or opening settings does not start it.

In Homey → Lightkeeper → app settings, choose **Start seven-day recording**. Check that
the state says **Recording** and the saved-record count increases after a minute. You
can then close the page and turn off your computer. Homey collects the evidence itself.
The deadline survives app restarts and is not extended by installing a new build.

When you notice something odd, enter it under **What did you notice?** and choose
**Save observation**. Include the room, the visible behavior and what you did immediately
before it. This gives the later analysis a timestamp to match against sensor and lamp reports.

## What is captured

- Every attempted lamp write, with its owning controller, capability, value, result and latency.
- Circadian/Curve/Daylight control passes, per-target decisions, completion outcomes, and
  the target reports those runtimes already subscribe to. The `external` flag is the app's
  classification, not proof that a person caused a change.
- Lux readings as they arrive through the shared sensor service, plus the readings used by
  Daylight control passes.
- Bridge Flow intake, including rejected events, and timestamped observations you enter.
- Once a minute: cached runtime state, target state, sensor availability/age, app version,
  timezone, process uptime and memory use. Configurations are captured initially and when
  this sampler observes a change. Very short-lived configuration changes between samples
  may not be captured.
- App startup and graceful shutdown, recording limits, sequence numbers and a unique boot id.

Collection uses existing subscriptions and cached state. It does not poll lights, enumerate
Flow cards, or change how frequently the control loops run. A successful write means the API
accepted it; target reports provide additional evidence, but are not physical verification.

## Export and analyze

The settings iframe cannot reliably download a large file. Export from the repository on
your computer using the same connection configuration as the hardware scripts:

- `HOMEY_ADDRESS` and `HOMEY_API_KEY`, or
- the gitignored `scripts/hardware-env.json` containing `address` and `key`.

Use a **separate Personal API Key from the one held by Lightkeeper**. Homey allows one
session per key; sharing it with an external script can interrupt the app during your test.
See [commands.md](commands.md) for connection setup.

```powershell
node scripts/evidence.mjs status
node scripts/evidence.mjs export
```

Export saves `.evidence/<recording-id>-<timestamp>.ndjson.gz` and prints an initial summary.
The directory is excluded from Git and from app packages. Keep the compressed file: it contains
the timeline needed for deeper analysis, not just totals. It includes device/room names and
your observations. Nothing is uploaded automatically.

You can export during the test without stopping it. The export fixes an endpoint before
reading, so it is a consistent prefix of the recording. An existing destination file is
never overwritten. If a download fails, discard the incomplete local file and export again
to a new filename; a successful export prints `Saved ...`.

```powershell
node scripts/evidence.mjs analyze .evidence/<recording-file>.ndjson.gz
node scripts/evidence.mjs note "Kitchen lamp kept getting brighter after I turned it on"
node scripts/evidence.mjs stop
```

The initial summary counts write failures, latency, override events and scheduler outcomes,
and reports peak RSS, sensor ranges/ages and gaps between health samples (including across
restarts). It does not diagnose a lamp from a counter alone. Look at the timeline around
observations and failures, and at repeated overrides, growing memory, missing samples or
readings that never change. An old sensor reading is not automatically a fault.

## Retention and limits

The recorder stops after seven days, when manually stopped, on a storage error, or when its
encrypted archive reaches **64 MiB**. It keeps earlier evidence instead of rotating it away.
Busy installations can reach the limit sooner; check status during the test. Starting a new
run refuses to overwrite the old one. After exporting, explicitly clear the stopped archive:

```powershell
node scripts/evidence.mjs clear <recording-id-from-status>
node scripts/evidence.mjs start
```

Pending data is limited to 512 KiB; records larger than 32 KiB or beyond that buffer are
counted as dropped. Data is compressed, encrypted and flushed every 15 seconds. A sudden
process/power loss can lose the unflushed tail; flushed data is synced before its committed
length is saved. Restart recovery discards any uncommitted file tail and records its size.
No recorder can report events while the app or Homey is down; boot ids and sample gaps expose
those intervals. Check `dropped`, `state`, `lastFlushAt` and the export's status manifest before
treating the timeline as complete.

Files in Homey's `/userdata` are publicly served, so the recorder encrypts each compressed
batch with AES-256-GCM. Its random key stays in app settings, and downloads go through the
authenticated app API. The key and API credentials are never part of an export. This follows
[Homey's persistent-storage constraints](https://apps.developer.homey.app/the-basics/app/persistent-storage).

This feature is covered by local storage, restart, retention, redaction and export tests.
The Homey-specific storage, restart and download path still needs a short smoke test on your
own Homey before relying on the unattended run.
