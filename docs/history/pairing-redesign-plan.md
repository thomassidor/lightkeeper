# Lightkeeper pairing redesign

## Context

`Lightkeeper App UX Review.zip` contains two Claude Design canvases. **`Lightkeeper pairing
flows.dc.html` is the settled work** — all five device types, one row each, happy flow plus special
cases — and `Lightkeeper pairing redesign.dc.html` is the iteration archive (turns 1–4, seven
day-editor options) that explains why each decision was made. The settled design supersedes the
archive wherever they disagree.

Today's pairing puts the abstract control first: two unlabelled sliders for a whole day, a
function-first mapping grid, two lux numbers with nothing to judge them against, and an API-key
chore before any value is visible. The redesign applies one rule without exception — **a screen
holds one control and at most one sentence; everything secondary is a row with a chevron; every
caveat leaves pairing** — and wraps each driver in an unnumbered intro plus numbered steps plus a
review. Roughly 70% of the copy leaves the screens; none of it is deleted, it moves to the review
screen, to the device settings page, or into controls obvious enough not to need a paragraph.

The visual language does **not** change: the design's palette (`#2a1958`, `#3b2279`, `#16181d`,
`#6a7180`, `#eceef2`, `#f7f8fa`) is already `views/shared/base.css`'s `--lk-*` token block. This is
structural work, not a re-skin.

Four of the five engines change shape with it, because several screens cannot honestly be drawn
otherwise — a circadian day strip with sunrise and sunset on it needs sun-anchored boundaries, and a
lux threshold pre-filled from a sensor's own week needs the week.

**Decisions taken (from the user):** one big landing, not phased. `fromDaylight` removed outright
from the circadian, curve and schedule stores. "Select all" in a room stores a zone target. The
Insights-backed sensor week is built and the permission accepted. Days move to the device and
overlapping schedule blocks are allowed. Two new controller jobs, with arguments. One daylight
sensor, with the stored shape changed to match. Palette expands to 24, every swatch a real colour.
**No migrations at all** — the one Homey running this app starts from a clean slate.

---

## The flow, per driver

Intro is unnumbered; the steps it promises are the ones that carry a dot. Homey asks the device
name afterwards, so pairing never does (already true — `registerSaveHandler` derives it).

