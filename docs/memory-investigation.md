# Where this app's memory actually goes

A second investigation, run on 15 September 2026, deliberately starting from nothing. Every
conclusion in `docs/homey-platform.md` §15 was set aside and re-derived, because the first
investigation had answered "how much memory does Lightkeeper use?" without ever answering "compared
with what?".

**The headline: a Homey app that does nothing at all costs 30.6 MB of PSS. Homey's guideline is
30 MB. Lightkeeper's own code — every cache, every runtime, every subscription — accounts for
under 1 MB of the difference between that empty app and this one.**

---

## 1. The method, which is the part worth keeping

Everything below comes from **a second app installed beside Lightkeeper on the same Homey, measured
in the same minute**. That is the whole trick, and it is why this pass could answer questions the
previous one could not.

The reference Homey sits at 11% free memory with 450 MB of swap in use, and under that pressure a
single PSS reading is worth very little: three restarts of one identical build read **71.4, 73.9 and
80.1 MB**. An absolute number cannot survive that. A *difference between two apps read seconds
apart* survives it fine, because both are subject to the same machine.

The control app — `com.thomassidor.memprobe`, ~40 lines — exposed one Web API route that added one
layer at a time (`require` the client library, construct a client, connect managers, read a
catalogue, construct a second client) and reported `v8.getHeapStatistics()` after each. PSS was read
from outside after every step. It was uninstalled afterwards.

**Rebuild it before believing any future memory claim.** An app that does nothing is the only
calibration that exists.

---

## 2. The ladder

One process, layers added in order, PSS read from outside after each. Marginal cost in the right
column.

| layer | PSS | Δ |
|---|---|---|
| a bare Homey app — `require('homey')`, one empty `onInit` | **30.6 MB** | — |
| `require('homey-api/lib/HomeyAPI/HomeyAPI')` — the deep path | 30.8 | +0.1 |
| **`createAppAPI()` — the first client** | 39.5 | **+8.8** |
| `connect()` on devices, zones, flow, flowtoken, insights | 41.2 | +1.7 |
| `getFlowCardTriggers()` — 1816 cards, result dropped | 51.7 | +10.5 |
| `getDevices()` — 119 devices, result dropped | 53.2 | +1.5 |
| **`createAppAPI()` — a SECOND client** | 53.3 | **+0.0** |
| `connect()` on the second client | 53.4 | +0.1 |

Then the same reads again, on the same process:

| repeat | PSS | Δ |
|---|---|---|
| cards, 2nd time | 55.7 | +2.3 |
| cards, 3rd time | 56.9 | +1.2 |
| cards, 4th time | 56.9 | +0.0 |
| devices | 56.9 | +0.0 |
| devices | **45.1** | **−11.8** |

And left idle afterwards, the control app settled at **43.5 MB** — having created two clients and
performed five bulk reads — while **Lightkeeper with no devices sat at 44.3 MB** in the same
minute.

---

## 3. Five things this overturns

### 3.1 The 30 MB guideline is not reachable by any app, and never was

An empty app is 30.6 MB, measured minutes after it started. This is not a Lightkeeper problem, and
no amount of care with caches can address it.

**The peer comparison needs care, and the obvious version of it is wrong.** Reading the other apps'
`pss` and concluding that several live under 10 MB is an error, because **Lightkeeper is the only
app on this Homey with a `pssSwap` of 0** — it is the one being restarted. Everything else has been
running for days and has been partly paged out:

| app | `pss` | `pssSwap` | `pssTotal` | `rss` |
|---|---|---|---|---|
| Spotify | 10.1 | 8.8 | 18.9 | 27.8 |
| Circadian Lighting | 12.4 | 5.2 | 17.6 | 29.7 |
| CountDown | 12.7 | 13.3 | 26.0 | 30.5 |
| IKEA Home Smart | 18.3 | 10.4 | 28.7 | 36.0 |
| Philips Hue | 26.2 | 9.9 | 36.1 | 44.3 |
| Tuya | 16.4 | **29.7** | 46.1 | 34.5 |
| Reolink | 57.4 | 27.1 | 84.4 | 75.5 |
| **Lightkeeper** | **57.8** | **0.0** | **57.8** | 76.3 |

On `pssTotal` — resident plus swapped — the median is about 36 MB and Lightkeeper is second of
thirty-two. That is a much less flattering position than `pss` alone suggests, and it is the honest
one.

