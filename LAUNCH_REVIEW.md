# Lightkeeper launch review — 8 September 2026

**Recommendation: fix the seven P1 findings before a public launch.** The architecture has useful separation and substantial regression coverage, but normal configuration choices and recoverable failures can still affect the wrong devices or leave automation broken. This is a targeted hardening project, not a reason to rewrite the app.

Reviewed the working tree based on `b2ebfd3027f5bddd7a697887d1f9f84c3a3bea1f`, including its existing uncommitted changes. No application code was changed. Findings refer to the file contents and line numbers at review time.

**Concurrent-work boundary:** The final status check revealed additional evidence-recording work arriving during the review (`evidence-recorder.ts`, `evidence-sampler.ts` and related wiring). That newly arriving feature is outside the completed review and verification snapshot. The passing checks below must not be interpreted as validation of those later edits. The findings remain applicable to the paths inspected; line numbers may shift as that work continues.

## Scope and evidence

Reviewed the app composition, five drivers and device lifecycle, controller dispatch and normalization, Flow compilation and reconciliation, target resolution and output scheduling, circadian/Curve and daylight control, schedules and time handling, credentials, persistence and validation, representative pairing/repair and settings paths, test architecture, packaging and CI. Generated view copies were checked for consistency rather than treated as independently authored implementations. Existing hardware documentation was inspected; no physical Homey, remote or lamp was operated.

Checks on Node 22.12.0:

| Check | Result |
| --- | --- |
| Unit suite | 1,476 passed; zero failures, skips or cancellations |
| Application TypeScript | Passed |
| Test TypeScript | Passed |
| ESLint | Passed |
| Pair/repair/shared view consistency | Passed |
| Homey publish-level validation | Passed in a temporary source copy, preserving the working tree |
| Production dependency audit | Four moderate package entries, all tracing to one `parseuri` ReDoS advisory; no high/critical entries |

Additional in-memory fault probes exercised the actual TypeScript modules. Where useful, they reused the existing test fixtures without modifying test files. These establish application behavior under the stated inputs; they do not establish how frequently each condition occurs on real hardware.

P1 means a high-priority correctness issue I would block launch on. P2 means a concrete issue to address in the hardening work. Neither label implies a security CVE.

## Findings

### R1 — P1: Choosing a room includes appliances, not just lights

**Location:** [lib/device-catalog.ts:184](D:/OneDrive/Desktop/claude-lightlink/lib/device-catalog.ts:184).

`lightsInZone()` accepts every device with `onoff`, excluding only this app's own devices. The explicit picker distinguishes non-light devices, but room resolution does not use that distinction. A controller or schedule targeting a room can therefore switch a dishwasher, air purifier or equipment socket; adding such a device to the room later automatically includes it. The source comments already record appliances in the reference inventory.

**Fix:** Use `class === 'light' || virtualClass === 'light'` for automatic room membership. Keep non-light sockets available through deliberate individual selection, or an explicit inclusion mechanism.

**Acceptance:** A room with a bulb, a socket marked as a light, an ordinary socket and an appliance selects only the first two. Adding an appliance later must not give the lighting automation control over it.

### R2 — P1: A normal hold mapping has no working release path

**Locations:** [lib/runtime/controller-runtime.ts:454](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:454), [lib/runtime/controller-runtime-manager.ts:187](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime-manager.ts:187).

Ramp eligibility checks whether the *catalogue* contains a release event. Flow reconciliation creates Flows only for events explicitly mapped to a light function, and dispatch rejects unmapped events. Assigning Hold to Brighter therefore enables ramping without generating or accepting its Release event. The ten-second cutoff becomes the normal stopping mechanism.

**Reproduced:** A catalogue with Hold and Release and only Hold mapped generated `['long_press']`. Dispatching Release returned `accepted: false`, reason `event "release" is not mapped to any function`; the ramp remained active.

**Fix:** Treat release/stop events as internal dependencies of ramp mappings. Generate their bridge Flows and accept them for stopping an active ramp without requiring a separate user action mapping.

**Acceptance:** Configure only Hold → Brighter, press and release, and assert that subsequent ramp ticks cease. Test the generated Flow set and dispatch together, not just `RampEngine.stop()`.

