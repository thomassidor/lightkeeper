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
function liveDeviceIds(app: any, homey: any): Set<string> {
  const ids = new Set<string>([
    ...app.controllers.all().map((r: any) => r.controllerId),
    ...app.schedules.all().map((r: any) => r.controllerId),
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
  async getStatus({ homey }: any) {
    const app = homey.app;
    return {
      credential: app.credentials.getStatus(),
      recentEvents: app.recentEvents.entries().slice(0, 12),
      controllers: app.controllers.all().map((runtime: any) => ({
        id: runtime.controllerId,
        state: runtime.currentState,
        sourceName: runtime.currentProfile?.source?.name ?? null,
        mappings: runtime.currentProfile?.mappings?.filter((m: any) => m.inputKey).length ?? 0,
        managedFlows: runtime.currentProfile?.managedFlows?.length ?? 0,
        schedulerReady: runtime.diagnostics().schedulerReady,
        targetNames: runtime.diagnostics().targetNames,
      })),
      schedules: app.schedules.all().map((runtime: any) => {
        const diagnostics = runtime.diagnostics();
        return {
          id: runtime.controllerId,
          state: runtime.currentState,
          name: diagnostics.name,
          enabled: diagnostics.enabled,
          entries: diagnostics.entries,
          managedFlows: diagnostics.managedFlows?.length ?? 0,
          // The Homey's own clock, echoed back. "It fired an hour late" is
          // almost always a timezone answer, and this is where it is visible.
          timezone: diagnostics.timezone,
          localTime: diagnostics.localTime,
          targetNames: diagnostics.targetNames,
          lastAction: diagnostics.lastAction,
        };
      }),
      circadian: app.circadian.all().map((runtime: any) => {
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
          overridden: (diagnostics.targets as any[]).filter(t => t.overridden).length,
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
    const token = String(body?.token ?? '');
    // Validate with a WRITE: reads succeed on credentials that cannot write,
    // so a read-based check gives false confidence.
    return homey.app.credentials.setCredential(
      token,
      (client: any) => flowWriteProbe(client, (...args: unknown[]) => homey.app.log(...args)),
    );
  },

  /** Forget the stored key. Returns `{ cleared: true }`. */
  async deleteCredential({ homey }: any) {
    homey.app.credentials.clearCredential();
    return { cleared: true };
  },

  /**
   * Generated Flows whose controller no longer exists. Reported before deleting
   * so the user sees the scale of it rather than being asked to trust a button.
   *
   * Returns `{ total, orphans, unmanaged, liveControllers, flowIds, examples,
   * token, refused? }`.
   *
   * `refused` is set when nothing is running: every managed flow then LOOKS
   * orphaned, and the count must not be presented as if it were trustworthy.
   * `unmanaged` counts flows attributed to a dead device that do NOT match the
   * template this app generates — found, reported, never deleted.
   * `token` and `flowIds` are handed back to the sweep, which refuses a stale
   * one: the user approved a specific set, not a number.
   */
  async countOrphans({ homey }: any) {
    const app = homey.app;
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
    const app = homey.app;
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
  async getDiagnostics({ homey }: any) {
    const app = homey.app;
    return {
      generatedAt: Date.now(),
      app: { id: homey.manifest.id, version: homey.manifest.version },
      credential: app.credentials.getStatus(),
      // Most recent first — the fastest way to tell a Flow that never fired
      // from one that fired and was refused.
      recentEvents: app.recentEvents.entries(),
      controllers: app.controllers.all().map((runtime: any) => runtime.diagnostics()),
      schedules: app.schedules.all().map((runtime: any) => runtime.diagnostics()),
      circadian: app.circadian.all().map((runtime: any) => runtime.diagnostics()),
      // Which of Homey's own trigger cards the schedules are built on, and what
      // else was on offer. A card URI may never be constructed (CLAUDE.md §3), so when a
      // firmware moves this card the candidate list IS the investigation.
      timeCard: await app.schedules.timeCard().catch((error: any) => ({
        card: null,
        error: String(error?.message ?? error),
      })),
    };
  },

};
