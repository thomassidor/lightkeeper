# What a week of real evidence found

One recording, read end to end, and what it cost to believe the device tiles instead.

| | |
|---|---|
| Recording | `d9645dbc-294a-439a-b992-197197ad3bd6`, exported 13 September 2026 |
| Span | 9–13 September 2026 — **3.83 days**, two boots, one app restart |
| Volume | 58,024 records, 21 MB compressed, 64 MB as NDJSON |
| App | 0.7.0 — a development build; that work is part of 0.6.0 — Node v22.23.2, Europe/Copenhagen |
| Devices | 2 curve, 2 circadian, 3 daylight, 1 schedule, 1 controller, plus four short-lived `[verify]` devices from a hardware pass |
| Manifest said | `dropped: 0`, `error: null`, `state: recording` |

**Every device reported `state: "ready"` in 100% of its 5,500-odd health samples.** One of them had
done nothing at all for 88 of the 93 hours. That gap between what the tiles said and what the
archive shows is the single most useful thing this recording produced, and it is why four of the six
findings below are about the app failing to notice its own silence rather than about it doing
something visibly wrong.

Everything here is fixed, in the release this recording was made against —
[`CHANGELOG.md`](../CHANGELOG.md)'s 0.6.0 entry, final section. Each section below names the
evidence first and the code second, so the finding survives the fix.

---

## F1 — An override never expired, so one uncooperative lamp muted a device for days

**Severity: critical.**

`lk-circ-da0757ef…` ("Studio circadian") drives lamp `63eb32f5`. This sequence repeats on every
power-on, without exception, all week:

```
11:28:37  power on
11:28:37  WRITE dim=1                   ok=true
11:28:37  WRITE light_mode=temperature  ok=true
11:28:38  WRITE light_temperature=0     ok=true
          … 90–150 seconds pass …
11:30:07  REPORT dim=0.41                ext=true  ->  override  val=0.41  exp=1
11:30:07  REPORT light_temperature=0.83  ext=true  ->  override  val=0.83  exp=0
```

The lamp accepts every write, acknowledges it, and then reverts to its own fixed `dim 0.41` /
`light_temperature 0.83` a minute or two later — whatever it was sent. Expected values seen across
the week: 1, 0.89 and 0.09 for `dim`; 0, 0.06 and 0.79 for temperature. The reported pair is always
the same two numbers.

Nothing about that revert distinguishes it from a person, so it was read as one, and an override had
no way to end:

| Overridden span | Lamp | Device state |
|---|---|---|
| 23.61 h | on | `ready` |
| 23.05 h | on | `ready` |
| 15.54 h | on | `ready` |
| 15.16 h | on | `ready` |
| 11.01 h | on | `ready` |

`overrides` was cleared by an `onoff` edge, by the target leaving the plan, or by the runtime
stopping, and by nothing else. "Switch it off and on again" is a fine gesture and was a terrible
only one: it assumes a person raised the override.

**Fix.** `OVERRIDE_EXPIRY_MS` (4 hours) in `lib/outputs/target-state-cache.ts`, applied lazily by
`expireOverrides()` in both `lib/daylight/daylight-runtime.ts` and
`lib/circadian/circadian-runtime.ts` — from `applyNow()` and from `diagnostics()`, so there is no new
timer and nothing shows as overridden after control has resumed. Expiry also drops `committed` /
`lastWritten` for that lamp, which is half the fix rather than tidiness: the lamp was moved while the
override stood, so an unchanged plan against an unchanged *intended* value would have written nothing
at all, and the lamp would have stayed exactly where it was put.

Four hours is a balance, not a discovery: long enough not to fight somebody who dimmed the lamps for
an evening, short enough that a lamp the app cannot actually drive costs one evening instead of a
week. It is one constant.

---

## F2 — A `dim` report of 0 was read as a person, 296 times

**Severity: high.**

The guard was already there — a `dim` report is ignored while the cached `actualOn` is not `true`.
But `actualOn` only moves when the `onoff` report itself lands, and this integration sends the two
half a minute apart:

