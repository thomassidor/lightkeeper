import Homey from 'homey';
import { randomUUID } from 'node:crypto';

import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import { validateTargetAgainstCatalog } from '../../lib/validation/pairing-dto';
import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import { CURRENT_DAYLIGHT_SCHEMA_VERSION } from '../../lib/daylight/daylight-migrations';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse,
  type DaylightPlan, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { messageOf } from '../../lib/support/homey-errors';

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

    /**
     * This session's claim on the shared sensor service, and why it needs an id
     * of its own.
     *
     * The screen shows what each chosen sensor currently reads, and a sensor
     * nobody is subscribed to has no reading — so the session has to retain them
     * while it is open. `retain` is ref-counted and TOTAL per owner, so a fixed
     * string would make two people pairing at once release each other's sensors,
     * and either screen would silently start showing the sky instead.
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

    // The targets view is ONE file shared by every driver (platform §8), so the
    // line telling the user which lights these are has to be supplied per
    // driver. Resolved here rather than in `lib/`, which cannot translate.
    handler('listTargets', async () => ({
      ...await listTargetsPayload(this.app.catalog, state.target),
      subtitle: this.homey.__('targets.subtitleDaylight'),
    }));

    handler('selectTargets', async (spec: unknown) => {
      // The pairing channel is a webview, so this is the same class of boundary
      // as a generated Flow's arguments: shape AND membership are checked before
      // anything is persisted.
      const target = await validateTargetAgainstCatalog(spec, this.app.catalog);
      state.target = target;
      return resolveSummary(this.app.catalog, target);
    });

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
          data: { id: mintDeviceId('dayl') },
          store: { daylight: plan },
        },
      };
    });

    /**
     * Give the sensors back when the screen closes, however it closes.
     *
     * Saved, cancelled or abandoned — all three arrive here, and all three must
     * release. A saved device retains its own sensors under its own device id
     * from `buildRuntime`, so releasing this session's claim never takes a live
     * device's subscription with it; that is exactly what the ref count is for.
     */
    session.setHandler('disconnect', async () => {
      try {
        await this.app.luminance.release(sessionOwner);
      } catch (error) {
        this.error('Releasing the pairing session sensors failed:', messageOf(error));
      }
    });
  }

  /**
   * A readable default name, so the last screen needs no text field — Homey lets
   * the user rename a device afterwards, which is the natural place for it.
   */
  private async deriveName(state: SessionState): Promise<string> {
    return deriveSuffixedName(this.app.catalog, state.target, {
      fallback: 'Daylight light', suffix: 'daylight', zoneFallback: 'Zone',
    });
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
