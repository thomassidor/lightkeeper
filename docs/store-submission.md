# App Store submission notes

Material for Athom's review. The `homey:manager:api` permission triggers a heavier review, and this
app also asks users for a Personal API Key — an unusual pattern that reviewers will reasonably
question. Both are explained below.

---

## What the app does

Light Link lets a user repurpose an already-paired remote, switch, button panel or rotary controller
as a controller for one or more already-paired lights, replacing a collection of hand-authored Flows
with a single mapping.

The user picks a remote, picks lights or a zone, and assigns a remote event to each lighting
function. Light Link generates and maintains the Flows that connect them.

## Why `homey:manager:api` is required

The app operates entirely on devices it does not own, which is only reachable through the Web API:

| Need | Why the permission is required |
|---|---|
| Enumerate paired devices and zones | The user selects a source remote and target lights from devices owned by other apps. |
| Read flow trigger cards | A remote's button events are only observable as flow triggers, not capabilities. Discovery must enumerate cards and find those bindable to the selected device. |
| Subscribe to capability changes | Target brightness must reconcile when a light is changed elsewhere (a wall switch, the vendor app), or the app's desired state drifts out of step with the room. |
| `setCapabilityValue` on target lights | Executing the user's mapping. |
| Read flows | Verifying that generated Flows still exist and are not broken. |

No narrower permission exists: `homey:manager:api` is the only API permission Homey defines.

## Why the app asks for a Personal API Key

**An app's own token cannot write Flows.** Calling `ManagerFlow.createFlow` through
`HomeyAPI.createAppAPI` — which authenticates with `homey.api.getOwnerApiToken()` — is refused with
`403 Missing Scopes`, thrown server-side at `SessionLocal.checkScopes`. This was verified on a Homey
Pro 2023 running firmware 13.4.0, and matches community reports of the same refusal for
`triggerFlow`.

Since flow generation is the entire mechanism by which this app works, and no app permission grants
it, the app asks the user for a Personal API Key (my.homey.app → Settings → API Keys, with Flow
permissions) and performs **only flow writes** through it.

### How the credential is handled

- Stored in app settings on the Homey. Never transmitted anywhere.
- **Never logged.** Errors are classified before logging, and the token is stripped from any error
  text that might echo it.
- **Excluded from diagnostics and exports**, which users are invited to attach to bug reports.
- Validated by performing a real write and immediately undoing it. Reads succeed on credentials that
  cannot write, so a read-based check would give false confidence.
- The app degrades gracefully without it: controllers keep driving lights, and only Flow maintenance
  stops. That surfaces as a dedicated "needs API key" state, distinct from "needs repair", so the
  user is never asked to redo their mapping over a credential problem.

**We would prefer not to need this.** If Athom can grant apps a scoped flow-write capability — even
one limited to flows the app itself created — we would drop the key requirement immediately. We are
happy to discuss.

## What the app writes

- Ordinary Flows, each with the source remote's trigger card and a single internal Light Link action
  card, placed in a clearly named **Light Link** folder.
- Created only for events the user has actually mapped, never for every discovered event.
- Idempotent, keyed on binding plus variant, so reconfiguration reuses rather than duplicates.
- Flows that appear materially user-edited are **never overwritten**; the controller is marked for
  repair instead.
- Deleting a controller deletes only the Flows demonstrably created by it.

Range expansion is capped at 12 flow variants. Beyond that the control is marked unsupported and
logged — the app declines rather than filling a user's Flow list.

## Privacy

Nothing leaves the Homey. No device inventories, configuration or event logs are transmitted. There
is no telemetry, opt-in or otherwise. The diagnostics export is generated locally and shared only if
the user chooses to attach it to a report.

## Compatibility boundary — stated plainly in store copy

> "Supports any device" means any already-paired source for which Homey exposes a usable capability
> change, or a flow trigger card bindable to that device. If the owning integration exposes neither,
> the input is unobservable through public Homey interfaces and no app can reach it.

Two further limits belong in the store description:

- **Homey Pro 2019 and earlier cannot create API Keys** (Athom: *"only on the newer generation"*),
  so the app requires Homey Pro 2023 or later.
- **Homey Cloud is not supported.** The design depends on broad local Web API access.
- Minimum firmware **12.3.0**, set by the `service` device class the controller uses.

The same hardware can expose a different event surface through different pairing paths — a Hue
device offers more through the Philips Hue app than through Matter. The store description should say
so, rather than implying model-level support.

## Testing

169 unit tests cover event normalisation, the press-versus-hold supersede window, group lighting
semantics, the perceptual brightness curve, burst coalescing and rate limiting, ramp termination,
flow compilation, credential failure handling, and schema migrations. Integration fixtures are
captured from four real remotes (IKEA STYRBAR, Philips Hue Dimmer v2, Philips Hue Tap Dial, IKEA
BILRESA) across Zigbee-local, Hue Bridge and Matter/Thread paths.