```
11:36:54  REPORT dim=0      ext=true  ->  override  val=0  exp=0.46
11:37:24  REPORT onoff=false          ->  power / override_cleared (power_changed)
```

**232 measured pairs. Median 29,924 ms, minimum 29,197 ms.** For that whole window the cache still
believes the lamp is on, the power-settling window has not opened, and the report walks straight into
the override path.

**296 of the 327 overrides in the entire recording were this and nothing else.** Each put a false
"overridden" badge on the device for thirty seconds and pushed a junk entry into a 120-entry event
log, evicting the genuine control history that makes a real fault diagnosable. Had a single `onoff`
report gone missing, it would have become F1.

**Fix.** A reported `dim` of 0 is now classified as the lamp going off regardless of what `onoff` has
said yet, recorded as `report_ignored` with `reason: 'dim_zero'`. The test needs no clock and no
ordering: neither runtime can write 0 — `MINIMUM_BRIGHTNESS` is 0.10 perceptual and `litDim()`
guarantees a positive brightness is never written as darkness — and a person dragging a dimmer to
zero switches the lamp *off*, which arrives as `onoff` and clears any override anyway.

---

## F3 — Redaction destroyed 93 records, and `dropped` stayed 0

**Severity: high.**

93 of the 58,024 records in this archive will not parse. Reproduced exactly:

```js
// lib/support/homey-errors.ts, before
/[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}|[0-9a-f]{20,}/gi
```

`0-9` is a subset of `0-9a-f`, and a double just under 1e-5 prints all of its significant digits
behind a run of leading zeros. A circadian warmth crossing zero produced `4.829384756102938e-6`,
serialised as `0.000004829384756102938` — twenty-one characters the second alternative matched:

```
{"warmth":0.<redacted>,"brightness":0.9999838173022728}     <- invalid JSON, permanently
```

The docblock above the pattern argued only that twenty hex characters cannot be a UUID. It never
considered a number.

**The recorder could not see it.** The corruption happens after `++m.sequence`, and the line is
written successfully — so `dropped` stayed 0, and the settings page, `evidence.mjs status` and the
export's own manifest all reported a complete recording. The sequence gaps are the only trace, and
nothing was looking at them.

**Fix, three parts.** The pattern now requires the hex run not to follow a decimal point or a digit;
the two deliberate copies in `scripts/evidence.mjs` and `scripts/probe-lights.mjs` carry the same
change and the reason; and `lib/support/evidence-recorder.ts` re-parses any line redaction actually
changed, counting it in `dropped` rather than writing it — so the next such flaw arrives as a number
a person can see. That costs one parse on the rare touched line: 94 of 58,024 here.

`node scripts/evidence.mjs analyze` now reports `malformed` in its interpretation line, and
[`week-long-testing.md`](week-long-testing.md) says to read it first.

---

## F4 — The 0.03 override tolerance failed at exactly 0.03

**Severity: medium.**

```js
Math.abs(0.83 - 0.86) === 0.030000000000000027   // > 0.03  -> "somebody overrode us"
Math.abs(0.10 - 0.13) === 0.03                   // <= 0.03 -> forgiven
```

So the tolerance described as "comfortably above `light_temperature`'s own 0.01 resolution" was not,
for a large share of the axis — a bridge rounding by exactly three hundredths was forgiven or
prosecuted depending on where the value sat. The archive has two `light_temperature 0.83 vs 0.86`
overrides: precisely the rounding the constant exists to absorb, classified as a person, which under
F1 meant standing down for good.

**Fix.** `withinOverrideTolerance()` in `lib/outputs/target-state-cache.ts`, comparing against
`OVERRIDE_TOLERANCE + 1e-9`, used at all three comparison sites (daylight brightness, circadian
temperature/brightness, circadian hue). That also collapses a triplication.

---

## F5 — The daylight feedback loop ran, 95 times, and nothing said so

**Severity: medium.** Fixed in the half that was missing.

Both real daylight devices ran all week with `feedbackRisk: "increasing_sensor_response"` — in
**100%** of samples (5,511 and 5,484). For the kitchen device the sensor is measuring its own lamp,
not the sky:

