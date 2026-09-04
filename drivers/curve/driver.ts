import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import { validateTargetAgainstCatalog } from '../../lib/validation/pairing-dto';
import Homey from 'homey';
import { randomUUID } from 'node:crypto';

import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { CURRENT_CURVE_SCHEMA_VERSION } from '../../lib/circadian/curve-migrations';
import {
  DEFAULT_POINTS, MAX_POINTS, MIN_POINTS, sanitiseCurve,
  type CircadianPlan, type CircadianPoint,
} from '../../lib/circadian/circadian-types';
import { PALETTE } from '../../lib/circadian/palette';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { messageOf } from '../../lib/support/homey-errors';

/**
 * The curve controller's driver: pair/repair session handlers, the data its two
 * screens need, and virtual device creation.
 *
 * **This device type is the circadian engine with the curve exposed.** Every
 * point, every time, and a colour per point from a closed palette. Its sibling —
 * `drivers/circadian/` — is the same engine asking two questions and supplying
 * the shape itself, and is the right first experience for "warm at night, cool in
 * the day". This one is for somebody who wants a specific evening.
 *
 * **Neither asks for an API key.** The controller and the schedule both open with
 * the credential view because both generate Flows and an app's own token cannot
 * write one (platform §1). Neither of these generates any, so pairing is the
 * light picker — shared byte-for-byte with the other drivers — and then the curve.
 *
 * The same views serve pairing and repair; repair arrives with the existing
 * values already selected.
 */

interface SessionState {
  daylight?: DaylightResponse;
  target?: TargetSpec;
  points: CircadianPoint[];
  adjustBrightness: boolean;
  preStage: boolean;
}

