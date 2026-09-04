import Homey from 'homey';
import { randomUUID } from 'node:crypto';

import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import { validateTargetAgainstCatalog } from '../../lib/validation/pairing-dto';
import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { CURRENT_CIRCADIAN_SCHEMA_VERSION } from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_SIMPLE_PLAN, SIMPLE_SHAPE, expandSimplePlan, sanitiseSimplePlan,
  type CircadianEnd, type SimpleCircadianPlan,
} from '../../lib/circadian/simple-curve';
import { formatMinutes } from '../../lib/time/wall-clock';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { messageOf } from '../../lib/support/homey-errors';

/**
 * The circadian light's driver: two screens, and the second one asks two
 * questions.
 *
 * **What this device type is, and what it deliberately is not.** It follows the
 * colour of the day — warm at night, cool through the middle — and the only thing
 * it asks is what those two ends should look like. The SHAPE is a constant
 * (`SIMPLE_SHAPE`), not a setting: once the times are adjustable this is the curve
 * controller with fewer fields, and the two device types stop being different
 * products. Somebody who wants their own times, or a colour at a particular hour,
 * adds a Curve light instead.
 *
 * **Neither screen asks for an API key.** The controller and the schedule both
 * open with the credential view because both generate Flows and an app's own token
 * cannot write one (platform §1). This device type generates none, so pairing is
 * the light picker — shared byte-for-byte with the other drivers — and then the
 * two ends.
 *
 * The same views serve pairing and repair; repair arrives with the existing values
 * already selected.
 */

interface SessionState {
  daylight?: DaylightResponse;
  target?: TargetSpec;
  warmest: CircadianEnd;
  coolest: CircadianEnd;
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
    await this.bindSession(session, {});
  }

  override async onRepair(session: any, device: any) {
    const plan: SimpleCircadianPlan = device.getStoreValue('circadian');
    await this.bindSession(session, {
      target: plan?.target,
      warmest: plan?.warmest ?? DEFAULT_SIMPLE_PLAN.warmest,
      coolest: plan?.coolest ?? DEFAULT_SIMPLE_PLAN.coolest,
      adjustBrightness: plan?.adjustBrightness ?? false,
      preStage: plan?.preStage ?? false,
      // Seeded so a repair session opens the card on what the device already
      // has rather than on the defaults.
      daylight: plan?.daylight,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      warmest: DEFAULT_SIMPLE_PLAN.warmest,
      coolest: DEFAULT_SIMPLE_PLAN.coolest,
      adjustBrightness: DEFAULT_SIMPLE_PLAN.adjustBrightness,
      preStage: DEFAULT_SIMPLE_PLAN.preStage,
      ...initial,
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
      subtitle: this.homey.__('targets.subtitleCircadian'),
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

    // ----------------------------------------------------------------- ends

    handler('getEnds', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const [summary, lights] = await Promise.all([
        resolveSummary(this.app.catalog, state.target),
        targetLights(this.app.catalog, state.target),
      ]);

      return {
        // Which controls to offer at all: brightness is hidden rather than
        // shown-and-ignored when nothing selected supports it.
        support: summary.support,
        lights,
        warmest: state.warmest,
        coolest: state.coolest,
        adjustBrightness: state.adjustBrightness,
        preStage: state.preStage,
        /**
         * The shape, read-only, so the screen can say WHEN each end applies.
         *
         * A slider labelled "warmest" with no times beside it is a slider whose
         * effect the user has to guess at. Sent rather than hardcoded in the view
         * because the shape is a constant in one place and this is that place's
         * only consumer.
         */
        shape: SIMPLE_SHAPE.map(point => ({ at: formatMinutes(point.minute), end: point.end })),
        // Shown on screen, because "warm at 21:00" is meaningless without saying
        // whose 21:00 — and a Homey in the wrong timezone is a real support case.
        timezone: this.timezone(),
      };
    });

    /**
     * Replace both ends at once, like the curve's `setCurve` and the schedule's
     * `setSchedules`. Everything arriving here is untrusted — it comes from a
     * webview — so it goes through `sanitiseSimplePlan`, which falls back per
     * FIELD and reports which fields it had to correct.
     *
     * Falling back rather than dropping, unlike the curve's sanitiser, because
     * there is nothing droppable: two ends are not a list, and a device with one
     * end is not a degraded device — it is a device with no curve at all.
     */
    handler('setEnds', async (payload: unknown) => {
      const result = sanitiseSimplePlan(payload);
      for (const field of result.corrected) {
        this.log(`Corrected ${field} to its default: the screen sent something unusable`);
      }
      state.warmest = result.warmest;
      state.coolest = result.coolest;
      state.adjustBrightness = result.adjustBrightness;
      state.preStage = (payload as { preStage?: unknown })?.preStage === true;

      return {
        warmest: state.warmest,
        coolest: state.coolest,
        adjustBrightness: state.adjustBrightness,
        corrected: result.corrected,
      };
    });

    /**
     * Apply the curve to the real lights, now, before anything is saved and
     * before a device exists. The primary defence against a device that looks
     * configured and does nothing.
     */
    handler('previewNow', async () => {
      const runtime = await this.app.curves.ephemeral(expandSimplePlan(this.buildPlan(state)));
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
      const runtime = await this.app.curves.ephemeral(expandSimplePlan(this.buildPlan(state)));
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
          data: { id: mintDeviceId('circ') },
          store: { circadian: plan },
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
      fallback: 'Circadian light', suffix: 'circadian', zoneFallback: 'Zone',
    });
  }

  private buildPlan(state: SessionState): SimpleCircadianPlan {
    if (!state.target) throw new Error('Choose some lights first.');

    return {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      warmest: state.warmest,
      coolest: state.coolest,
      adjustBrightness: state.adjustBrightness,
      // Absent stays absent: `undefined` is "this device has no response", and
      // the validator refuses an end that follows the daylight without one.
      ...(state.daylight !== undefined ? { daylight: state.daylight } : {}),
      preStage: state.preStage,
    };
  }

};