### R3 — P1: Holding a per-light mapping ramps all controller targets

**Locations:** [lib/runtime/controller-runtime.ts:393](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:393), [lib/runtime/controller-runtime.ts:590](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:590).

`execute()` resolves the rule's narrower target, but `ramps.start()` does not carry that selection. The ramp callback always uses `this.targetIds`. A hold assigned to one lamp changes the other lamps selected by the controller too.

**Reproduced:** Controller targets A and B, Hold → Brighter scoped to A: the first ramp tick wrote both A and B.

**Fix:** Give an active ramp its resolved target set, intersected with current eligible targets when it writes. Do not let room membership growth expand an already active gesture implicitly.

**Acceptance:** A per-light hold changes only that lamp, while an all-lights hold changes both. Removing the chosen lamp during the hold stops writes to it.

### R4 — P1: Clearing target selection retains the previous saved selection

**Locations:** [drivers/controller/pair/targets.html:351](D:/OneDrive/Desktop/claude-lightlink/drivers/controller/pair/targets.html:351), [lib/pairing/pair-session.ts:179](D:/OneDrive/Desktop/claude-lightlink/lib/pairing/pair-session.ts:179), [lib/validation/pairing-dto.ts:53](D:/OneDrive/Desktop/claude-lightlink/lib/validation/pairing-dto.ts:53).

When the last light is deselected, the screen displays zero and sends an empty target selection while swallowing the rejection. The handler validates before assigning `state.target`; empty selections are rejected. Consequently the session still contains the previous valid target. Native Next navigation remains configured, and subsequent screens/builders consume that old target.

**Reproduced:** Start with `deviceIds: ['old']`, submit an empty selection: validation throws `target.deviceIds is empty`, and the session still contains `['old']`. The UI explicitly hides this failure. This shared view/handler affects all five device types.

**Fix:** Represent an invalid/empty draft explicitly and prevent advancement/save until the latest selection is acknowledged. Also sequence selection requests so an older asynchronous response cannot replace a newer selection.

**Acceptance:** Select A, deselect A, then attempt Next/Save: no configuration or preview may target A. Repeat with rapid selection changes and delayed validation responses.

### R5 — P1: Read-client replacement does not rebind its subscribers

**Locations:** [lib/homey-api-service.ts:127](D:/OneDrive/Desktop/claude-lightlink/lib/homey-api-service.ts:127), [lib/device-catalog.ts:96](D:/OneDrive/Desktop/claude-lightlink/lib/device-catalog.ts:96).

`reportReadFailure()` drops the cached client. `read()` builds a replacement, but catalogue listeners remain attached to the original client's managers. Target handles/capability listeners and luminance subscriptions also have no common client-generation notification. The app can resume request/response reads while relying on a separate, failed client for changes. Recovery then depends on that old client independently recovering, and the old connected client is not explicitly disposed.

**Reproduced:** Register catalogue watching, inject `ECONNRESET`, rebuild the client, and emit `device.create` on the replacement. The original manager still had one listener, the replacement had zero, and no catalogue invalidation occurred.

**Fix:** Make client replacement an explicit lifecycle event. Dispose superseded clients and rebind catalogue, target and sensor subscriptions; invalidate handles and refresh reported state. Guard overlapping connection attempts against installing an obsolete client.

**Acceptance:** After forced replacement, newly added/removed lamps are detected, manual power changes reach runtimes, sensor readings update, and listener/client counts return to baseline across repeated recoveries.

### R6 — P1: A failed replacement delete becomes an untracked duplicate Flow

**Location:** [lib/bridge/flow-bridge-manager.ts:548](D:/OneDrive/Desktop/claude-lightlink/lib/bridge/flow-bridge-manager.ts:548).

When replacement creation succeeds but deleting the superseded Flow fails, the result records the new Flow reference and puts the old ID only in `staleReplacements`. The old ID is not preserved as a cleanup obligation. The next sync reuses the new reference and forgets the stale warning. Orphan cleanup also keeps it while its owning device exists. Duplicate events can therefore continue indefinitely; a duplicate toggle can cancel itself out.

**Reproduced:** First sync reported `old` stale. After removing the simulated deletion failure, the next sync reported no stale IDs while both `old` and `new-1` remained live; only `new-1` was tracked.

