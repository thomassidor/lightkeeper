import Homey from 'homey';

import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import {
  resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import {
  sanitiseResponse, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { CURRENT_CIRCADIAN_SCHEMA_VERSION } from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_SIMPLE_PLAN, SIMPLE_SHAPE, expandSimplePlan, sanitiseSimplePlan,
  type CircadianEnd, type SimpleCircadianPlan,
} from '../../lib/circadian/simple-curve';
import { formatMinutes } from '../../lib/time/wall-clock';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  handlerRegistrar,
  newSessionOwner,
  registerDaylightCardHandlers,
  registerTargetHandlers,
  releaseOnDisconnect,
  timezoneOf,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

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

  /**
   * What `lib/pairing/pair-session.ts` needs of this driver.
   *
   * Four members and no `Homey.Driver` among them, which is the point: the
   * shared mechanics stay importable by a test (platform §13). Built per call
   * because a session binds it once and it costs nothing.
   */
  private pairHost(): PairSessionHost {
    return {
      log: (...args: unknown[]) => this.log(...args),
      error: (...args: unknown[]) => this.error(...args),
      translate: (key: string) => this.homey.__(key),
      clock: this.homey.clock,
      app: this.app,
    };
  }

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

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);
    const sessionOwner = newSessionOwner();

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, 'targets.subtitleCircadian');

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

    registerDaylightCardHandlers(host, handler, state, sessionOwner);

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

    releaseOnDisconnect(host, session, sessionOwner);
  }

  private timezone(): string | null {
    return timezoneOf(this.pairHost());
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
