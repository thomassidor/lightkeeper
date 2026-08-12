# Light Link — implementation plan (revised after Phase 0)

Supersedes the pre-spike plan. Revised 8 August 2026, after the Phase 0 findings in
[`spike-result.md`](./spike-result.md).

## Build status — 9 August 2026

Phases 1–3 are written, type-clean, validated at `publish` level, and installing and initialising on
real hardware. 169 unit tests pass.

**What is NOT verified: any of it working end to end with a physical remote.** Everything below is
tested against captured fixtures and a live Homey's API, but no button has been pressed. The
outstanding acceptance criteria are AC-06, AC-10 through AC-14, AC-16, AC-19 and AC-20 — all of
which need hands on hardware.

Deferred deliberately:

- **Criterion 6 latency** (§3.1) — needs physical presses on each of the four remotes.
- **Per-action target overrides in the UI** (§4.2) — schema present, UI is Phase 3 in the spec and
  the workaround (one controller per target group) stands.
- **Press-to-identify accelerator** (§14) — a convenience, not a mechanism.
- **Capability source adapter** (§2.1) — interface only in MVP, as the spec directs; no reference
  device needs it.
- **Derived double-press** (§1.2) — explicitly out of MVP.

---

## What Phase 0 changed

The specification assumed §6's managed flow bridge would run on the app's own credentials. It
cannot. Three findings reshape the build:

**1. Flow writes need a user's Personal API Key.** An app's own token
(`HomeyAPI.createAppAPI` → `getOwnerApiToken`) is refused with `403 Missing Scopes` on every flow
write. A user-minted Personal API Key succeeds, including from inside the app process. This is §3.2
rung 1, confirmed working — rung 2 (guided manual mode) is not needed and will not be built.

**2. API key sessions die, routinely.** A key embeds a session ID. When that session is invalidated
the key stops working although the string is unchanged, surfacing as `401 Session Not Found`. We hit
this within twenty minutes of first use. Credential re-auth is therefore a **first-class runtime
state**, not an error path bolted on later.

**3. Flow card URIs must never be constructed.** A card's `uri` is a full resource URI embedding its
own id (`homey:flowcardaction:homey:manager:alarms:enable_next`), not `homey:app:<appId>`.
Constructing one yields `404 Not Found`, which is easily misread as a permission failure. Always
enumerate the card and echo its `uri` and `id` back verbatim.

**4. Device trigger cards are found by card ID, not by URI.** Device-scoped cards are identified by
`card.id.startsWith('homey:device:' + deviceId + ':')`. No card carries a `uri` of
`homey:device:<deviceId>` — the obvious reading of §5.1 matches nothing and makes every remote look
eventless. "Same owning app" must not be a match route: it offers Hue motion-area triggers as
buttons on a Hue dial. Full detail and the per-device event surfaces are in `spike-result.md`.

**5. Capability echoes arrive duplicated,** and `light_temperature` is normalised 0–1 rather than
mireds. The target state cache must dedupe echoes, and the ramp engine must not read a duplicate as
an external change that cancels the ramp.

### Consequences for the product

- Setup gains a step the spec does not have: the user mints an API key and pastes it in, once.
  AC-06 survives — no flow is ever hand-authored — but this is now the first thing a new user meets.
- A credential lives on the Homey. §12 obligations attach, including exclusion from the §9.5 export.
- **Homey Pro 2019 and earlier cannot mint API keys.** The §2.1 compatibility boundary must say so.

---

## Architecture delta

### Two API clients, deliberately separated

| Client | Auth | Responsibilities |
|---|---|---|
| `createAppAPI({ homey })` | app's own token | device and zone reads, capability subscriptions, `setCapabilityValue`, flow **reads** |
| `createLocalAPI({ address, token })` | user's Personal API Key | flow **writes** only — create, update, delete, folders |

`address` comes from `homey.api.getLocalUrl()`, which returns `http://127.0.0.1:80` inside the app —
no LAN discovery needed.

The split bounds the blast radius. When the key dies, controllers keep driving lights; only
reconciliation degrades. That is a health state, not an outage, and it is why the separation is
worth the second client rather than routing everything through the key.

### New module: `lib/credential-service.ts`

Not in the spec's §10 tree; required by the above.

- Stores and retrieves the key from app settings. Never logs it, never returns it over the app API,
  redacts it from diagnostics and profile exports.
- Owns the write client's lifecycle; rebuilds it when the key changes.
- Classifies failures: `401 Missing Session ID` (bad paste) · `401 Session Not Found` (re-mint) ·
  `403 Missing Scopes` (wrong permissions) — three different user-facing messages.
