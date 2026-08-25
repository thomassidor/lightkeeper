import Homey from 'homey';

import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { CURRENT_CIRCADIAN_SCHEMA_VERSION } from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_POINTS, MAX_POINTS, MIN_POINTS, sanitiseCurve,
  type CircadianPlan, type CircadianPoint,
} from '../../lib/circadian/circadian-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';

/**
 * The circadian driver owns: pair/repair session handlers, the data its two
 * screens need, and virtual device creation.
 *
 * **Two screens, and neither of them asks for an API key.** The controller and
 * the schedule both open with the credential view because both generate Flows and
 * an app's own token cannot write one (CLAUDE.md §1). This device type generates
 * none, so pairing is the light picker — shared byte-for-byte with the other two
 * drivers — and then the curve.
 *
 * The same views serve pairing and repair; repair arrives with the existing
 * values already selected.
 */

interface SessionState {
  target?: TargetSpec;
  points: CircadianPoint[];
  adjustBrightness: boolean;
  preStage: boolean;
}

module.exports = class CircadianDriver extends Homey.Driver {

  private get app(): any {
    return this.homey.app;
  }

  override async onInit() {
    this.log('Circadian driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, { points: [...DEFAULT_POINTS] });
  }

  override async onRepair(session: any, device: any) {
    const plan: CircadianPlan = device.getStoreValue('circadian');
    await this.bindSession(session, {
      target: plan?.target,
      points: plan?.points?.length ? plan.points : [...DEFAULT_POINTS],
      adjustBrightness: plan?.adjustBrightness ?? false,
      preStage: plan?.preStage ?? false,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      points: [...DEFAULT_POINTS], adjustBrightness: false, preStage: false, ...initial,
    };

    /**
     * Wrap every handler so failures reach the CLI log. A handler that throws
     * inside a pairing view otherwise surfaces as a screen that simply does
     * nothing, which is impossible to diagnose from the outside.
     */
    const handler = (name: string, fn: (...args: any[]) => Promise<unknown>) => {
      session.setHandler(name, async (...args: any[]) => {
        try {
          const result = await fn(...args);
          this.log(`pair/${name} ok`);
          return result;
        } catch (error) {
          this.error(`pair/${name} failed:`, (error as Error)?.message, (error as Error)?.stack);
          throw error;
        }
      });
    };

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    handler('listTargets', async () => listTargetsPayload(this.app.catalog, state.target));

    handler('selectTargets', async (spec: TargetSpec) => {
      state.target = spec;
      return resolveSummary(this.app.catalog, spec);
    });

    // ---------------------------------------------------------------- curve

    handler('getCurve', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const [summary, lights] = await Promise.all([
        resolveSummary(this.app.catalog, state.target),
        targetLights(this.app.catalog, state.target),
      ]);

      return {
        minPoints: MIN_POINTS,
        maxPoints: MAX_POINTS,
        // Which controls to offer at all: brightness is hidden rather than
        // shown-and-ignored when nothing selected supports it.
        support: summary.support,
        lights,
        points: state.points,
        adjustBrightness: state.adjustBrightness,
        preStage: state.preStage,
        // Shown on screen, because "warm at 20:00" is meaningless without saying
        // whose 20:00 — and a Homey in the wrong timezone is a real support case.
        timezone: this.timezone(),
      };
    });

    /**
     * Replace the whole curve, like the controller's setRules and the schedule's
     * setSchedules: simpler and less racy than per-row edits, and the list is at
     * most eight long.
     *
     * Everything arriving here is untrusted — it comes from a webview — so it goes
     * through sanitiseCurve(), which DROPS an invalid point and says why rather
     * than repairing it into a curve the user never asked for.
     */
    handler('setCurve', async (payload: {
      points: unknown; adjustBrightness?: boolean; preStage?: boolean;
    }) => {
      const result = sanitiseCurve(payload?.points, payload?.adjustBrightness === true);
      for (const drop of result.dropped) {
        this.log(`Dropped point ${drop.index + 1}: ${drop.reason}`);
      }
      state.points = result.points;
      state.adjustBrightness = result.adjustBrightness;
      state.preStage = payload?.preStage === true;

      return {
        count: result.points.length,
        adjustBrightness: result.adjustBrightness,
        dropped: result.dropped,
      };
    });

    /**
     * Apply the curve to the real lights, now, before anything is saved and
     * before a device exists. The primary defence against a device that looks
     * configured and does nothing.
     */
    handler('previewNow', async () => {
      const runtime = await this.app.circadian.ephemeral(this.buildPlan(state));
      try {
        // Forced: the user pressed a button and is owed a visible change, even
        // where the lights happen to be close to the curve already.
        const outcome = await runtime.applyNow('preview', { force: true });
        // Drained, so the count reported is writes attempted rather than writes
        // queued behind the burst limit.
        await runtime.drain();
        return outcome;
      } finally {
        await runtime.stop();
      }
    });

    /**
     * Prove pre-staging on this household's own lights rather than assuming it.
     * A colour write to an off lamp turns it on through some integrations
     * (CLAUDE.md §6), and this is the only way to find out which.
     */
    handler('testPreStage', async () => {
      const runtime = await this.app.circadian.ephemeral(this.buildPlan(state));
      try {
        return await runtime.probePreStage();
      } finally {
        await runtime.stop();
      }
    });

    // ----------------------------------------------------------------- save

    handler('save', async (name: string) => {
      const plan = this.buildPlan(state);

      if (device) {
        await device.applyPlan(plan);
        return { updated: true };
      }

      return {
        created: true,
        device: {
          name: name || await this.deriveName(state),
          data: { id: `lk-circ-${Date.now()}-${Math.round(Math.random() * 1e6)}` },
          store: { circadian: plan },
        },
      };
    });
  }

  private timezone(): string | null {
    try {
      return this.homey.clock?.getTimezone() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A readable default name, so the last screen needs no text field — Homey lets
   * the user rename a device afterwards, which is the natural place for it.
   */
  private async deriveName(state: SessionState): Promise<string> {
    if (!state.target) return 'Circadian light';

    if (state.target.kind === 'zone') {
      const zones = await this.app.catalog.allZones();
      const zone = zones.find((z: any) => z.id === (state.target as any).zoneId);
      return `${zone?.name ?? 'Zone'} circadian`;
    }

    const lights = await targetLights(this.app.catalog, state.target);
    if (lights.length === 0) return 'Circadian light';
    if (lights.length === 1) return `${lights[0]!.name} circadian`;

    // Where every light shares a room, the room reads better than a list.
    const zoneNames = new Set(lights.map(l => l.zoneName).filter(Boolean));
    if (zoneNames.size === 1) return `${[...zoneNames][0]} circadian`;

    return `${lights.length} lights circadian`;
  }

  private buildPlan(state: SessionState): CircadianPlan {
    if (!state.target) throw new Error('Choose some lights first.');
    if (state.points.length < MIN_POINTS) {
      throw new Error(`A curve needs at least ${MIN_POINTS} points.`);
    }

    return {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      points: state.points,
      adjustBrightness: state.adjustBrightness,
      preStage: state.preStage,
    };
  }

};