**Fix:** Persist pending cleanup separately from active references and retry it. Keep the duplicate condition visible until deletion is verified; consider disabling superseded Flows before deletion where the platform supports it.

**Acceptance:** Fail one replacement deletion, recover, reconcile again, and assert exactly one active Flow per binding and no forgotten cleanup IDs, including after app restart.

### R7 — P1: Multi-Flow replacement rollback can remove working automation

**Locations:** [lib/bridge/flow-bridge-manager.ts:561](D:/OneDrive/Desktop/claude-lightlink/lib/bridge/flow-bridge-manager.ts:561), [lib/bridge/flow-bridge-manager.ts:625](D:/OneDrive/Desktop/claude-lightlink/lib/bridge/flow-bridge-manager.ts:625).

Sync creates a replacement and immediately deletes its old Flow before finishing the rest of the update. If a later create fails, compensation deletes all newly created Flows, including the replacement whose original is already gone. This rollback does not restore the previous working set. Runtime reconciliation catches the failure and reports degradation; it does not restore that missing binding in the same pass.

**Reproduced:** Two old Flows A/B, fingerprint replacement of both, fail the second create: A was deleted, its replacement was deleted by compensation, and only B remained.

**Fix:** Stage and verify the full replacement set before deleting the old set. Make switching ownership, persisting references and cleanup recoverable, including a failed persistence step or process interruption. A small journal is preferable to pretending the Web API offers transactions.

**Acceptance:** Inject failure at every create/delete/persist boundary and assert that an operational previous or new binding remains, and that restart converges without duplicates or missing Flows.

### R8 — P2: Hue success records saturation success even when saturation failed

**Locations:** [lib/circadian/circadian-runtime.ts:1130](D:/OneDrive/Desktop/claude-lightlink/lib/circadian/circadian-runtime.ts:1130), [lib/circadian/circadian-runtime.ts:1191](D:/OneDrive/Desktop/claude-lightlink/lib/circadian/circadian-runtime.ts:1191).

On successful `light_hue`, `noteColorWritten()` commits the whole planned hue/saturation pair. It does not require the saturation write to succeed. `colorHasMoved()` then suppresses retries for an unchanged colour. The mutable per-device `pendingColor` can also refer to a newer batch than the outcome being processed.

**Reproduced:** A constant amber curve accepted mode and hue, rejected saturation, recorded saturation `0.75` as written, and made zero attempts on the next tick.

**Fix:** Associate planned colour with the batch and record each accepted component, or mark the pair complete only after both required components succeed. Retain a retry obligation for incomplete colour changes.

**Acceptance:** Reject saturation once, recover, and verify retry without needing a different curve value. Also interleave two colour batches.

### R9 — P2: Accepted target groups can exceed the scheduler's capacity

**Locations:** [lib/outputs/command-scheduler.ts:126](D:/OneDrive/Desktop/claude-lightlink/lib/outputs/command-scheduler.ts:126), [lib/validation/plans.ts:82](D:/OneDrive/Desktop/claude-lightlink/lib/validation/plans.ts:82).

The picker/validator accepts up to 256 explicitly selected devices, and room selection has no corresponding count limit. A scheduler allocates at most 64 device queues. It allocates queues for the entire submission before flushing, so a single action over 65 devices drops the last device even when every write would succeed. Controllers and schedules discard these completion outcomes. A whole-home Off can therefore leave lamps on.

**Reproduced:** Submit 65 distinct power-off commands: 64 succeeded and one was `dropped_capacity`.

**Fix:** Bound concurrency without dropping accepted work, or enforce and explain a consistent product limit before configuration is saved. Add a shared app/bridge write budget for larger installations rather than relying only on per-device/per-runtime caps.

**Acceptance:** A supported 65+ target action completes for every device, or setup explicitly refuses the configuration. Scheduled off commands must not silently disappear.

### R10 — P2: Setup tests report planned commands as successful lights

**Locations:** [lib/runtime/controller-runtime.ts:650](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:650), [lib/schedules/schedule-runtime.ts:588](D:/OneDrive/Desktop/claude-lightlink/lib/schedules/schedule-runtime.ts:588), [lib/pairing/pair-session.ts:359](D:/OneDrive/Desktop/claude-lightlink/lib/pairing/pair-session.ts:359), [drivers/controller/pair/mapping.html:575](D:/OneDrive/Desktop/claude-lightlink/drivers/controller/pair/mapping.html:575).

