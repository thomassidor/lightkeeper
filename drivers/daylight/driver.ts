import Homey from 'homey';

import {
  resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import { CURRENT_DAYLIGHT_SCHEMA_VERSION } from '../../lib/daylight/daylight-migrations';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse,
  type DaylightPlan, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  handlerRegistrar,
  newSessionOwner,
  registerSaveHandler,
  registerTargetHandlers,
  releaseOnDisconnect,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

/**
 * The Daylight light's driver: two screens, and the second one is the daylight
 * card.
 *
 * **What this device type is.** It holds a room at a brightness that depends on
 * how much light is already in it — dimming the lamps when the daylight is doing
 * the work and lifting them when it is not, or the other way round, because the
 * two ends are the user's to set and neither is a mode. The reading comes from
 * `measure_luminance` sensors the household already owns, and where there are
 * none, from the sun's own elevation computed off the Homey's position
 * (platform §16).
 *
 * **Neither screen asks for an API key.** The controller and the schedule both
 * open with the credential view because both generate Flows and an app's own
 * token cannot write one (platform §1). This device type generates none, so
 * pairing is the light picker — shared byte-for-byte with the other drivers —
 * and then the response.
 *
 * The same views serve pairing and repair; repair arrives with the existing
 * values already filled in.
 */

interface SessionState {
  target?: TargetSpec;
  response: DaylightResponse;
}

module.exports = class DaylightDriver extends Homey.Driver {

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
    this.log('Daylight driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, {});
  }

  override async onRepair(session: any, device: any) {
    const plan: DaylightPlan = device.getStoreValue('daylight');
    await this.bindSession(session, {
      target: plan?.target,
      response: plan?.response ?? DEFAULT_RESPONSE,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      response: DEFAULT_RESPONSE,
      ...initial,
    };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);
    const sessionOwner = newSessionOwner();

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, 'targets.subtitleDaylight');

    // ------------------------------------------------------------- daylight

    /**
     * The sensor list, and it is deliberately a separate handler from
     * `getDaylight`.
     *
     * Every device type that carries the daylight card answers this one, with
     * the same payload, so the card can be the same code in each of them. A
     * screen that had to fetch the sensors as part of a bigger reply would be a
     * screen whose sensor list could not be refreshed on its own.
     */
    handler('listSensors', async () => listSensorsPayload(
      this.app.catalog, state.response.sensors,
    ));

    handler('getDaylight', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      // Retained on the way IN as well as on every change: a repair session
      // arrives with sensors already chosen, and their readings are the first
      // thing the card has to show.
      await this.app.luminance.retain(state.response.sensors, sessionOwner);
      const [summary, lights] = await Promise.all([
        resolveSummary(this.app.catalog, state.target),
        targetLights(this.app.catalog, state.target),
      ]);

      return {
        /**
         * `standalone` is what makes ONE view file serve every driver that
         * carries this card.
         *
         * True here: this is the Daylight light's own last screen, so it draws
         * the Save and Test footer. On a schedule, a circadian light or a Curve
         * light the same card is a section of that driver's own screen, which
         * owns the footer — and the card must not draw a second one. The same
         * trick the shared light picker already plays with its subtitle.
         */
        standalone: true,
        // Which controls to offer at all: a response is meaningless against
        // lights that cannot dim, and the screen says so rather than saving a
        // device that can do nothing.
        support: summary.support,
        lights,
        response: state.response,
        limits: { minLux: MIN_LUX, maxLux: MAX_LUX },
        /**
         * What it reads RIGHT NOW — the sun's elevation, the sensors and the
         * resulting level.
         *
         * The single most useful thing on this screen. Two numbers labelled
         * "dark" and "bright" are a guess until you can see what the room
         * currently reads, and this is also where a user finds out that the
         * Homey has never been told where it is.
         */
        now: this.app.daylight.evaluate(state.response),
        sky: this.app.daylight.sky(),
        sensorReadings: this.app.daylight.sensors(),
      };
    });

    /**
     * Replace the whole response at once, like the curve's `setCurve` and the
     * schedule's `setSchedules`. Everything arriving here is untrusted — it
     * comes from a webview — so it goes through `sanitiseResponse`, which falls
     * back per FIELD and reports which fields it had to correct.
     *
     * Falling back rather than dropping, like the circadian light's sanitiser
     * and unlike the curve's, because there is nothing droppable: a response is
     * not a list, and a response missing an end is not a degraded response — it
     * is a device that cannot be evaluated at all.
     */
    handler('setDaylight', async (payload: unknown) => {
      const result = sanitiseResponse((payload as { response?: unknown })?.response ?? payload);
      for (const field of result.corrected) {
        this.log(`Corrected ${field} to its default: the screen sent something unusable`);
      }
      state.response = result.response;

      // The sensors have to be retained before `now` can mean anything: a
      // sensor nobody is subscribed to has no reading, and the screen would show
      // the sky for a device that has just been given a sensor.
      await this.app.luminance.retain(state.response.sensors, sessionOwner);

      return {
        response: state.response,
        corrected: result.corrected,
        now: this.app.daylight.evaluate(state.response),
        sensorReadings: this.app.daylight.sensors(),
      };
    });

    /**
     * Apply the response to the real lights, now, before anything is saved and
     * before a device exists. The primary defence against a device that looks
     * configured and does nothing.
     */
    handler('previewNow', async () => {
      const runtime = await this.app.daylights.ephemeral(this.buildPlan(state));
      try {
        // Forced: the user pressed a button and is owed a visible change, so
        // both dampers are bypassed. Slewing a preview over ninety seconds would
        // read as a button that did nothing.
        const outcome = await runtime.applyNow('preview', { force: true });
        // Drained, so the count reported is writes attempted rather than writes
        // queued behind the burst limit.
        await runtime.drain();
        return outcome;
      } finally {
        await runtime.stop();
      }
    });

    // ----------------------------------------------------------------- save

    registerSaveHandler(host, handler, state, {
      device,
      idPrefix: 'dayl',
      storeKey: 'daylight',
      naming: { fallback: 'Daylight light', suffix: 'daylight' },
      buildPlan: () => this.buildPlan(state),
    });

    releaseOnDisconnect(host, session, sessionOwner);
  }

  private buildPlan(state: SessionState): DaylightPlan {
    if (!state.target) throw new Error('Choose some lights first.');

    return {
      schemaVersion: CURRENT_DAYLIGHT_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      response: state.response,
    };
  }

};