| Driver | Flow | Pushed / special |
|---|---|---|
| Circadian | intro → **1** lights → **2** day → **3** review | `tryit` (scrub the day onto the lamps) |
| Curve | intro → **1** lights → **2** curve → **3** review | — |
| Daylight | intro → **1** lights → **2** sensor → **3** response → **4** review | `sensordetail` (a sensor's week before committing) |
| Schedule | intro → credential → **1** lights → **2** blocks → **3** review | — |
| Controller | intro → credential → **1** remote → **2** lights → **3** buttons → **4** review | `job` (one gesture's job), `listen` (press-to-find) |

**The credential screen stays early, and this is a deliberate departure from the design.** The
canvas moves it behind the work, on the grounds that the key only gates Flow *writes* at save. That
is true and it is the wrong trade: a user who reaches a four-step review and then cannot produce a
key loses everything they just set up. So it sits between the intro and step 1 — the intro still
shows what the device does before any chore is asked for, and nothing can be lost to it.

It is **unnumbered and self-skipping**, so it costs a returning user nothing: `credential.html`
already calls `Homey.showView(nextView)` immediately when a stored key is valid
(`credential.html:299`), and the key is per-Homey rather than per-device, so every controller and
schedule after the first passes straight through. `nextView` is `'remote'` for the controller and
`'lights'` for the schedule — it is already a parameter of `registerCredentialHandlers` for exactly
this reason (platform §8), because the view is byte-shared between the two drivers.

---

## Views

`views/shared/daylight-card.{css,html,js}` are **deleted** — `fromDaylight` is gone, and the Daylight
light's own screens become bespoke. That removes the single largest piece of `sync-views` plumbing.

Three of the new screens are **shared views driven by a driver-supplied payload**, joining
`credential.html` in `SHARED_VIEWS` (`scripts/sync-views.mjs:69`), copied from the controller into
every driver that declares them:

- **`intro.html`** — answered by a new `getIntro` handler returning `{ title, blurb, hero, steps[] }`.
  `hero` names one of five small renderers living in the one file (day strip, bar chart, lux ramp,
  schedule blocks, button rows).
- **`lights.html`** — replaces `targets.html`. Search box, room accordions with per-light capability
  subtitles and a per-room "Select all", collapsed rooms below with counts. Also carries the
  "No lights yet" empty state (heading swap + two chevron rows + Close), so it is not a separate
  file.
- **`review.html`** — answered by `getReview` returning `{ stepIndex, stepCount, hero?, rows[],
  footer, cta }`. Every row is `label · value · chevron`; the chevron jumps back to the step that
  owns it. It saves and creates the device directly — with the key screen back at the front, there
  is no credential branch here.

Per-driver screens, authored once each and byte-copied into `repair/`:

`circadian/day.html`, `circadian/tryit.html`, `curve/curve.html` (rewritten),
`daylight/sensor.html`, `daylight/response.html`, `daylight/sensordetail.html`,
`schedule/blocks.html` (replaces `schedule.html`), `controller/remote.html` (from `source.html`),
`controller/buttons.html` (replaces `mapping.html`), `controller/job.html`, `controller/listen.html`.

That is **15 authored views** (was 8) and **56 files** on disk once `repair/` copies are made (was
26). Every `driver.compose.json` `pair` and `repair` array is rewritten; pushed screens must appear
in the array to be served at all.

`views/shared/base.css` grows the new primitives so no view carries a literal: step dots, the
`label · value · chevron` row, the pill switch used by every "Set … too" toggle, the value slider
with its two end captions, the swatch row, and the day-strip frame.

---

## Engine changes

### 1. Sun-anchored boundaries — the one genuinely new capability

`CircadianAnchor` already declares `{ kind: 'sun'; event; offset }`
(`lib/circadian/circadian-types.ts:43`) and it is refused in exactly three places, so it can never
half-work. All three are lifted:

- `sanitiseAnchor` — `circadian-types.ts:260`
- `validateAnchor` — `lib/validation/plans.ts:435`
- `resolveAnchor` — `lib/circadian/circadian-curve.ts:71` (throws without an `AnchorContext`)

`AnchorContext { sunriseMinute?, sunsetMinute? }` exists and is threaded through
`resolvePoints`/`valueAt`/`nextPointAfter`, but every call site passes `{}` —
`circadian-runtime.ts:767`, `:1752`, `:1771`. Those get a real context.

**New pure function in `lib/daylight/solar-elevation.ts`:**
`sunTimes(latitude, longitude, dayMs): { sunriseMs, sunsetMs } | null`. The file computes elevation
and azimuth for an instant and nothing else today; this is the standard hour-angle solution over the
same NOAA sequence, returning `null` on a polar day or night where no crossing exists. Pure, no
Homey imports, provable against a published table — the same contract the rest of the file keeps.

**The no-sunrise fallback** (polar latitude, or a Homey that has never been told where it is —
`usableLocation` refuses `0,0`): fall back to fixed clock minutes, 06:00 and 21:00, which are
today's `SIMPLE_SHAPE` values. Stated on the review screen and in the FAQ rather than hidden.

### 2. Circadian: two ends → three zones

`SimpleCircadianPlan` (`lib/circadian/simple-curve.ts:50`) is rewritten:

```ts
export interface CircadianZone { temperature: number; brightness?: number }

export interface SimpleCircadianPlan {
  schemaVersion: number;
  enabled: boolean;
  target: TargetSpec;
  morning: CircadianZone;   // midnight → morningEnd
  midday:  CircadianZone;   // morningEnd → eveningStart
  evening: CircadianZone;   // eveningStart → midnight
  morningEnd:   { event: 'sunrise'; offset: number };   // minutes, stepped by 15
  eveningStart: { event: 'sunset';  offset: number };
  adjustBrightness: boolean;
  preStage: boolean;
}
```

`SIMPLE_SHAPE` — a constant list of four clock minutes — goes. `expandSimplePlan` derives **six**
points instead, holding each zone flat and ramping ±`ZONE_RAMP` (50 min, matching the design's own
`warmthAt`) either side of each boundary:

```
(morningEnd − R)   morning    (morningEnd + R)   midday
(eveningStart − R) midday     (eveningStart + R) evening
(00:00 − R)        evening    (00:00 + R)        morning
```

The last pair is not in the design and is deliberate: the design's `warmthAt` reads morning from
midnight and evening up to midnight, which is a **step change at midnight** now that the two are
independent temperatures. The engine's interpolation is cyclic, so a symmetric ramp across midnight
is the same rule applied a third time rather than a special case.

Brightness becomes **per zone and opt-in**, off by default (a circadian light changes colour;
touching brightness is a choice). `adjustBrightness` keeps its all-or-nothing rule — the engine
interpolates brightness only where both bracketing points carry one.

The two anchors are what `day.html` drags. The offset stepper is ±15 min, clamped so the zones
cannot cross (`bounds()` in the design's own script is the reference).

### 3. Remove `fromDaylight` and the inline response

Deleted from `CircadianPoint` (`circadian-types.ts:78`), `CircadianEnd`/zone, and `ScheduleEntry`
(`schedule-types.ts:82`); the `daylight?: DaylightResponse` field goes from `CircadianPlan`,
`SimpleCircadianPlan` and `SchedulePlan`. With it go:

- `brightnessWithDaylight()` and `optionalDaylight()` — `lib/validation/plans.ts:621`, `:665`
- `CircadianRuntime.resolvedPoints()`'s daylight substitution — `circadian-runtime.ts:787`
- `ScheduleRuntime.brightnessFor()`'s four fallback paths — `schedule-runtime.ts:776`
- `registerDaylightCardHandlers()` — `lib/pairing/pair-session.ts:212`, and the three drivers'
  duplicate `setDaylight` registrations that currently shadow it
  (`schedule/driver.ts:161`, `circadian/driver.ts:190`, `curve/driver.ts:185` — note these three
  copies omit the membership check the shared handler exists to perform, so this deletes a live bug
  as well)
- the `daylight.*` locale keys used by the card, and `circadian.*`/`schedule.*`'s follows-the-daylight rows

The `DaylightEvaluator` stays wired into `curves` and `schedules` registries only if nothing else
needs it — it does not; drop those two constructor arguments (`app.ts:284`, `:299`).

### 4. Daylight: one sensor, two sun thresholds, a room-sun answer

```ts
export interface DaylightResponse {
  sensor: string | null;      // was sensors: string[], meaned over up to 8
  darkLux: number;
  brightLux: number;
  darkElevation: number;      // NEW — was the DARK_ELEVATION constant, −6
  brightElevation: number;    // NEW — was BRIGHT_ELEVATION, 25
  dark: number;
  bright: number;
  sunPeak: SunPeak;           // 'morning' | 'midday' | 'afternoon' | 'flat'
}
```

- `MAX_SENSORS`, the duplicate-weighting guard and `LuminanceSource.read()`'s mean all go;
  `read(deviceId)` returns that sensor's reading or `null`.
- The two elevation constants become per-device for the same reason `brightLux = 500` is a kitchen
  number (platform §16): a north-facing room and a west-facing one do not share a sun. The screen
  steps them and labels each with **the clock time it happens today** ("Dark from: Sunset +30m",
  "The middle of the day: Noon ±2h"), which is what `sunTimes()` from §1 is also for.
- `SunPeak`'s `'none'` is replaced by `'flat'` — the design's honest fourth answer, "Hardly any". A
  room with no direct sun still brightens and darkens, so `orientationFactor` returns the
  `DIFFUSE_SHARE` floor (0.35) flat rather than 1. The question is asked only in sun mode; with a
  sensor picked it is not asked and not consulted.

### 5. Sensor history from Insights

New `lib/daylight/sensor-history.ts`, pure apart from one injected reader:

- `insights.getLogEntries({ id, resolution: 'last7Days' })` → `{ values: [{ t, v }] }`. §16 already
  records this working against four real sensors, but through a Personal API Key — **the first task
  is a one-command spike proving the app's own token can read a foreign device's log, and what
  bucket size `last7Days` returns** (`last24Hours` is 5-minute buckets and coarser resolutions
  bucket-average).
- Bucket to 7 × 12 two-hour cells (84 cells stay legible at 390px; 168 do not). A cell with no
  sample is **missing**, drawn hatched, never dark — a gap must not read as "pitch dark".
- Derive `darkLux`/`brightLux` from the week's own distribution and the verdict sentence
  ("A clear day and night pattern. 6 lx at night, 150 lx around noon"), plus the two refusals the
  design draws: *barely changes all week* (a cupboard sensor) and *stopped reporting* (half a day of
  silence — not an hour; a still room legitimately goes quiet for hours).
- `lib/homey-api-service.ts:103` connects `['devices','zones','flow','flowtoken']`; add `insights`.
  `.homeycompose/app.json` `permissions` gains the Insights permission. This widens App Store review
  on an app already flagged for it — say so in `docs/homey-review-notes.md`.

### 6. Schedule: days per device, overlap allowed

- `days` moves off `ScheduleEntry` onto `SchedulePlan` as one `IsoWeekday[] | null`.
  `boundaryDayMatches()` (`lib/schedules/schedule-window.ts:50`) and `schedule-bindings.ts` read the
  plan-level set. The per-day-arc overlap maths in `entriesOverlap()` simplifies accordingly.
- `sanitiseEntries` stops dropping the later of an overlapping pair
  (`schedule-types.ts:181`); `entriesOverlap()` survives only to **report** the clash to the screen,
  which draws the region and says the later block wins. `activeEntries()` already sorts
  latest-started-first, so that is the runtime's behaviour today and the sanitiser was the only
  thing preventing it being reached. `Next` is never blocked.
- Brightness and colour become optional per block on the same pill switches circadian and curve use.
  Off-times are always `{ kind: 'time' }` from the new screen; `{ kind: 'duration' }` stays in the
  model unused by pairing.

### 7. Controller: two new jobs, and the grid inverted

`lib/mapping/mapping-types.ts` gains two `LightFunction` values:

| value | needs | label |
|---|---|---|
| `brightness_set` | `dim` | A set brightness |
| `temperature_cycle` | `light_temperature` | Step through warm and cool |

`MappingRule` gains `preset?: { brightness: number; temperature?: number }`, **required** when
`function === 'brightness_set'` and refused otherwise — validated in `plans.ts` beside the existing
rule checks. Name it `preset`, not `args`: `fixedArgs` already means flow-card arguments one layer
over and the collision would be genuinely confusing.

`buttons.html` inverts today's grid: **one row per thing the remote can do**, in device order, each
showing its job in a sentence. "Nothing" is a finished state, not a warning. `lib/pairing/mapping-screen.ts`
is replaced by a `buttons-screen.ts` that projects the source's event surface into those rows.
`job.html` is the pushed editor for one row, carrying the seven-plus-two job list and a "Try it now".

`listen.html` is bounded and escapable — a 30-second countdown, a live "heard nothing yet" line, and
"Pick from the list instead" always one tap away. Capability-based events are observable directly;
card-only remotes (platform §4) cannot be, which is exactly why the list escape is permanent.

### 8. Palette: 24 colours

`lib/circadian/palette.ts` grows from 8 to 24 entries, all saturated hues (the user's call: every
swatch behaves identically). Eight are shown; "Show more colours" folds the other sixteen out **in
place**, never on a second screen. The default curve becomes the five-point coloured set the design
draws, so the first thing a Curve light shows is that it does colour. `warmth` stays required on
every point — it is what a temperature-only lamp gets and what neighbouring segments interpolate
towards.

### 9. Zone targets behind "Select all"

`lib/pairing/target-picker.ts` grows the payload the new screen needs (search corpus, per-room
counts, per-light capability subtitle). When every light in one room is ticked and no other room has
anything ticked, `spec()` emits `{ kind: 'zone', zoneId, includeSubzones: false }` rather than the
device list, so a lamp added to that room later is picked up. Unticking one light converts it back
to `{ kind: 'devices' }` — `review.html` states which of the two the device ended up with, because
the difference is invisible otherwise. Note the existing asymmetry that makes this safe: a zone
target already requires `isLightClass`, an explicitly-picked device only requires `onoff`
(`device-catalog.ts:197`).

### 10. No migrations

Every chain is reset rather than extended. In each of `circadian-migrations.ts`,
`curve-migrations.ts`, `schedule-migrations.ts`, `daylight-migrations.ts` and `profiles/migrations.ts`:
set `CURRENT_*_SCHEMA_VERSION = 1`, empty the `steps` table, keep the validator. `runMigrationChain`
already refuses a plan whose `schemaVersion` is newer than it can read (`lib/support/migrations.ts:101`)
and `DeviceLifecycle` quarantines on that — so an existing device carrying v2–v4 comes up
unavailable with a message, which is the "delete and re-add" signal. Say it in the changelog.

---

## Supporting work

| Area | What changes |
|---|---|
| `scripts/sync-views.mjs` | `SHARED_VIEWS` becomes `['credential.html','intro.html','lights.html','review.html']`; the three `daylight-card` blocks are removed from `BLOCKS`; `targets.html` entry goes |
| `scripts/pair-view-fixtures.mjs` | One entry per view — 28, from 13 |
| `test/unit/pair-view-boot.test.ts` | `FIRST_CALL` table rewritten to 28 entries |
| `test/unit/pair-view-styles.test.ts` | Daylight-card identity assertions removed; the new shared helpers added to the byte-identity list |
| `test/unit/pair-view-behaviour.test.ts` | Largely rewritten — 1,305 lines covering screens that no longer exist |
| `test/unit/repair-views.test.ts` | Passes unchanged if `sync:views` is run; it discovers from the manifest |
| `locales/en.json` | Near-total rewrite of `credential`/`source`/`targets`/`mapping`/`schedule`/`circadian`/`curve`/`daylight`; new `intro`/`review`/`lights`/`buttons` namespaces. `locales.test.ts` enforces both directions |
| `.homeycompose/app.json` | Insights permission; regenerate `app.json` via `npm run validate` |
| `drivers/*/driver.compose.json` | `pair` and `repair` arrays rewritten for all five |
| Docs | `CLAUDE.md` (the layout tree, the daylight-card paragraph, the "four device types share one stored shape" paragraph, and four of the Safety-properties bullets), `docs/homey-platform.md` §8/§12/§16, `README.md`, `FAQ.md`, `README.txt`, `CHANGELOG.md` + `.homeychangelog.json` **under 0.6.0** (no version bump — it was not asked for), `docs/hardware-test-plan.md` with new T-numbers continuing from the highest already used |
| Design source | Extract the zip into `docs/design/` so the canvases are the durable visual reference the views cite, and delete the zip from the repo root |

---

## Order of execution

0. **Save this plan into the repo** as `docs/history/pairing-redesign-plan.md`, alongside the
   extracted canvases, so the reasoning behind the rewrite survives the session.
1. **Spike Insights** against the real Homey — app token, foreign device, `last7Days` bucket size.
   Everything in §5 depends on the answer, and the permission decision follows from it.
2. **Pure engine work, with tests, before any view**: `sunTimes()`, the sun anchor lifted through
   all three refusals, the three-zone `expandSimplePlan`, the `fromDaylight` deletion, the daylight
   shape change, the schedule day/overlap change, the two controller jobs, the palette. This is
   where the suite stays green continuously.
3. **Reset the five migration chains.**
4. **Shared views**: `base.css` primitives, then `intro.html`, `lights.html`, `review.html`, then
   re-point `credential.html`'s `nextView` at the new first step.
5. **Per-driver step screens**, circadian first (it exercises the day strip, the pill switch, the
   zone rows and the pushed `tryit` — every primitive the other four reuse).
6. **`npm run sync:views`**, fixtures, boot table, behaviour suite, locales.
7. Docs and changelog.

---

## Verification

- `npm test` — `locales.test.ts` (no unused key, no undefined reference), `pair-view-boot.test.ts`
  (every view reaches its first `emit()`), `pair-view-styles.test.ts` (every selector scoped to its
  root, no colour literal outside the token block, no `prefers-color-scheme`),
  `repair-views.test.ts` (byte-identical repair copies, `sync({check:true})` clean),
  `webview-safety.test.ts`, `compose-manifest.test.ts`, `release-metadata.test.ts`.
- `npm run typecheck && npm run typecheck:test && npm run lint && npm run validate`.
- `npm run sync:views:check` must exit 0.
- `npm run render:views` → look at `.views/` contact sheet against the canvas artboards side by side.
  This is the only thing that catches a screen that boots and draws wrongly.
- `node scripts/verify-hardware.mjs full --yes` — pairs and repairs one of each device type over the
  Web API (platform §14), which now has to survive the rewritten view sequences.
- **On the phone, with `npx homey app install`** (never `run` — it uninstalls on exit and takes the
  stored key with it): every flow end to end, plus the three things a script cannot check —
  that a horizontal drag on the day strip does not also scroll the pairing sheet (`touch-action:
  none` if it does), that a second controller with a key already stored passes straight through the
  credential screen without a visible flash, and that the day strip's sunrise and sunset marks agree
  with the Homey's own.
