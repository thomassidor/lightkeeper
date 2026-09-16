# Code review, 16 September 2026

A general review of the whole app for bugs and other critical issues, at every severity, ranked.

**This is a work list, not a reference.** It is deleted once its findings are landed — the same
treatment `a500ed5` gave the five investigation documents, and for the same reason: a narrative of
how a conclusion was reached is not something anybody consults twice.

**Revalidated.** The first pass was run against `2ce95ed` and three commits had landed since — the
scrollbar splice, the Room-sensing Light's artwork, and the 0.6.0 notes rewrite. Every finding below
was then re-checked against `c171a1d`: all eleven, and all four latent ones, were still present, and
none of the three had touched `lib/`, `api.ts` or any `driver.ts`. The one finding that overlapped
their work — J, the spliced docblocks — was re-derived rather than re-applied, and its guard now
covers `stabiliseScrollbar()` as well.

## What the existing gates already say

`npm test` green (1674 tests, 337 suites), `typecheck`, `typecheck:test`, `lint` and
`sync:views:check` all clean, and not one `TODO`, `FIXME`, `@ts-ignore` or `eslint-disable` in the
shipped tree. So nothing below is visible to the gates. Every item is something the suite does not
currently ask about, which is why each fix ships with the test that would have caught it.

Three surveys were run across `lib/`, `app.ts`, `api.ts`, `drivers/` and the views, and **every
claim was verified by hand against the source before being listed.** Several did not survive; they
are in [Rejected](#rejected-after-checking) rather than dropped silently, because a review whose
misses are invisible cannot be judged.

---

## A. A sun anchor is accepted on the way in, throws on every evaluation, and takes the settings page with it

| Where | What |
|---|---|
| `lib/circadian/circadian-types.ts:278-293` | `sanitiseAnchor` **accepts** `{ kind: 'sun', event, offset }` |
| `lib/circadian/circadian-curve.ts:71-83` | `resolveAnchor` **throws** for a sun anchor with no `AnchorContext` |
| `lib/circadian/circadian-runtime.ts:804-808` | `resolvedPoints()` supplies a sun context only when `plan.zones` is defined |

A circadian light stores zones, and `zonePoints()` resolves them against today's sun before
`valueAt()` ever sees them. A **Colour Curve Light** has no zones, so `resolvedPoints()` returns
`this.plan.points` verbatim and `valueAt()` runs with `context = {}`.

`resolveAnchor`'s own comment asserts the opposite of what the sanitiser does:

> Throwing beats defaulting. […] `sanitiseCurve()` refuses these on the way in precisely so this is
> unreachable rather than merely unlikely.

It does not refuse them.

Two consequences, and the second is the severe one:

- `circadian-runtime-manager.ts:139-146` catches per runtime, so the device silently stops writing
  for good — the "looks configured, does nothing" failure this app exists to prevent.
- **`api.ts:156` calls `runtime.diagnostics()` unguarded inside `.map()`.** One curve device with a
  sun anchor makes `GET /` throw, so the entire app settings page — every device card, the
  credential box, the orphan sweep — fails to render.

Reachable without a hand-edited store: pair sessions are a scriptable Web API surface (platform §14),
and `setCurve` accepts exactly what the sanitiser accepts.

**Fix.** Refuse a sun anchor in `sanitiseCurve` for a points-based plan, matching the comment that
already claims it. Separately, guard each `diagnostics()` call in `getStatus` so one bad device
degrades to one bad card — worth doing on its own merits.

## B. The orphan sweep deletes without approval when the request body is empty

`api.ts:309-317` passes `undefined` for `approved` when the body carries no `token`/`flowIds`, and
`flow-bridge-manager.ts:832-843` then skips **both** the stale-preview token check and the
approved-id intersection. Every orphan it finds is deleted.

The comment justifies it as *"an older page must not be broken by a newer app"* — but nothing has
ever been published, so there is no older page. The escape hatch protects a population of zero while
leaving the app's most destructive route callable with no approval at all, on a surface reachable by
anyone holding a Personal API Key. `countOrphans`'s own docblock states the rule it breaks:

> `token` and `flowIds` are handed back to the sweep, which refuses a stale one: the user approved a
> specific set, not a number.

**Fix.** Refuse at the API boundary when either is absent. The manager's parameter stays optional —
the suite drives it directly and that is legitimate.

## C. Two socket leaks when a pasted API key is rejected

`lib/credential-service.ts:289-299`.

- **`:292-297`** — `createWriteClient` *succeeded*; only `validate` threw. The live client is dropped
  without `destroy()`.
- **`:299`** — the superseded-candidate path abandons a live client the same way.

This is the leak the same file documents six lines further down:

> A key being replaced leaves the PREVIOUS key's client connected unless it is closed here — this is
> the assignment that made "re-mint a key" leak one socket every time.

Two paths did not get that treatment, and the likelier of them is the commonest user error: a
read-scoped key connects fine and fails the write probe (platform §1), so every retry leaks a
`SocketSession`.

**Fix.** Discard the candidate on both paths.

**Related, lower.** `:287` bumps `this.generation` *before* the candidate is proven, so a typo in the
settings box discards an in-flight `revalidate()` of the good stored key — contradicting the class
header's *"a candidate never disturbs the incumbent."*

## D. The circadian preview snapshot is app-scoped, and writes one session's lamps from another's

`drivers/circadian/driver.ts:82` holds `restore` on the **driver**, which is a Homey singleton. Its
own docblock says what the scope should be:

> Taken ONCE, before the first preview write, and held for the life of the pairing session.

It is held for the life of the *app*. `:347` only snapshots when `restore` is null, `restorePreview`
is the only thing that clears it, and this driver registers no `disconnect` handler — only
`drivers/daylight/driver.ts:426` does.

So: abandon the try-it screen without pressing "Put them back", start another session, press it
there — and the app writes **the previous session's lamps back to the previous session's values**,
leaving the current session's lamps scrubbed.

**Fix.** Move `restore` onto the per-session `state`, which already outlives a handler call. While
there: `putBack` counts a lamp as restored when nothing was written, and `:353` reports
`written: lamp.on` — the pre-preview power state under a name that reads as a write result.

## E. `retimed` is computed and never read, so every refused boundary triggers a full Flow reconcile

`lib/schedules/schedule-runtime.ts` declares the flag at `:553`, sets it at `:597`, and fires the
reconcile unconditionally at `:542`. The docblock two lines above says what was intended:

> A retimed Flow is the one refusal worth reconciling for. Every other refusal describes a Flow that
> is fine.

`grep` finds no read site anywhere in `lib/` or `test/`. A paused schedule, a wrong-day boundary or
an unresolved timezone each provoke a full `bridge.sync()` — API traffic and potential Flow
rewrites — twice a day, forever.

**Fix.** Gate the reconcile on `outcome.retimed`, with a test that fails if the flag goes unread
again.

## F. The sensor week's row labels use rigid 24-hour steps while its rows are filled by local midnight

`lib/daylight/sensor-history.ts:122` labels row *k* from `nowMs - k * 86_400_000`. But `rowFor`
(`:173-178`) reduces both instants to their **own local midnight** and rounds, with a comment saying
exactly why:

> a clock change inside the week makes one of the differences 23 or 25 hours, and flooring would
> silently shift every row before the change by one.

The labels never got that treatment. Worked, Europe/Copenhagen, now Monday 31 March 2025 00:30 local:
`nowMs - 86_400_000` lands at **Saturday** 23:30, because the spring-forward Sunday was 23 hours
long — so the row that `rowFor` fills with Sunday's samples is labelled Sat, and every row before the
transition shifts with it. Twice a year, on the grid that exists to be the evidence for the two lux
thresholds.

**Fix.** Derive the labels from the same local-midnight walk `rowFor` uses.

## G. The controller's save handler lost the whitespace-name fix

`drivers/controller/driver.ts:719` is `name || await this.deriveName(state)`. The shared
`registerSaveHandler` (`lib/pairing/pair-session.ts:331`) is `name?.trim() || …`, and carries the
comment:

> `.trim()` before the `||`: a whitespace-only name is truthy, so it was accepted verbatim and
> produced a device whose tile appears to have no name at all.

The controller is the one driver not on the shared handler, and it carries the pre-fix line.

## H. A flow card argument's `name` is not coerced, and a sort then throws on it

`lib/flow-card-catalogue.ts:215-216` assigns `a?.name` and `a?.type` raw into `CardArgument`, whose
fields are declared `string` (`lib/inputs/magnitude-collapser.ts:22-23`). Every sibling field in the
same projection goes through `String(… ?? '')`, including the tokens four lines below.

`lib/source-discovery-service.ts:357` and `:400` then do `a.name.localeCompare(b.name)` while
building the event-surface fingerprint. A third-party trigger card with two or more arguments, one
of them nameless, throws a `TypeError` inside `discover()` — which is the remote picker, the health
check's re-attach scan and the reconcile path, for the whole Homey.

## I. `flowJournal:<id>` settings keys are never removed

`lib/bridge/flow-bridge-manager.ts:286` and `:294` are the only two references to that key in the
tree: a `get` and a `set`, no `unset`. `DeviceLifecycle.deleted()` removes the Flows and the runtime
but not the journal, and the in-memory `journals` map is never evicted either. Every controller and
schedule ever created leaves a permanent `homey.settings` entry holding its full reference list.

## J. Four stale, duplicated copies of the week-grid docblock ship in four view files

`views/shared/week-grid.js` carries one docblock, correctly **inside** the function. Its four
carriers — `drivers/daylight/{pair,repair}/{response,sensordetail}.html` — carry **five**: the real
one, plus four leftovers above it that contradict it ("It takes NO arguments beyond the element and
the payload" against "it closes over the `node` every carrier already has"). `stabiliseScrollbar()`,
the fourth spliced helper, already does it the right way — so the convention holds and only these
four copies are wrong.

They accumulated while the shared source still had its docblock above `function`, which is the trap
CLAUDE.md warns about. `spliceFunction` (`scripts/sync-views.mjs:170-182`) matches from `function`,
so it can never remove what sits above it, and `sync:views:check` cannot see the drift because all
four carriers drifted identically. Dead weight in the shipped archive, and misleading to read.

**Fix.** Delete the leftovers, and add the check that makes a recurrence fail loudly.

## K. A driver that will not enumerate shrinks the sweep's protected set, and only logs

`api.ts:81-90` says what it intends:

> Best-effort per driver: a driver that will not enumerate must not silently SHRINK the protected
> set, so a failure is logged and the runtime ids stand.

A log is not a refusal. If `getDriver('schedule').getDevices()` throws, every schedule device without
a live runtime becomes unattributable — and the "nothing is running" guard does not fire, because the
controllers are live. The two-step approval is computed from the same shrunken set, so the preview
agrees with the mistake.

---

## Latent — real, not currently reachable, cheap to make impossible

**L. `CommandScheduler.flush` assigns `activeFlush` after calling `runFlush`.**
`lib/outputs/command-scheduler.ts:310-312`. If `runFlush` ever returns without awaiting
(`snapshot.length === 0` at `:321`), its `finally` nulls the field *before* the assignment, leaving a
resolved non-null promise — after which `schedule()` early-returns for that device **for ever** and
that lamp is never written again. Traced every caller: `drain()` clears the timer before flushing
(`:427-429`), `cancelTarget` and `stop` clear both, and `submit` always populates `pending` first. It
is closed today by four separate call sites agreeing. A one-line reorder makes it structural.

**M. `PressListener` can arm its window timer after `stop()` has run.**
`lib/pairing/press-listener.ts:87-95`. A `stop()` landing during `watch()`'s `await` at `:108` lets
that candidate's subscriptions be pushed into the post-stop `offs` array, and the timer is armed
regardless. Bounded — the stray timer drains it within `WINDOW_MS`, and `start()` calls `stop()`
first — but the class header promises *"every subscription released on stop however stop is
reached."*

**N. Synchronised group mode can plan `{ dim: 0, impliesOn: true }`.**
`lib/outputs/intent-planner.ts:295-298` bypasses `advanceDim`'s move guarantee, and the `next <= 0`
guard at `:307` only covers `delta < 0`. An off lamp declaring `decimals: 1` can therefore be
switched on at darkness. Needs the non-default synchronised mode.

**O. Two unguarded API inputs.** `api.ts:311` takes an uncapped `flowIds` array where every other
list input goes through `requireArray(value, path, max)` (`lib/validation/guards.ts:80`); `api.ts:578`
spreads a possibly-undefined stored plan into `applyPlan`.

---

## Rejected after checking

Recorded so the net is legible.

- **"Timer handles are assigned after the schedule everywhere, so production wedges."** Production
  timers are asynchronous; only the injected test doubles fire synchronously, and the suite is green.
  Latent only — kept as L and M, dropped elsewhere.
- **"`orphansAmong`'s `!flow.ownerDeviceId` branch can delete a user's Flow."** Dead branch:
  `looksGenerated` (`flow-bridge-manager.ts:232-243`) already requires a well-formed Lightkeeper id,
  so a generated flow always has one.
- **"The `lamp_off` override suppression was narrowed to `dim` and is a regression."** `git log -L`
  shows it was always scoped to `dim`, and `overrideSuppression` covers the power-settling window on
  the other axes.
- **"`LuminanceSource` re-subscribes to a sensor it has just marked unavailable and enters backoff."**
  Whether `makeCapabilityInstance` throws for an unavailable device cannot be settled off-hardware.
  A line in the hardware pass, not a code change.
- **The Room-sensing Light's placeholder artwork.** A publish blocker, but already recorded in four
  places including `artwork/provenance.md`.