Preview/test functions return planned write counts and drain the scheduler, which records failures rather than throwing them. Views render successful “Sent to…” messages from these counts. Additionally, warmth and colour may issue multiple capability commands per lamp, so a single lamp can be described as multiple lights. The new diagnostics semantics correctly distinguish planned commands from outcomes, but the setup feedback does not.

**Evidence:** The saturation-failure probe above produced three planned commands for one lamp, including a failed command; the same preview return contract still exposes the planned count.

**Fix:** Return batch outcomes summarized by unique device: accepted, failed, cancelled and skipped. Phrase API acceptance accurately; do not claim physical verification unless performed. Reuse this contract in controller, schedule and colour/daylight previews.

**Acceptance:** All writes failing must produce a failure message. One lamp with mode/hue/saturation writes must still count as one lamp, with partial failure disclosed.

### R11 — P2: Health updates depend on unrelated target changes

**Locations:** [lib/runtime/controller-runtime.ts:665](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:665), [lib/runtime/controller-runtime.ts:225](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/controller-runtime.ts:225), [lib/runtime/runtime-registry.ts:126](D:/OneDrive/Desktop/claude-lightlink/lib/runtime/runtime-registry.ts:126).

Catalogue changes call `refreshTargets()`, which returns before `assessHealth()` when the target fingerprint is unchanged. Deleting the source remote leaves the lamps unchanged, so this path never checks that the source disappeared. There is no periodic controller health pass. Repeated write failures likewise do not themselves trigger a health assessment. Conversely, `assessHealth()` ignores a ready result, which can leave a recovered target failure displayed indefinitely. Curve/daylight ticks also do not routinely reassess write health.

**Fix:** Separate source, target, credential, Flow and write health from target resource rebuilding. Evaluate relevant health when its inputs change and run a bounded periodic recovery check. Combine independent health reasons so clearing a target failure cannot erase an unresolved Flow-edit warning.

**Acceptance:** Delete only the remote and observe degradation; recover an unresponsive target and observe recovery without editing targets or restarting. Preserve independent warnings.

### R12 — P2: An in-flight credential save can undo Remove key

**Locations:** [lib/credential-service.ts:245](D:/OneDrive/Desktop/claude-lightlink/lib/credential-service.ts:245), [lib/credential-service.ts:276](D:/OneDrive/Desktop/claude-lightlink/lib/credential-service.ts:276).

`setCredential()` awaits client construction and validation, then stores the key without checking whether a later clear or save superseded it. `clearCredential()` increments a generation, but the setter does not use it. The settings page allows Save and Remove to overlap. A key can therefore reappear after the user removes it; overlapping saves can commit in completion order instead of user order.

**Reproduced:** Pause validation, clear the credential, resume validation: `hasCredential()` and `status.valid` both became true.

**Fix:** Give credential mutations an intent generation at invocation and guard commits and status updates. Dispose stale candidate clients. Apply the same generation discipline to results from writes using superseded clients.

**Acceptance:** Clear during validation stays cleared; a later save wins over an earlier slow save; a late old-client result cannot change the current key's status.

## Maintainability improvements with direct payoff

1. **Make target control an explicit shared boundary.** The app currently gives every runtime its own cache, adapter, subscriptions and scheduler for the same physical lamp. Multiple Lightkeeper devices can fight, or treat one another's writes as manual overrides. First add conflict detection during pairing/repair and when room membership changes. Then consider a shared lamp coordinator for subscriptions, cancellation, ownership and rate limits, while keeping schedule/curve/daylight policy separate. A giant universal runtime would obscure the differences that matter.

2. **Make Flow reconciliation a recoverable state machine.** R6/R7 and persistence failure handling belong together: desired bindings, staged replacements, committed active references, pending cleanup. Keep these states explicit and test transitions. Avoid adding another isolated array or catch block for each failure.

3. **Unify command outcomes, not just command submission.** R8/R9/R10 demonstrate different interpretations of “written.” Use batch-specific immutable outcomes and a single device-level summary for UI, health and diagnostics. Preserve the useful distinction between API acceptance and reported physical state.

