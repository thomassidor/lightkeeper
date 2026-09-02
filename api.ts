/**
 * App Web API consumed by settings/index.html. Route names must match the
 * "api" block in .homeycompose/app.json.
 *
 * Nothing here ever returns the API key, and diagnostics carry no
 * secrets or unrelated Homey configuration.
 *
 * Every handler's return shape is documented below, because the settings page
 * is the only consumer and there is no schema between the two.
 */

import { flowWriteProbe } from './lib/credential-service';
import { FUNCTION_CAPABILITY } from './lib/mapping/mapping-types';
import { sanitiseEntries } from './lib/schedules/schedule-types';
import type {
  DiagnosticsResponse, LightkeeperApp, StatusResponse,
} from './lib/app-contract';

/**
 * `homey.app` is the running app instance, and this is the one place it is
 * named.
 *
 * `app.ts` must stay `module.exports = class …` — a Homey entry point using
 * `export default` is not loaded at all — so there is no class to import a type
 * from. `LightkeeperApp` in `lib/app-contract.ts` is that type written down, and
 * one cast at the top of each handler is what retires eleven `any` lambdas.
 */
function appOf(homey: any): LightkeeperApp {
  return homey.app as LightkeeperApp;
}
/**
 * Every device this app can attribute a generated Flow to — controllers AND
 * schedules.
 *
 * Circadian lights are deliberately NOT here, and their absence is as
 * load-bearing as the union below. They generate no Flows, so their ids appear in
 * no bridge arguments and nothing can ever be attributed to them; adding them
 * would inflate `liveControllers` and, worse, make the "nothing is running"
 * refusal below stop firing on a Homey whose only Lightkeeper devices cannot own
 * a Flow at all.
 *
 * Load-bearing. `findManagedFlows()` groups by the device id in a Flow's bridge
 * arguments and cannot tell which registry that id belongs to, so a sweep run
 * against the controllers alone would find every schedule's Flows "orphaned" and
 * delete the lot. The guard below ("no live controllers, refuse") would not have
 * caught it either: with one controller running, the set is not empty.
 */
function liveDeviceIds(app: LightkeeperApp, homey: any): Set<string> {
  const ids = new Set<string>([
    ...app.controllers.all().map(runtime => runtime.controllerId),
    ...app.schedules.all().map(runtime => runtime.controllerId),
  ]);

  /**
   * Every INSTALLED device of both kinds, not merely every registered runtime.
   *
   * A runtime registers when its device inits successfully. A device whose
   * store failed to migrate, whose init threw, or that is simply mid-restart
   * has no runtime — and every Flow it owns then reads as orphaned, on a Homey
   * where other devices are running so the "nothing is live" refusal does not
   * fire either. The device is still there; the user can still see it and
   * repair it; its Flows are still its own. Existing is the right test, not
   * having started.
   *
   * Best-effort per driver: a driver that will not enumerate must not silently
   * SHRINK the protected set, so a failure is logged and the runtime ids stand.
   *
   * Circadian is deliberately absent, as above.
   */
  for (const driverId of ['controller', 'schedule']) {
    try {
      for (const device of homey.drivers.getDriver(driverId).getDevices()) {
        const id = device?.getData?.()?.id;
        if (typeof id === 'string' && id) ids.add(id);
      }
    } catch (error) {
      app.log?.(`Could not enumerate installed ${driverId} devices:`, (error as Error)?.message);
    }
  }

  return ids;
}

/**
 * The device id in a route, or a throw the caller can read.
 *
 * `:id` is the device's `data.id` — the same id `/diagnostics` reports as
 * `controllerId` and a generated Flow carries in `args.controller`. It is
 * deliberately NOT the Homey device id: that one appears nowhere else in this
 * app's own vocabulary, and mixing the two is the mistake that makes a lookup
 * silently miss.
 */
function idOf(params: any): string {
  const id = String(params?.id ?? '');
  if (!id) throw new Error('no device id in the request');
  return id;
}