| | lamp off | lamp on |
|---|---|---|
| lux, min | 1 | 1 |
| **lux, median** | **1** | **680** |
| lux, max | 1298 | 1298 |

So every switch-on starts a climb: the lamp lights the room, the room reads brighter, an *increasing*
response asks for more light. Measured:

- **95 power-on episodes**, every one followed by a climb
- median **5 writes** and **225 s** to settle; worst case **540 s** — nine minutes of visibly
  brightening lamp
- the response sat pinned at its own configured `bright` end in **62.7%** of lit samples
- all **506** of that device's writes over 3.83 days are this climb

`DAYLIGHT_DEADBAND` cannot damp it away. Loop gain was about 3 — one 0.05 aim step moved the wanted
brightness by 0.155 — so only the response's `bright` ceiling bounded it. The deadband and the slew
limit did exactly their jobs: they made the runaway a four-minute fade instead of a flash.

The pairing screen already warned about this configuration, correctly, on all five carriers. Nothing
marked the device once the loop was actually observed.

**Fix.** The daylight runtime now watches for the loop's own signature — we raised the aim, and the
reading then rose — and after five such observations sets `partial` with `state.daylightFeedback`,
which names the two honest remedies: move the sensor, or lower the bright end. Deliberately *not*
"the response is pinned at its bright end": on a sunny afternoon an increasing response sits there
legitimately, and flagging that would be a false alarm on a correctly placed sensor. The count is in
diagnostics and in the evidence as `feedbackObservations`, so the next recording can be read for it.

---

## F6 — Three documents promised memory analysis that cannot exist

**Severity: low.**

Every one of the 5,512 health samples carries `"memory": null`. It always will:
`process.memoryUsage()` throws inside the app sandbox (platform §17), and `memoryUsage()` in
`lib/support/evidence-sampler.ts` correctly returns `null` rather than losing the whole sample. But
`scripts/evidence.mjs` still computed `maxRssBytes` from it — reporting 0, permanently, in a shape
that looked like a measurement — and `week-long-testing.md` promised "memory use", "peak RSS" and
advice to watch for "growing memory".

**Fix.** `maxRssBytes` is gone from the analysis; the three doc lines are corrected and point at
`node scripts/verify-hardware.mjs memory`, which reads the footprint from outside, where it is
actually available.

---

## Two things that are not defects

Recorded so the next reader does not rediscover them as bugs.

**83% of the archive is cadence-driven and would be identical in an empty house.** `runtime_sample`
is 38.3 MB of the 63.8 MB uncompressed total, and `control_action` (14.9 MB) is reproduced in full
inside every `runtime_sample`'s `lastAction`. At this rate a full seven days is about 38 MB against
the 64 MiB cap — comfortable, but less headroom than it looks for a busier house, and the duplication
is where to start if that ever matters.

**A quiet sensor is not a fault, but it is invisible.** The Activity-room sensor exceeded one hour of
age in 44% of samples (max 11.76 h); the kitchen in 25% (max 7.78 h). That is report-on-change
behaving exactly as it should, and the reason a reading is never treated as stale. The age is on the
settings page and in diagnostics because that is the only thing that can reveal a genuinely frozen
one.

## And three that were already right

- The single failed write in 939 is the documented Hue "soft off" pre-stage refusal, carrying
  `preStage: true` — correctly excluded from `unwritableTargets()`, so no healthy lamp was reported
  as unresponsive.
- All 9 non-succeeded outcomes are `cancelled` at a scheduler stop, 7 of them in one config change.
- One `credential valid: false` sample followed by recovery, out of 5,512. That is platform §2
  behaving as documented, and the memoised handshake doing its job.

## How this was found

`node scripts/evidence.mjs analyze .evidence/<file>.ndjson.gz` gives the totals. Everything above
came from reading the timeline around them — the per-device event sequences, the interval between a
`dim` report and its `onoff`, the writes between one power-on and the next. The totals alone pointed
at none of it: `overrides: 327` looks like a busy household until the 296 are the same lamp going
off, and `dropped: 0` looks like a complete recording until the sequence numbers are counted.