4. **Test complete paths across module boundaries.** The suite is valuable, but a direct RampEngine test cannot detect missing release Flows or dispatch rejection. Add small integration tests from configuration → compilation → dispatch → fake lamp, and from view interaction → real handler → persisted draft. Simulate failed subscriptions, stale reads, delayed/duplicate/out-of-order echoes, partial capability failures and interrupted reconciliation. Prefer a browser-backed smoke suite for the actual views over expanding the hand-written DOM emulator indefinitely.

5. **Reduce unchecked shell boundaries.** `LightkeeperDevice.app` and driver app getters return `any` despite the existing `LightkeeperApp` contract. Extend the typed contract to those consumers and define request/response types shared by handler code and browser code. Make draft validation and operation sequencing reusable across views.

6. **Shorten historical comments and keep executable guarantees adjacent.** Several long comments claim safeguards that the code does not provide, notably colour completion and clearing targets. Keep brief invariants and reasons in code; move incident narratives to linked decision records. Retain hardware evidence and dates, but distinguish measured behavior, working hypotheses and product policy.

## Compatibility and launch work beyond these fixes

- **Broader device discovery:** Filter-matched `device` arguments reach discovery but are classified as unsupported by `classifyArgument()`. `direct_capability` has an interface/compiler case but no implemented source listener. English gesture-name heuristics and a first-number-token assumption also limit coverage. Document supported event shapes and add fixtures from other integrations before expanding “any remote” expectations; never guess which device or token to bind.
- **Sensor recovery and feedback:** Retained sensor subscriptions are not recreated merely because a sensor went unavailable and returned; reconciliation exits when an old subscription handle exists. Reading timestamps are diagnostic only, not a freshness policy. Test sensor removal/re-add, driver restart, silent sensor loss and actual room feedback. Do not choose a universal reading TTL without accounting for sensors that report only changes.
- **Capability changes:** Target fingerprints include on/off, dim and temperature metadata, but omit hue, saturation and mode. Updates to those capabilities can be ignored until a different fingerprint field changes. Include every capability the relevant runtime consumes.
- **Geography and clocks:** Existing time/solar logic has useful tests. Add launch scenarios for another timezone, a DST transition, the southern hemisphere, high latitude, and missing/corrected location/timezone. Circadian calculations fall back to process-local time while schedules fail closed on unresolved timezone; choose and disclose an intentional policy.
- **Resource envelope:** Test 1/10/30 virtual devices, large catalogues and repeated reconnect/repair cycles. Record heap/PSS, subscription counts, retained clients, write concurrency and API latency. The new bounded histories bound entry count, but each entry can contain an entire target/outcome list, so memory still scales with both targets and runtime count. Existing hardware documentation already describes memory above the stated guideline; one-home measurements are not a general capacity guarantee.
- **Dependency advisory:** `npm audit --omit=dev` reports the `parseuri <2.0.0` advisory through the old socket client dependency chain in `homey-api`. See [GHSA-6fx8-h7jm-663j](https://github.com/advisories/GHSA-6fx8-h7jm-663j). This review did not establish a reachable hostile-input exploit in Lightkeeper. Triage the pinned dependency with the vendor; do not blindly apply the audit's suggested downgrade or replace transport dependencies without hardware checks.
- **Documentation:** The privacy notice still describes four device types/three jobs and omits the daylight sensor/location behavior. Update it to the actual implementation and qualify device-control claims for integrations that themselves use cloud services. This is a documentation consistency observation, not a legal assessment.

## Suggested delivery order

1. Fix room selection, empty/stale drafts, release dependencies and per-light ramp scope. Add complete-path regressions for R1–R4.
2. Fix client/subscription recovery and transactional Flow replacement/cleanup. Fault-test R5–R7 across restart and failed persistence.
3. Fix batch outcomes, colour retry, capacity, health and credential sequencing. Close R8–R12.
4. Add conflicting-controller detection, broaden device fixtures and run a small beta in homes with different integrations and topology. Include physical press/hold/release tests: invoking a generated action directly does not test the remote's event path.

The app passed all existing automated checks and publish validation. Those are useful baseline evidence, but the reproduced cross-module failures are the reason I would not use them alone as a launch gate.