**But `pssTotal` still is not like-for-like, and this is the open question in this document.** Swap
accounts for dirty pages that were written out; it does not account for *clean* file-backed pages —
compiled code, mapped libraries — which the kernel can simply evict and reload from disk for free.
Those show up in neither `pss` nor `pssSwap`. So a long-idle app's total understates it by an
unknown amount, and a freshly restarted app's does not understate it at all.

Which means the two readings that can be trusted are the ones taken **on two apps of the same age,
in the same minute** — and by that measure Lightkeeper (44.3) sits 0.8 MB above a control app that
had made the same API calls (43.5). *What is not yet established is whether a freshly restarted
Spotify would read 18.9 MB or 30-something.* Until someone restarts a peer app and measures it
immediately, "an empty app costs 30.6 MB" is proven for **this** empty app and merely plausible as
a platform floor.

**Either way, stop treating 30 MB as a target read off `pss`.** The measurable target is marginal
cost over a control app measured at the same time.

### 3.2 "V8 never gives the pages back" is false on this platform

That claim is the foundation of §15, and it is the reason a lot of code avoids transient
allocations. It was measured on a laptop, where it is true.

On the Homey, **PSS fell 11.8 MB spontaneously**, on an idle process, with no GC requested and
nothing freed by the app. A pressured kernel reclaims pages; RSS is not a high-water ratchet here.
Repeat catalogue reads cost +2.3, then +1.2, then +0.0 MB — each one cheaper than the last, because
the process is reusing pages it already has.

**Consequence: avoiding a transient peak is worth far less than §15 assumes.** That is the single
biggest correction here, and it retires the reasoning behind several existing decisions.

### 3.3 The two-client design is free

A second `HomeyAPIV3Local` — its own `SocketSession`, `SubscriptionRegistry`, `DiscoveryManager`
and manager set — cost **+0.0 MB**. The library's modules are already loaded; a second instance is
a handful of objects. The read/write client split (platform §1) costs nothing and needs no defending
on memory grounds.

### 3.4 The catalogue read is not a permanent 12 MB floor

The +10.5 MB in the table is the cost of **growing a small heap to fit a parse**, not the cost of
the catalogue. The control app's heap was 11 MB when it first read the cards; Lightkeeper's is
already ~13 MB by the end of `onInit`, so the same read lands in slack it already has. That is
exactly why the streaming reader built and reverted on 14 September measured neutral on hardware.

### 3.5 The cost is the transport libraries, not Athom's client

`createAppAPI` is the single biggest app-attributable item at +8.8 MB, and almost none of it is
`homey-api`'s own code. Measured on a cold process:

| require | modules | heap | RSS |
|---|---|---|---|
| `socket.io-client` alone | 53 | +2.78 MB | **+13.75 MB** |
| `node-fetch` alone | 9 | +2.30 MB | +10.17 MB |
| `homey-api/lib/HomeyAPI/HomeyAPIV3Local` (pulls both) | 148 | +4.01 MB | +18.09 MB |

`HomeyAPIV3` declares only **nine** manager classes, not the fifty the specification lists, so the
"50 managers per client" concern is unfounded. The mass is socket.io and node-fetch.

---

## 4. Every strategy considered, with what it is worth

Ordered by measured value. "Addressable" means PSS this could plausibly remove.

| # | Strategy | Addressable | Risk | Verdict |
|---|---|---|---|---|
| 1 | **Re-base the target** on marginal cost over a bare app | 0 MB | none | **Do.** It is the only honest way to report the number |
| 2 | Hand-roll the socket.io v2 protocol over `ws`, dropping `socket.io-client` | **~5–8 MB** | **high** | **No.** Every capability subscription in the app rides that transport, against an undocumented Athom subscription protocol. The app's entire function depends on it working perfectly |
| 3 | Replace `homey-api` with raw HTTP | ~1 MB | high | **No.** The transport deps stay (3.5); the saving is Athom's thin client layer, and the realtime subscriptions still need socket.io |
| 4 | Bundle + minify the app's 101 modules (1.01 MB of JS) into per-entry chunks | ~1–3 MB heap | medium | **Maybe.** Real, but unmeasurable against a ±9 MB noise band, and it complicates a build that already does evidence-stripping |
| 5 | Lazy `await import()` for `lib/pairing/*` (39 KB) and `lib/validation/plans.ts` (35 KB) | ~0.5–1 MB | low | **Deferred, deliberately.** Real — these reach the process through `driver.js`, which Homey loads at boot, yet are only used inside pair sessions and migrations — but it turns 74 KB of static imports into async ones on the pairing path for a gain an order of magnitude below the noise floor. Revisit only if the module graph grows a lot |
| 6 | Cache the `Intl.DateTimeFormat` built per call in `lib/time/local-clock.ts:57` | unknown, off-heap | low | **Done.** ICU allocates in its own native arenas, invisible to `heapUsed`, and this is called from both 60 s tick paths |
| 7 | Stop connecting the `insights` manager | <0.5 MB | low | **Done, and it turned out not to need connecting at all.** `connect()` opens realtime subscriptions; it does not enable requests. Verified on hardware: the sensor-week route returns a full grid for all four lux sensors with the manager unconnected |
| 8 | Destroy the write client when idle | ~0 MB | low | **No memory case** (3.3) — but the leak below was real and is fixed |
| 9 | Stream the flow-card catalogue instead of materialising it | ~0 MB | medium | **Already tried and reverted** (3.4). Do not revisit |
| 10 | Stop retaining `DeviceCatalog`'s device/zone maps | negative | — | **No.** Previously measured to cost 5 MB, because re-parsing is dearer than holding |

