/**
 * App Web API consumed by settings/index.html. Route names must match the
 * "api" block in .homeycompose/app.json.
 *
 * §9.5 / §12: nothing here ever returns the API key, and diagnostics carry no
 * secrets or unrelated Homey configuration.
 *
 * Every handler's return shape is documented below, because the settings page
 * is the only consumer and there is no schema between the two.
 */
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
      // Writes actually attempted against lights — the step after an event is
      // accepted, and where a working-looking app can still do nothing.
      recentWrites: (app.controllers.all()[0]?.diagnostics().recentWrites ?? []).slice(0, 10),
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
    // which is exactly how the original refusal was nearly misdiagnosed.
    return homey.app.credentials.setCredential(token, async (client: any) => {
      const folder = await client.flow.createFlowFolder({
        flowfolder: { name: 'Light Link (checking permissions)' },
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
    const live = new Set(app.controllers.all().map((r: any) => r.controllerId));
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
    const live = new Set(app.controllers.all().map((r: any) => r.controllerId));
    return app.bridge.sweepOrphans(live);
  },

  /**
   * §9.5 — for troubleshooting and bug reports, not for setup.
   *
   * ```
   * {
   *   generatedAt, app: { id, version },
   *   credential:  { present, valid, failure?, hint?, lastCheckedAt? },
   *   recentEvents: [...],                  // every retained event, not just 12
   *   controllers:  [ControllerRuntime.diagnostics(), ...],
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
    };
  },

};