module.exports = class CurveDriver extends Homey.Driver {

  private get app(): any {
    return this.homey.app;
  }

  override async onInit() {
    this.log('Curve driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, { points: [...DEFAULT_POINTS] });
  }

  override async onRepair(session: any, device: any) {
    const plan: CircadianPlan = device.getStoreValue('curve');
    await this.bindSession(session, {
      target: plan?.target,
      points: plan?.points?.length ? plan.points : [...DEFAULT_POINTS],
      adjustBrightness: plan?.adjustBrightness ?? false,
      preStage: plan?.preStage ?? false,
      // Seeded so a repair session opens the card on what the device already
      // has rather than on the defaults.
      daylight: plan?.daylight,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      points: [...DEFAULT_POINTS], adjustBrightness: false, preStage: false, ...initial,
    };

    /**
     * This session's claim on the shared sensor service, and why it needs an id
     * of its own.
     *
     * The daylight card shows what each chosen sensor currently reads, and a
     * sensor nobody is subscribed to has no reading — so the session has to
     * retain them while it is open. `retain` is ref-counted and TOTAL per owner,
     * so a fixed string would make two people pairing at once release each
     * other's sensors, and either screen would silently start showing the sky.
     *
     * Released on `disconnect` below. Without that, abandoning a pairing screen
     * leaves a subscription on somebody's battery-powered motion sensor for as
     * long as the app runs.
     */
    const sessionOwner = `pair-${randomUUID()}`;

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
          this.error(`pair/${name} failed:`, messageOf(error), (error as Error)?.stack);
          throw error;
        }
      });
    };

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    // The targets view is ONE file shared by all four drivers (platform §8), so the
    // line telling the user which lights these are has to be supplied per driver.
    // Resolved here rather than in `lib/`, which cannot translate.
    handler('listTargets', async () => ({
      ...await listTargetsPayload(this.app.catalog, state.target),
      subtitle: this.homey.__('targets.subtitleCurve'),
    }));

    handler('selectTargets', async (spec: unknown) => {
      // The pairing channel is a webview, so this is the same class of boundary
      // as a generated Flow's arguments: shape AND membership are checked before
      // anything is persisted. A well-formed id naming something that is not a
      // light saves a device that resolves to nothing.
      const target = await validateTargetAgainstCatalog(spec, this.app.catalog);
      state.target = target;
      return resolveSummary(this.app.catalog, target);
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
        /**
         * The colours a point may be set to, with their labels resolved HERE.
         *
         * `lib/` has no access to `homey.__`, so the palette carries locale keys
         * and the driver layer turns them into words — the same rule as every
         * other user-facing string produced in `lib/`.
         */
        palette: PALETTE.map(color => ({
          id: color.id,
          label: this.homey.__(color.labelKey),
          hue: color.hue,
          saturation: color.saturation,
        })),
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
      const runtime = await this.app.curves.ephemeral(this.buildPlan(state));
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
     * (platform §6), and this is the only way to find out which.
     */
    handler('testPreStage', async () => {
      const runtime = await this.app.curves.ephemeral(this.buildPlan(state));
      try {
        return await runtime.probePreStage();
      } finally {
        await runtime.stop();
      }
    });

    // ------------------------------------------------------------- daylight

    /**
     * The three handlers the shared daylight card calls.
     *
     * Byte-identical on all four drivers that carry that card, and deliberately
     * SEPARATE from this driver's own `get`/`set` pair rather than folded into
     * it. That is what lets one view file serve four screens: the card fetches
     * and pushes its own response and never asks the surrounding screen to
     * thread it through.
     */
    handler('listSensors', async () => listSensorsPayload(
      this.app.catalog, state.daylight?.sensors ?? [],
    ));

    handler('getDaylight', async () => {
      const response = state.daylight ?? DEFAULT_RESPONSE;
      return {
        // FALSE here: this card is a section of this driver's own screen, which
        // owns the Save and the Test. Only the Daylight light's own screen is
        // the card, and only there does it draw a footer.
        standalone: false,
        response,
        limits: { minLux: MIN_LUX, maxLux: MAX_LUX },
        now: this.app.daylight.evaluate(response),
        sky: this.app.daylight.sky(),
        sensorReadings: this.app.daylight.sensors(),
      };
    });

    handler('setDaylight', async (payload: unknown) => {
      const result = sanitiseResponse((payload as { response?: unknown })?.response ?? payload);
      for (const field of result.corrected) {
        this.log(`Corrected daylight ${field} to its default: the screen sent something unusable`);
      }
      state.daylight = result.response;

      // Retained before `now` can mean anything: a sensor nobody is subscribed
      // to has no reading, and the card would show the sky for a device that has
      // just been given a sensor.
      await this.app.luminance.retain(result.response.sensors, sessionOwner);

      return {
        response: result.response,
        corrected: result.corrected,
        now: this.app.daylight.evaluate(result.response),
        sensorReadings: this.app.daylight.sensors(),
      };
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
          data: { id: mintDeviceId('curv') },
          store: { curve: plan },
        },
      };
    });

    /**
     * Give the sensors back when the screen closes, however it closes.
     *
     * Saved, cancelled or abandoned — all three arrive here, and all three must
     * release. A saved device retains its own sensors under its own device id,
     * so releasing this session's claim never takes a live device's subscription
     * with it; that is exactly what the ref count is for.
     */
    session.setHandler('disconnect', async () => {
      try {
        await this.app.luminance.release(sessionOwner);
      } catch (error) {
        this.error('Releasing the pairing session sensors failed:', messageOf(error));
      }
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
    return deriveSuffixedName(this.app.catalog, state.target, {
      fallback: 'Curve light', suffix: 'curve', zoneFallback: 'Zone',
    });
  }

  private buildPlan(state: SessionState): CircadianPlan {
    if (!state.target) throw new Error('Choose some lights first.');
    if (state.points.length < MIN_POINTS) {
      throw new Error(`A curve needs at least ${MIN_POINTS} points.`);
    }

    return {
      schemaVersion: CURRENT_CURVE_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      points: state.points,
      adjustBrightness: state.adjustBrightness,
      // Absent stays absent: `undefined` is "this device has no response", and
      // the validator refuses a point that follows the daylight without one.
      ...(state.daylight !== undefined ? { daylight: state.daylight } : {}),
      preStage: state.preStage,
    };
  }

};
