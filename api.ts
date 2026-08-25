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
function liveDeviceIds(app: any): Set<string> {
  return new Set([
    ...app.controllers.all().map((r: any) => r.controllerId),
    ...app.schedules.all().map((r: any) => r.controllerId),
  ]);
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
   * `recentWrites` comes from the FIRST controller only — it is a "did anything
   * reach a light" indicator, not a per-controller log. The full per-controller
   * view is in getDiagnostics.
   */
  async getStatus({ homey }: any) {
    const app = homey.app;
    return {
      credential: app.credentials.getStatus(),
      recentEvents: app.recentEvents.slice(0, 12),
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
      recentWrites: (
        app.controllers.all()[0]?.diagnostics().recentWrites
        ?? app.schedules.all()[0]?.diagnostics().recentWrites
        ?? app.circadian.all()[0]?.diagnostics().recentWrites
        ?? []
      ).slice(0, 10),
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
    return homey.app.credentials.setCredential(token, async (client: any) => {
      const folder = await client.flow.createFlowFolder({
        flowfolder: { name: 'Lightkeeper (checking permissions)' },
      });
      await client.flow.deleteFlowFolder({ id: folder.id });
    });
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
   * Returns `{ total, orphans, liveControllers, examples, refused? }`. `refused`
   * is set when no controller is running: every managed flow then LOOKS
   * orphaned, and the count must not be presented as if it were trustworthy.
   */
  async countOrphans({ homey }: any) {
    const app = homey.app;
    const live = liveDeviceIds(app);
    const managed = await app.bridge.findManagedFlows();
    const orphans = managed.filter((f: any) => !f.controllerId || !live.has(f.controllerId));
    return {
      total: managed.length,
      orphans: orphans.length,
      liveControllers: live.size,
      examples: orphans.slice(0, 5).map((f: any) => f.name),
      ...(live.size === 0 && managed.length > 0 ? { refused: 'no_live_controllers' } : {}),
    };
  },

  /** Returns `{ deleted, kept, failed, refused? }`. See countOrphans. */
  async sweepOrphans({ homey }: any) {
    const app = homey.app;
    return app.bridge.sweepOrphans(liveDeviceIds(app));
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
      recentEvents: app.recentEvents,
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
