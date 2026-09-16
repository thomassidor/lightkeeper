import { DIAGNOSTIC_SEMANTICS } from './lib/runtime/control-diagnostics';
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
import {
  overlappingPairs, sanitiseEntries, sanitiseScheduleDays,
} from './lib/schedules/schedule-types';
import type {
  DiagnosticsResponse, LightkeeperApp, StatusResponse,
} from './lib/app-contract';
import { requireArray } from './lib/validation/guards';
import { timezoneOf } from './lib/time/local-clock';
import { messageOf } from './lib/support/homey-errors';
import { heapReport } from './lib/support/heap-report';
import { evidenceRoutes } from './lib/support/evidence-feature';

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
 * Circadian lights, Colour Curve Lights and Room-sensing Lights are deliberately NOT here,
 * and their absence is as load-bearing as the union below. None of the three
 * generates a Flow, so their ids appear in no bridge arguments and nothing can
 * ever be attributed to them; adding them would inflate `liveControllers` and,
 * worse, make the "nothing is running" refusal below stop firing on a Homey
 * whose only Lightkeeper devices cannot own a Flow at all.
 *
 * That is also why the driver loop below names two drivers rather than five: it
 * is a list of the device types that OWN Flows, not a list of this app's device
 * types, and a fifth entry would be the same mistake in a different place.
 *
 * Load-bearing. `findManagedFlows()` groups by the device id in a Flow's bridge
 * arguments and cannot tell which registry that id belongs to, so a sweep run
 * against the controllers alone would find every schedule's Flows "orphaned" and
 * delete the lot. The guard below ("no live controllers, refuse") would not have
 * caught it either: with one controller running, the set is not empty.
 */
function liveDeviceIds(
  app: LightkeeperApp,
  homey: any,
): { ids: Set<string>; enumerated: boolean } {
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
   * A driver that will not enumerate must not silently SHRINK the protected
   * set — and a log line is not enough to stop that, which is what this used to
   * rely on. `enumerated: false` travels with the ids and REFUSES the sweep:
   * with the controllers live, the "nothing is running" guard would not fire,
   * so every schedule device without a registered runtime would read as
   * unattributable and be offered up for deletion. The preview is computed from
   * the same shrunken set, so it would agree with the mistake rather than catch
   * it.
   *
   * Circadian is deliberately absent, as above.
   */
  let enumerated = true;
  for (const driverId of ['controller', 'schedule']) {
    try {
      for (const device of homey.drivers.getDriver(driverId).getDevices()) {
        const id = device?.getData?.()?.id;
        if (typeof id === 'string' && id) ids.add(id);
      }
    } catch (error) {
      enumerated = false;
      app.log?.(`Could not enumerate installed ${driverId} devices:`, messageOf(error));
    }
  }

  return { ids, enumerated };
}

/**
 * The most flow ids a sweep approval may carry.
 *
 * Every other list-shaped input in this app goes through
 * `requireArray(value, path, max)`, whose docblock argues the cap is "not
 * defensive theatre". This one did not, and it is the list that becomes a loop
 * over `deleteFlow`. Well above any real Homey: the app caps itself at 12 flow
 * variants per control and 12 windows per schedule.
 */
const MAX_APPROVED_FLOWS = 2000;

/**
 * One card per running device, with a device that cannot describe itself left
 * out rather than taking the page down.
 *
 * Every list in `getStatus` called `runtime.diagnostics()` straight inside a
 * `.map()`, so one throwing device made `GET /` fail and the WHOLE settings page
 * render nothing — no other device, no credential box, no orphan sweep. That is
 * not hypothetical: a Colour Curve Light whose stored plan carried a sun anchor
 * threw out of `valueAt()` on every call (see `CircadianAnchor` in
 * lib/circadian/circadian-types.ts, now refused at both gates).
 *
 * Omitted rather than shown as a broken card, because the two facts a fallback
 * card could carry truthfully — the id and the state — are already on the
 * device's own tile in Homey. A device missing from this page is visible as an
 * absence and invents nothing; the log line names which one and why.
 */