### One real bug the sweep found, unrelated to size

`CredentialService` had **four** sites setting `this.client = null` and one replacing a live client
with a new one, none of which called `destroy()`; and `HomeyApiService.destroy()` tore down only the
read client. **The write client's socket.io connection was orphaned rather than closed** — on every
credential failure, every `clearCredential()`, every re-mint of a key, and at every shutdown. Not a
large allocation, but a live connection and a set of listeners that nothing would ever close, one
per credential change for the life of the app.

**Fixed.** All five sites now route through a private `discardClient()` that closes the socket
before dropping the reference, and `HomeyApiService.destroy()` calls a new
`CredentialService.destroy()` so the class that owns both clients actually tears down both.

---

## 5. What is actually left

Items 6 and 7 are done, along with the write-client leak. Item 5 — lazy-importing `lib/pairing/*`
and `lib/validation/plans.ts` — remains, and is worth well under 1 MB.

The honest expectation for everything remaining is **1 to 2 MB against a 44 MB footprint, on a
machine whose measurement noise is ±9 MB.** None of it is verifiable, which is the point: the work
above was done because each item is right on its own terms, not because the number will move.

**The recommendation is to stop optimising and start reporting properly.** Specifically:

1. Report Lightkeeper's memory as *marginal cost over an empty Homey app*, measured against a
   control app installed at the same time. Absolute PSS on a loaded Homey is not a number about this
   app — and a peer app's `pss` is not comparable with ours at all unless both have the same uptime,
   because ours is the only one never left alone long enough to be paged out (§3.1).
2. Fix the write-client leak, cache the `Intl` formatter, and connect `insights` lazily — because
   each is right on its own terms, not because of the megabytes.
3. Leave the rest. The app's addressable share of its own footprint is under 3 MB, and the two
   levers larger than that are Athom's transport dependencies, which cannot be removed without
   re-implementing the protocol the whole app depends on.

---

## 6. Re-running this

The control-app technique is the durable part. In outline:

- A minimal app: `app.json` with an `api` block, `app.js` extending `Homey.App`, `api.js` returning
  `v8.getHeapStatistics()` and `v8.getHeapSpaceStatistics()`. No dependencies for the bare reading;
  add `homey-api` for the rest.
- One route that adds a layer on demand, so a single install measures the whole ladder. This matters:
  installs are slow, and readings taken minutes apart on a pressured Homey are not comparable.
- Read PSS from outside with `apps.getAppUsage({ id })` — the numbers are under `mem`, not at the top
  level — and **always read the control app and the real app in the same pass**.
- `system.getMemoryInfo()` gives `free`, `swap` and a per-app `types` map. Read it first; below about
  15% free, nothing else means anything.
- **Always read `pssSwap` beside `pss`.** An app with a large `pssSwap` has been paged out and its
  `pss` is not its footprint; an app with `pssSwap: 0` was restarted recently and is fully resident.
  Comparing the two is the easiest mistake to make here, and the first version of this document made
  it.
- Install it from a short path. The CLI fails with an `ENOENT` on its own app directory when the path
  is long.
- Uninstall it afterwards. On a Homey at 11% free, a second app is not a free observer.

Lightkeeper's own `GET /diagnostics` carries `heap` — `heapUsed`, the per-space split and three boot
marks — which is what makes the app side of this comparable without a second install. See
platform §17.