/**
 * The installed device behind one of our own ids, for the one route that writes
 * a stored plan.
 *
 * A runtime is not enough there: a plan is persisted through the DEVICE, so that
 * `DeviceLifecycle.apply()` runs the transaction — carrying managed Flows
 * forward, rolling back a plan that will not start, and publishing the state.
 * Writing the store directly would skip every one of those.
 */
function deviceOf(homey: any, driverId: string, id: string): any {
  for (const device of homey.drivers.getDriver(driverId).getDevices()) {
    if (device?.getData?.()?.id === id) return device;
  }
  throw new Error(`no ${driverId} device with id "${id}" is installed`);
}

module.exports = {

  /**
   * Everything the settings page renders on load.
   *
   * ```
   * {
   *   credential:   { present, valid, failure?, hint?, lastCheckedAt? },
   *   recentEvents: [{ at, cardId, controller, eventKey, magnitude?, accepted, reason? }],
   *   controllers:  [{ id, state, sourceName, mappings, managedFlows,
   *                    schedulerReady, targetNames }],
   *   schedules:    [{ id, state, name, enabled, entries, managedFlows,
   *                    timezone, localTime, targetNames, lastAction }],
   *   circadian:    [{ id, state, name, enabled, now, nextPoint, points,
   *                    timezone, localTime, targetNames, overridden, preStage }],
   *   recentWrites: [{ at, deviceId, capability, value, ok, ms, error? }],
   * }
   * ```
   *
   * `recentWrites` is EVERY runtime's writes in one time-ordered log — a "did
   * anything reach a light" indicator for the whole Homey, capped at 20 here
   * and 50 in the app. It used to come from the first controller only, which
   * made it permanently empty on a Homey running nothing but schedules. The
   * per-device view is in getDiagnostics, where each runtime keeps its own.
   */
  async getStatus({ homey }: any): Promise<StatusResponse> {
    const app = appOf(homey);
    return {
      credential: app.credentials.getStatus(),
      recentEvents: app.recentEvents.entries().slice(0, 12),
      controllers: app.controllers.all().map(runtime => {
        const diagnostics = runtime.diagnostics();
        return {
          id: runtime.controllerId,
          state: runtime.currentState,
          sourceName: runtime.currentProfile.source.name ?? null,
          mappings: runtime.currentProfile.mappings.filter(rule => rule.inputKey).length,
          managedFlows: runtime.currentProfile.managedFlows.length,
          schedulerReady: diagnostics.schedulerReady,
          targetNames: diagnostics.targetNames,
        };
      }),
      schedules: app.schedules.all().map(runtime => {
        const diagnostics = runtime.diagnostics();
        return {
          id: runtime.controllerId,
          state: runtime.currentState,
          name: diagnostics.name,
          enabled: diagnostics.enabled,
          entries: diagnostics.entries,
          managedFlows: diagnostics.managedFlows.length,
          // The Homey's own clock, echoed back. "It fired an hour late" is
          // almost always a timezone answer, and this is where it is visible.
          timezone: diagnostics.timezone,
          // And whether that zone was actually resolved: a schedule refuses to
          // fire on a clock it does not trust, so this is the first thing to read.
          timezoneResolved: diagnostics.timezoneResolved,
          localTime: diagnostics.localTime,
          targetNames: diagnostics.targetNames,
          lastAction: diagnostics.lastAction,
        };
      }),
      // Both device types, in one list: they are the same engine and the
      // settings page shows them the same way. `kind` in each runtime's own
      // diagnostics is what distinguishes a circadian light from a curve one.
      circadian: app.curves.all().map(runtime => {
        const diagnostics = runtime.diagnostics();
        return {
          id: runtime.controllerId,
          state: runtime.currentState,
          name: diagnostics.name,
          enabled: diagnostics.enabled,
          // Where the curve is right now, and where it goes next. The one pair of
          // facts that says "this is working" without waiting for dusk.
          now: diagnostics.now,
          nextPoint: diagnostics.nextPoint,
          points: diagnostics.points,
          timezone: diagnostics.timezone,
          localTime: diagnostics.localTime,
          targetNames: diagnostics.targetNames,
          // Lights somebody has taken over by hand. Shown because a light that
          // has stopped following the curve on purpose looks exactly like one
          // that has stopped following it by accident.
          overridden: diagnostics.targets.filter(target => target.overridden).length,
          preStage: diagnostics.preStage,
          preStageDisabled: diagnostics.preStageDisabled,
        };
      }),
      // Writes actually attempted against lights — the step after an event is
      // accepted, and where a working-looking app can still do nothing.
      // Every runtime's writes, in one time-ordered log (App.recentWrites).
      // This used to be the FIRST controller's own log, so it was permanently
      // empty on a Homey that runs only schedules — the one list that tells
      // "never fired" from "fired and could not reach the light".
      recentWrites: app.recentWrites.entries().slice(0, 20)
    };
  },

  /**
   * Store an API key. Body: `{ token }`. Returns a CredentialStatus —
   * `{ present, valid, failure?, hint? }` — never the token.
   *
   * `failure` is the machine-readable code the UI translates; `hint` is the
   * English fallback from describeFailure().
   */
  async setCredential({ homey, body }: any) {
    const app = appOf(homey);
    const token = String(body?.token ?? '');
    // Validate with a WRITE: reads succeed on credentials that cannot write,
    // so a read-based check gives false confidence.
    return app.credentials.setCredential(
      token,
      (client: any) => flowWriteProbe(client, (...args: unknown[]) => app.log(...args)),
    );
  },

  /** Forget the stored key. Returns `{ cleared: true }`. */
  async deleteCredential({ homey }: any) {
    appOf(homey).credentials.clearCredential();
    return { cleared: true };
  },

  /**
   * Generated Flows whose controller no longer exists. Reported before deleting
   * so the user sees the scale of it rather than being asked to trust a button.
   *
   * Returns `{ total, orphans, unmanaged, liveControllers, flowIds, examples,
   * token, refused? }`.
   *
   * `liveControllers` counts live Flow OWNERS — controllers and schedules both.
   * The key keeps its original name because the settings page consumes it.
   *
   * `refused` is set when nothing is running: every managed flow then LOOKS
   * orphaned, and the count must not be presented as if it were trustworthy.
   * `unmanaged` counts flows attributed to a dead device that do NOT match the
   * template this app generates — found, reported, never deleted.
   * `token` and `flowIds` are handed back to the sweep, which refuses a stale
   * one: the user approved a specific set, not a number.
   */
  async countOrphans({ homey }: any) {
    const app = appOf(homey);
    return app.bridge.countOrphans(liveDeviceIds(app, homey));
  },

  /**
   * Returns `{ deleted, kept, failed, unmanaged, refused? }`.
   *
   * The body carries back the `token` and `flowIds` from the count the user
   * was actually shown. Without them the sweep still runs — the settings page
   * always sends them, and an older page must not be broken by a newer app —
   * but with them it can refuse (`refused: 'stale_preview'`) when the set has
   * moved since. See countOrphans in the bridge manager.
   */
  async sweepOrphans({ homey, body }: any) {
    const app = appOf(homey);
    const token = typeof body?.token === 'string' ? body.token : null;
    const flowIds = Array.isArray(body?.flowIds) ? body.flowIds.map(String) : null;

    return app.bridge.sweepOrphans(
      liveDeviceIds(app, homey),
      token && flowIds ? { token, flowIds } : undefined,
    );
  },

  /**
   * For troubleshooting and bug reports, not for setup.
   *
   * ```
   * {
   *   generatedAt, app: { id, version },
   *   credential:  { present, valid, failure?, hint?, lastCheckedAt? },
   *   recentEvents: [...],                  // every retained event, not just 12
   *   controllers:  [ControllerRuntime.diagnostics(), ...],
   *   schedules:    [ScheduleRuntime.diagnostics(), ...],
   *   circadian:    [CircadianRuntime.diagnostics(), ...],
   *   timeCard:     { id, argument } | null, and every candidate considered,
   * }
   * ```
   *
   * Users are invited to attach this to a bug report, so it must never carry
   * key material. It DOES carry device and zone names by design — a controller
   * quietly pointed at the wrong room looks identical to a broken one.
   */
  async getDiagnostics({ homey }: any): Promise<DiagnosticsResponse> {
    const app = appOf(homey);
    return {
      generatedAt: Date.now(),
      app: { id: homey.manifest.id, version: homey.manifest.version },
      credential: app.credentials.getStatus(),
      // Most recent first — the fastest way to tell a Flow that never fired
      // from one that fired and was refused.
      recentEvents: app.recentEvents.entries(),
      controllers: app.controllers.all().map(runtime => runtime.diagnostics()),
      schedules: app.schedules.all().map(runtime => runtime.diagnostics()),
      circadian: app.curves.all().map(runtime => runtime.diagnostics()),
      /**
       * Which of Homey's own trigger cards the schedules are built on, and what
       * else was on offer. A card URI may never be constructed (platform §3), so
       * when a firmware moves this card the candidate list IS the investigation.
       *
       * PEEKED, never asked for. Calling `timeCard()` here read every trigger
       * card on the Homey — ~11.6 MB — so merely opening the settings page or
       * exporting a bug report raised the app's memory floor for the rest of its
       * run (platform §15). A report must not change what it is reporting on.
       * A running schedule has already resolved this during start, so the answer
       * is here whenever it is interesting.
       */
      timeCard: app.schedules.peekTimeCard() ?? {
        card: null as null,
        notLookedUp: 'no schedule has needed the time card yet, and looking it up '
          + 'means reading every trigger card on this Homey',
      },
    };
  },

  // ------------------------------------------------------------------ trying
  //
  // "Try it now" outside the pairing screen.
  //
  // Every handler below wraps a method the runtimes already expose and that a
  // pair session already calls — the mechanism is not new, only its reachability
  // is. Two things follow from that, and both are the point:
  //
  // - As a FEATURE: a device that is already paired had no way to prove itself.
  //   The only "test this" in the app was on a screen you have to be pairing to
  //   see, so the answer to "is this thing doing anything?" was to wait for
  //   dusk.
  // - As a TEST SURFACE: these are the last lines of docs/hardware-test-plan.md
  //   that needed a person standing in a room watching a lamp — T21, T22, T27
  //   and T28. scripts/verify-hardware.mjs answers them through here.
  //
  // They are session-authenticated like every other route in this file (nothing
  // in .homeycompose/ is `public: true`), so nothing here widens WHO may call —
  // only what a caller who can already store an API key and delete Flows can do.

  /**
   * Apply a saved circadian or Curve light's plan to its lights, now.
   *
   * Forced: the caller asked for a visible change and is owed one, even where
   * the lights already happen to sit close to the curve. Drained before
   * returning, so `writes` is what was attempted rather than what was queued.
   *
   * Returns `{ writes, skipped }`.
   */
  async previewDevice({ homey, params }: any) {
    const app = appOf(homey);
    const id = idOf(params);
    const runtime = app.curves.get(id);
    if (!runtime) throw new Error(`no circadian or Curve light with id "${id}" is running`);

    const outcome = await runtime.applyNow('preview', { force: true });
    await runtime.drain();
    return outcome;
  },

  /**
   * Prove pre-staging on this household's own lamps.
   *
   * A colour write to an off lamp turns it on through some integrations
   * (platform §6) and there is no way to know which but to try. Returns
   * `{ deviceId, name?, stayedOff, restored, reason? }` — and `stayedOff: false`
   * is a RESULT, not an error: it is the answer that says this Homey cannot
   * pre-stage.
   */
  async testPreStage({ homey, params }: any) {
    const app = appOf(homey);
    const id = idOf(params);
    const runtime = app.curves.get(id);
    if (!runtime) throw new Error(`no circadian or Curve light with id "${id}" is running`);
    return runtime.probePreStage();
  },

  /**
   * Tick every curve-driven device once, instead of waiting up to a minute.
   *
   * One timer serves both device types (platform §12), so this is one call for
   * the whole Homey. Returns `{ ticked }` — how many runtimes there were, which
   * is the only observable a caller can act on.
   */
  async tickCurves({ homey }: any) {
    const app = appOf(homey);
    await app.curves.tickAll();
    return { ticked: app.curves.all().length };
  },

  /**
   * Fire one schedule boundary now. Body: `{ entryId, boundary: 'on' | 'off' }`.
   *
   * The same path the pairing screen's "Test on" / "Test off" buttons take.
   * Returns `{ writes, skipped, targets }`.
   *
   * This is not the same as letting the window arrive: it applies the boundary
   * without consulting the day filter or the clock, which is exactly what makes
   * it useful — waiting two minutes for T14 proves the Flow engine works, and
   * that was measured once and belongs in the platform reference, not in every
   * release pass.
   */
  async testScheduleBoundary({ homey, params, body }: any) {
    const app = appOf(homey);
    const id = idOf(params);
    const runtime = app.schedules.get(id);
    if (!runtime) throw new Error(`no schedule with id "${id}" is running`);

    const entryId = String(body?.entryId ?? '');
    if (!entryId) throw new Error('no entryId in the request');
    return runtime.testEntry(entryId, body?.boundary === 'off' ? 'off' : 'on');
  },

  /**
   * Replace a saved schedule's windows. Body: `{ entries }`.
   *
   * The one route here that writes a user's stored plan, so it is the one to be
   * careful with — and the care is entirely in refusing to be clever:
   *
   * - `sanitiseEntries` is the SAME function the pair session calls. Overlaps,
   *   bad days, duplicate ids and anything over the twelve-window cap are
   *   dropped and NAMED, by one implementation rather than two that can drift.
   * - The write goes through `device.applyPlan`, never the store, so
   *   `DeviceLifecycle` runs its transaction: managed Flows carried forward, a
   *   plan that will not start rolled back, the state published.
   *
   * Returns `{ count, dropped }` — the same shape the pairing screen renders, so
   * a caller learns which windows were refused rather than only how many stuck.
   */
  async setScheduleEntries({ homey, params, body }: any) {
    const id = idOf(params);
    const device = deviceOf(homey, 'schedule', id);
    const { entries, dropped } = sanitiseEntries(body?.entries);

    // Refusing an empty result rather than saving it: a schedule with no windows
    // is a device that looks configured and can never fire, which is the exact
    // failure this app exists to prevent. An all-dropped payload is a mistake,
    // and the `dropped` list says which one.
    if (entries.length === 0) {
      throw new Error(dropped.length > 0
        ? `every window was dropped: ${dropped.map(d => d.reason).join('; ')}`
        : 'a schedule needs at least one window');
    }

    const plan = { ...device.getStoreValue('schedule'), entries };
    await device.applyPlan(plan);
    return { count: entries.length, dropped };
  },

  /**
   * Run one mapped function against a controller's lights. Body:
   * `{ func, deviceIds? }`.
   *
   * The write half of a remote press, and only that half. It does NOT prove
   * T9-T11: a real press arrives as a physical event that goes through the
   * normalizer and the mapping engine first, and a real HOLD ends with a release
   * event that is routinely dropped on Zigbee — which is the entire reason the
   * ramp hard-stops at 10 seconds. Nothing reachable over HTTP can stand in for
   * a finger.
   *
   * Returns `{ writes, skipped, targets }`.
   */
  async testControllerFunction({ homey, params, body }: any) {
    const app = appOf(homey);
    const id = idOf(params);
    const runtime = app.controllers.get(id);
    if (!runtime) throw new Error(`no controller with id "${id}" is running`);

    /**
     * Checked against the closed set before it is cast.
     *
     * `func as any` defeated the compile-time exhaustiveness `mapping-engine.ts`
     * relies on: `intentForLightFunction` has no default arm, so an unrecognised
     * string fell off the switch, returned `undefined`, and crashed inside
     * `requiredCapability` with an opaque TypeError. A route answering a bad body
     * with a stack trace instead of a refusal is the one thing every other
     * handler in this file is careful not to do — and this is the same membership
     * check `pairing-dto.ts` already makes on the same value.
     */
    const func = String(body?.func ?? '');
    if (!func) throw new Error('no func in the request');
    if (!(func in FUNCTION_CAPABILITY)) {
      throw new Error(`"${func}" is not a light function`);
    }
    const deviceIds = Array.isArray(body?.deviceIds) ? body.deviceIds.map(String) : undefined;
    return runtime.testFunction(func as any, deviceIds);
  },

};