function cards<TRuntime, TCard>(
  app: LightkeeperApp,
  runtimes: readonly TRuntime[],
  idOfRuntime: (runtime: TRuntime) => string,
  card: (runtime: TRuntime) => TCard,
): TCard[] {
  const built: TCard[] = [];
  for (const runtime of runtimes) {
    try {
      built.push(card(runtime));
    } catch (error) {
      app.log?.(
        `Leaving ${idOfRuntime(runtime)} off the status page — its diagnostics threw:`,
        messageOf(error),
      );
    }
  }
  return built;
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
      controllers: cards(app, app.controllers.all(), r => r.controllerId, runtime => {
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
      schedules: cards(app, app.schedules.all(), r => r.controllerId, runtime => {
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
      circadian: cards(app, app.curves.all(), r => r.controllerId, runtime => {
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
      daylight: cards(app, app.daylights.all(), r => r.controllerId, runtime => {
        const diagnostics = runtime.diagnostics();
        return {
          id: runtime.controllerId,
          state: runtime.currentState,
          name: diagnostics.name,
          enabled: diagnostics.enabled,
          // What the response asks for now, and WHERE it came from — a room at
          // the wrong brightness is almost always one of those two.
          now: diagnostics.now,
          response: diagnostics.response,
          targetNames: diagnostics.targetNames,
          // Lights somebody has taken over by hand. Shown because a light that
          // has stopped following the room on purpose looks exactly like one
          // that has stopped by accident.
          overridden: diagnostics.targets.filter(target => target.overridden).length,
          sensors: diagnostics.sensors,
        };
      }),
      /**
       * The sky, and every watched sensor, for the whole Homey.
       *
       * Outside the per-device lists on purpose. "Does it know where the sun is"
       * is a question about the app rather than about a device, and it is the
       * single fastest check that the geolocation permission actually resolved
       * on this Homey — `null` there and a plausible number there are two very
       * different problems (platform §16).
       */
      sky: app.daylight.sky(),
      sensors: app.daylight.sensors(),
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
    const live = liveDeviceIds(app, homey);
    const preview = await app.bridge.countOrphans(live.ids);

    // A count computed from an incomplete live set is not a count worth showing
    // — see `liveDeviceIds`. Refused rather than corrected, because there is no
    // correction available: we do not know what the driver would have listed.
    return live.enumerated ? preview : { ...preview, refused: 'devices_unreadable' };
  },

  /**
   * Returns `{ deleted, kept, failed, unmanaged, refused? }`.
   *
   * The body MUST carry back the `token` and `flowIds` from the count the user
   * was actually shown, and a request without them deletes nothing.
   *
   * It used to fall through to an unapproved sweep, on the reasoning that "an
   * older page must not be broken by a newer app". There is no older page —
   * nothing has ever been published — so that protected nobody while leaving
   * the app's one bulk-delete callable with no approval at all, over a surface
   * anybody holding a Personal API Key can reach (platform §14). `countOrphans`
   * states the rule this restores: the user approved a specific set, not a
   * number.
   *
   * The refusal is structured rather than a throw, because the same shape
   * already carries `stale_preview` and `no_live_controllers` and the settings
   * page renders all three the same way. The manager's parameter stays optional
   * on purpose — the suite drives it directly, and that is a caller with no user
   * on the other end to approve anything.
   */
  async sweepOrphans({ homey, body }: any) {
    const app = appOf(homey);
    const live = liveDeviceIds(app, homey);

    const token = typeof body?.token === 'string' ? body.token : null;
    const flowIds = Array.isArray(body?.flowIds)
      ? requireArray(body.flowIds, 'flowIds', MAX_APPROVED_FLOWS).map(String)
      : null;

    if (!live.enumerated || !token || !flowIds) {
      // One extra read, on a path that deletes nothing, so the refusal can say
      // how many Flows it is declining to touch rather than reporting zero.
      const preview = await app.bridge.countOrphans(live.ids);
      return {
        deleted: 0,
        kept: preview.total,
        failed: 0,
        unmanaged: preview.unmanaged,
        refused: live.enumerated ? 'no_approval' : 'devices_unreadable',
      };
    }

    return app.bridge.sweepOrphans(live.ids, { token, flowIds });
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
  /**
   * The recorder's six routes, or nothing at all.
   *
   * Spread rather than written out because a launch build has no recorder:
   * `evidenceRoutes()` returns `{}` there, and the six route names simply do
   * not exist on this object. Defining them here would mean deleting them from
   * generated JavaScript instead, which is not a thing to do by string surgery.
   * See `lib/support/evidence-feature.ts`.
   */
  ...evidenceRoutes(appOf),

  async getDiagnostics({ homey }: any): Promise<DiagnosticsResponse> {
    const app = appOf(homey);
    return {
      generatedAt: Date.now(),
      evidence: app.evidence?.status() ?? null,
      // Never throws, and never assembled inline — platform §17 is the story of
      // one bare memory call inside a literal taking a whole health sample with
      // it, once a minute, for a week.
      heap: heapReport(),
      semantics: DIAGNOSTIC_SEMANTICS,
      eventHistory: app.recentEvents.retention(),
      app: { id: homey.manifest.id, version: homey.manifest.version },
      credential: app.credentials.getStatus(),
      // Most recent first — the fastest way to tell a Flow that never fired
      // from one that fired and was refused.
      recentEvents: app.recentEvents.entries(),
      controllers: app.controllers.all().map(runtime => runtime.diagnostics()),
      schedules: app.schedules.all().map(runtime => runtime.diagnostics()),
      circadian: app.curves.all().map(runtime => runtime.diagnostics()),
      daylight: app.daylights.all().map(runtime => runtime.diagnostics()),
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
   * Apply a saved circadian or Colour Curve Light's plan to its lights, now.
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
    /**
     * TWO registries, one route.
     *
     * "Apply this device's plan to its lights now" is the same request whether
     * the plan is a curve or a daylight response, and both runtimes answer the
     * same `applyNow`/`drain` pair with the same `{ writes, skipped }`. Adding a
     * second route would mean a second manifest entry and a caller that has to
     * know which kind of device it is holding an id for.
     */
    const runtime = app.curves.get(id) ?? app.daylights.get(id);
    if (!runtime) {
      throw new Error(
        `no circadian, Colour Curve or Room-sensing Light with id "${id}" is running`);
    }

    const outcome = await runtime.applyNow('preview', { force: true, waitForResults: true });
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
    if (!runtime) throw new Error(`no circadian or Colour Curve Light with id "${id}" is running`);
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
   * Tick every Room-sensing Light once, instead of waiting up to a minute.
   *
   * Its own route rather than folded into `tickCurves`, because that name would
   * then be a lie — and because the two are worth being able to drive
   * separately: a hardware pass watching whether the daylight loop settles wants
   * to advance THAT clock and nothing else. Returns `{ ticked }`.
   *
   * Note that one tick will usually not finish a move: the slew limit is a step
   * per tick by design, so a caller proving a fade has to call this several
   * times, exactly as the real minute-by-minute tick does.
   */
  async tickDaylight({ homey }: any) {
    const app = appOf(homey);
    await app.daylights.tickAll();
    return { ticked: app.daylights.all().length };
  },

  /**
   * A light sensor's own last week, as the pairing screen buckets it.
   *
   * Reachable outside pairing for the same reason the six routes above it are:
   * the mechanism is not new, only its reachability, and a hardware pass has to
   * be able to ask whether Insights answers at all on a given firmware without
   * opening a pairing sheet. It is also the one route that proves platform §1's
   * read-scope claim extends to Insights.
   *
   * `:id` is the SENSOR's Homey device id, not a Lightkeeper device's `data.id`
   * — this route is about a foreign device, so `idOf` does not apply. Answers
   * `{ available: false }` rather than failing when the log cannot be read,
   * which is the same thing the screen sees.
   */
  async getSensorHistory({ homey, params }: any) {
    const app = appOf(homey);
    const deviceId = String(params?.id ?? '');
    if (!deviceId) throw new Error('A sensor device id is required.');
    const week = await app.luminance.week(deviceId, timezoneOf(homey.clock));
    if (!week) return { available: false };
    return { available: true, ...week };
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
   * Replace a saved schedule's blocks. Body: `{ entries, days? }`.
   *
   * The one route here that writes a user's stored plan, so it is the one to be
   * careful with — and the care is entirely in refusing to be clever:
   *
   * - `sanitiseEntries` is the SAME function the pair session calls. Bad days,
   *   duplicate ids and anything over the twelve-block cap are dropped and
   *   NAMED, by one implementation rather than two that can drift.
   * - The write goes through `device.applyPlan`, never the store, so
   *   `DeviceLifecycle` runs its transaction: managed Flows carried forward, a
   *   plan that will not start rolled back, the state published.
   *
   * **An overlap is reported, not dropped.** Two blocks over the same lights
   * resolve deterministically — the later one wins while they coincide — and
   * dropping one here would disagree with the blocks screen, which draws the
   * clash and lets it stand. `overlaps` is how a caller learns about it.
   *
   * `days` belongs to the SCHEDULE rather than to a block, and is sent with the
   * rows for the same reason the screen edits them together: a partial save —
   * new rows against the old days — is a schedule nobody asked for. Omit it
   * and the stored days are kept.
   *
   * Returns `{ count, dropped, days, overlaps }` — the same shape the pairing
   * screen renders, so a caller learns what was refused and what will collide
   * rather than only how many stuck.
   */
  async setScheduleEntries({ homey, params, body }: any) {
    const id = idOf(params);
    const device = deviceOf(homey, 'schedule', id);
    const { entries, dropped } = sanitiseEntries(body?.entries);

    // Refusing an empty result rather than saving it: a schedule with no blocks
    // is a device that looks configured and can never fire, which is the exact
    // failure this app exists to prevent. An all-dropped payload is a mistake,
    // and the `dropped` list says which one.
    if (entries.length === 0) {
      throw new Error(dropped.length > 0
        ? `every block was dropped: ${dropped.map(d => d.reason).join('; ')}`
        : 'a schedule needs at least one block');
    }

    /**
     * The stored plan has to BE there, because this route only replaces part of
     * it.
     *
     * `{ ...undefined, entries, days }` is legal and produces a plan with no
     * `schemaVersion`, no `enabled` and no `target`. `applyPlan` then fails
     * validation, rolls back to `null` and leaves the device unavailable — so a
     * route that meant to change the blocks took the device offline instead.
     * Only reachable on a device whose store is already broken, which is exactly
     * when a clear message beats a quarantine.
     */
    const stored = device.getStoreValue('schedule');
    if (!stored || typeof stored !== 'object') {
      throw new Error(`the schedule device "${id}" has no stored plan to add blocks to`);
    }

    const days = body?.days === undefined
      ? stored?.days ?? null
      : sanitiseScheduleDays(body.days);

    await device.applyPlan({ ...stored, entries, days });
    return { count: entries.length, dropped, days, overlaps: overlappingPairs(entries, days) };
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