- Emits a `credentialInvalid` event that `HealthMonitor` turns into a controller state.

### Changes to specified modules

- **`FlowBridgeManager`** takes the write client, not the app client. Every write path handles 401
  by raising `credentialInvalid` rather than retrying.
- **`FlowBindingCompiler`** resolves cards through enumeration; a `resolveCard(shortId)` helper is
  the only place card URIs are produced.
- **`HealthMonitor`** gains a `Needs credential` state, distinct from `Needs repair`. Repair means
  remap; this one means re-enter a key and keep every mapping.

---

## Phase 0 — status

Criteria 1–5 pass. Fixtures captured. Outstanding:

- **Criterion 6 — latency.** Requires physical button presses on each of the four remotes; cannot be
  automated. The output leg is measured (~275 ms via the Hue Bridge); what is missing is the input
  leg per remote transport.
- **Criterion 4 end-to-end.** The `droptoken` encoding is known and will be written correctly, but a
  generated flow has not yet been observed *firing* with a real token value. First real test is the
  Tap Dial's `steps` token in Phase 2.

Neither blocks Phase 1, which needs no tokens and no latency budget.

---

## Phase 1 — vertical MVP

Unchanged in substance from the pre-spike plan; the additions are credential-related.

**New — credential onboarding.** Before the three pairing screens, a one-time setup step: explain
why a key is needed, link to my.homey.app → Settings → API Keys, state the required permissions,
accept and validate the key by performing a real write. Validation must be a write, not a read —
reads succeed on credentials that cannot write, which is exactly how this was nearly misdiagnosed.

**New — `credential-service.ts`** as above, built before `FlowBridgeManager` depends on it.

Otherwise as planned: `homey-api-service` (now owning both clients), `device-catalog`,
`source-discovery-service`, normalizer and magnitude collapser, the two bridge cards with §12
validation on receipt, `target-resolver` / `light-target-adapter` / `target-state-cache` /
`command-scheduler`, perceptual curve, group toggle and relative brightness, the virtual device with
its three custom pairing views, and profile persistence with migrations.

Test controls on every mapped row remain the highest-value item on the mapping screen.

**Exit:** a STYRBAR drives three lights end-to-end, configured start to finish with no visit to the
Flow editor — including the key step, timed and observed on someone unfamiliar with the app.

---

## Phase 2 — rotary and hardening

As planned: numeric token bridge and range expansion (ceiling 12), supersede gate (250 ms, only
where a control carries both discrete and hold mappings), ramp engine (100 ms tick, 60 %/s, hard
10 s stop), burst coalescing, acceleration off by default, health states, reconciliation, Tap Dial
and BILRESA.

**Added:** reconciliation must tolerate a dead credential. On startup with an invalid key, load
profiles, start listeners, drive lights, and defer only flow reconciliation — surfacing
`Needs credential` rather than failing to start.

---

## Phase 3 — repair and polish

As planned: event-surface fingerprints, one-tap re-attach, diagnostics and export, per-action target
UI, zone targets, press-to-identify, Danish localisation.

**Added:** the diagnostics export must be verified to contain no credential material — a test, not a
code review. App Store copy must explain both `homey:manager:api` and the API key requirement, and
state the Homey Pro 2019 exclusion.

---

## Testing delta

On top of §11.1:

- **Credential service** — the three failure classifications; write client rebuilt on key change;
  key absent from every diagnostics and export payload (assert on serialised output).
- **Bridge manager** — 401 mid-reconcile raises `credentialInvalid` and does not corrupt managed
  flow references; reconciliation resumes cleanly after a new key.
- **Binding compiler** — card URIs are always echoed from enumeration, never constructed. A
  regression test with a card whose `uri` differs from `homey:app:<id>` would have caught this.
- **Lifecycle (§11.4)** — add: invalidate the key mid-operation, confirm lights keep working,
  confirm `Needs credential`, re-enter a key, confirm reconciliation resumes with mappings intact.

---

## Risks, revised

1. **API key invalidation frequency — the top risk.** If sessions die often, setup friction becomes
   recurring friction and the product feels broken. Pin down the cause early in Phase 1; if it turns
   out to be a Homey restart, every restart needs a re-auth prompt and that is a serious UX problem
   worth raising with Athom.
2. **App Store acceptance of the API-key pattern.** Unknown. Does not block local use. Ask before
   Phase 3.
3. **Token encoding still unknown.** Deferred, not resolved — needs one hand-built flow to inspect.
   Blocks Phase 2's numeric bridge, not Phase 1.
4. **BILRESA card loss** — unchanged from the original plan; §9.4 remains non-optional.
