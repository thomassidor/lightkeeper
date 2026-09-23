import Homey from 'homey';
import type { LightkeeperApp } from '../../lib/app-contract';
import { formatMinutes } from '../../lib/time/wall-clock';
import { localNow } from '../../lib/time/local-clock';
import { solarElevation, sunTimes } from '../../lib/daylight/solar-elevation';
import type { WatchedSensor } from '../../lib/daylight/luminance-source';
import { lightsSummary, registerIntroHandler, registerReviewHandler } from '../../lib/pairing/flow-screens';
import { validateSensorsAgainstCatalog } from '../../lib/validation/pairing-dto';

import {
  resolveSummary,
} from '../../lib/pairing/target-picker';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import { CURRENT_DAYLIGHT_SCHEMA_VERSION } from '../../lib/daylight/daylight-migrations';
import {
  DEFAULT_RESPONSE, LUMINANCE_CAPABILITY, SENSOR_STALE_MS, sanitiseResponse, usableLocation,
  type DaylightPlan, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { keepsLightsUpdated, writesLightsField } from '../../lib/runtime/writes-lights';
import { registerControlHandlers, reviewControl } from '../../lib/pairing/control-choice';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  handlerRegistrar,
  newSessionOwner,
  registerSaveHandler,
  registerTargetHandlers,
  releaseOnDisconnect,
  timezoneOf,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

/**
 * The Room-sensing Light's driver: two screens, and the second one is the daylight
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
  /** Keep the lights up to date all day, or only publish. See lib/runtime/writes-lights.ts. */
  writesLights: boolean;
  /**
   * Whether the two LUX thresholds are somebody's decision rather than ours.
   *
   * True once a person has had them in front of them with a sensor chosen: a
   * repair of a device that was saved reading a sensor, or any `setDaylight`
   * pushed while one is chosen — the response screen pushes only on an edit.
   * `getResponse` pre-fills the sensor's week's suggestion only while this is
   * false, because "still equal to the defaults" cannot tell a default nobody
   * looked at from a default somebody kept on purpose, and overwriting the
   * second is exactly what the suggestion's own comment promised not to do.
   *
   * Following the sun does NOT settle them. The response screen shows angles
   * then, so a household that repairs a sun-following device and picks its
   * first sensor has never seen a lux number and is owed the suggestion.
   */
  luxChosen: boolean;
}


/** The week grid's own labels, Monday first — ISO weekday 1 is `week.mon`. */
const WEEKDAY_KEYS = ['week.mon', 'week.tue', 'week.wed', 'week.thu', 'week.fri', 'week.sat', 'week.sun'];

/** The later of two optional instants. */
function newest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
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
      translate: (key: string, tokens?: Record<string, string | number>) =>
        this.homey.__(key, tokens),
      clock: this.homey.clock,
      app: this.app,
    };
  }

  /**
   * The app, through the contract rather than as `any`.
   *
   * This used to be `: any`, and the hardware pass is what found out what that
   * cost: `catalog.devices()` and `catalog.getDevice()` do not exist — the
   * methods are `allDevices()` and `device()` — and six call sites across three
   * drivers shipped, invisible to `tsc`, the suite and `validate` alike,
   * throwing the first time a real screen asked for them. `this.homey.app` is
   * `App` from the SDK's own types, so the double cast is the seam; `LightkeeperApp`
   * is the surface a driver is allowed to use.
   */
  private get app(): LightkeeperApp {
    return this.homey.app as unknown as LightkeeperApp;
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
      // Absent means ON: every device paired before the switch existed writes.
      writesLights: plan ? keepsLightsUpdated(plan) : true,
      // Saved reading a sensor: its lux thresholds are what somebody saved.
      luxChosen: typeof plan?.response?.sensor === 'string',
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      response: DEFAULT_RESPONSE,
      writesLights: true,
      luxChosen: false,
      ...initial,
    };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);
    const sessionOwner = newSessionOwner();

    handler('add_device', async () => true);

    // ---------------------------------------------------------------- intro

    registerIntroHandler(host, handler, {
      titleKey: 'intro.daylightTitle',
      blurbKey: 'intro.daylightBlurb',
      hero: 'daylight',
      decisions: [
        { whatKey: 'intro.whichLights', whyKey: 'intro.whichLightsWhy' },
        { whatKey: 'intro.theSensor', whyKey: 'intro.theSensorWhy' },
        { whatKey: 'intro.theResponse', whyKey: 'intro.theResponseWhy' },
        { whatKey: 'intro.checkIt', whyKey: 'intro.checkItWhy' },
      ],
      nextView: 'lights',
    });

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, {
      subtitleKey: 'targets.subtitleDaylight',
      stepIndex: 1,
      stepCount: 4,
      nextView: 'sensor',
    });

    // ------------------------------------------------------------- daylight

    /**
     * The sensor list: every `measure_luminance` device, grouped by room.
     *
     * Grouped rather than flat because a HALL sensor is a legitimate reading for
     * a room with none of its own, and a flat list gives no way to see that.
     * Each row carries its reading and the age of it, because a frozen sensor is
     * indistinguishable from a genuinely constant room by anything else
     * (platform §16) — and half the sensors in one measured house were frozen
     * while Homey reported them available.
     */
    handler('listSensors', async () => {
      const chosen = state.response.sensor;
      // Retained so the readings are real: a sensor nobody is subscribed to has
      // no live value, and the list would show every row as never having
      // reported.
      const all = await this.app.catalog.allDevices();
      const ids = (all as Array<{ id: string; capabilities: string[] }>)
        .filter(device => device.capabilities.includes(LUMINANCE_CAPABILITY))
        .map(device => device.id);
      await this.app.luminance.retain(ids, sessionOwner);

      const payload = await listSensorsPayload(
        this.app.catalog, chosen === null ? [] : [chosen],
      );
      const readings: Map<string, WatchedSensor> = new Map(
        (this.app.daylight.sensors() as WatchedSensor[])
          .map(sensor => [sensor.deviceId, sensor] as const),
      );

      const sky = this.app.daylight.sky();
      return {
        ...payload,
        rooms: (payload.rooms as Array<{ zoneName: string; sensors: any[] }>).map(room => ({
          zoneName: room.zoneName,
          sensors: room.sensors.map(sensor => ({
            ...sensor,
            // The AGE, which is the only thing on screen that can reveal a
            // sensor that has stopped.
            at: readings.get(String(sensor.id))?.at ?? null,
          })),
        })),
        sky,
        sunsetAt: this.sunsetToday(),
      };
    });

    /**
     * Choose the sensor, or the sun.
     *
     * `null` is not a failure state and the screen says so: following the sun is
     * a choice made here, which is why the response screen can say "Following
     * the sun" rather than "no sensor picked" and a home with no sensors at all
     * never sees a warning.
     */
    handler('setSensor', async (payload: unknown) => {
      const asked = payload as { sensor?: unknown } | undefined;
      const wanted = typeof asked?.sensor === 'string' ? asked.sensor : null;

      // MEMBERSHIP, not just shape: a pair session is a Web API surface and can
      // be scripted (platform §14). A lamp id accepted as a sensor is subscribed
      // to, never reports a lux value, and the device runs on the sky for ever
      // while the settings page lists a sensor that will never have a reading.
      const [allowed] = await validateSensorsAgainstCatalog(
        wanted === null ? [] : [wanted], this.app.catalog,
      );
      state.response = { ...state.response, sensor: allowed ?? null };
      await this.app.luminance.retain(allowed ? [allowed] : [], sessionOwner);

      return { sensor: state.response.sensor };
    });

    /**
     * Everything the response screen draws.
     *
     * The sensor's week comes with it rather than on a second round trip: it is
     * the EVIDENCE for the two lux numbers below it, and a screen that drew the
     * thresholds first and the evidence a moment later would be asking for a
     * judgement before showing what to judge it on.
     */
    handler('getResponse', async () => {
      if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));
      const sensor = state.response.sensor;
      const reading = sensor === null
        ? undefined
        : (this.app.daylight.sensors() as WatchedSensor[])
          .find(watched => watched.deviceId === sensor);
      const device = sensor === null ? null : await this.app.catalog.device(sensor);
      const week = sensor === null
        ? null
        : await this.app.luminance.week(sensor, this.timezone() ?? undefined);

      /**
       * Pre-filled from the sensor's OWN week, and only while the two ends are
       * still at their defaults.
       *
       * This is the fix for `brightLux = 500` being a kitchen number: of four
       * sensors measured in one house, only one wanted anything near it
       * (platform §16). Overwriting a value somebody had already set would be a
       * different and much worse behaviour, so the suggestion applies once —
       * and never to thresholds somebody has already had the chance to keep,
       * even when what they kept IS the defaults. See `luxChosen`.
       */
      if (week?.suggestion
        && !state.luxChosen
        && state.response.darkLux === DEFAULT_RESPONSE.darkLux
        && state.response.brightLux === DEFAULT_RESPONSE.brightLux) {
        state.response = {
          ...state.response,
          darkLux: week.suggestion.darkLux,
          brightLux: week.suggestion.brightLux,
        };
      }

      /**
       * When the sensor last said anything, from whichever source knows later:
       * the live subscription can be ahead of Insights, and Insights can know
       * about a sensor this session has only just subscribed to.
       */
      const lastAt = newest(reading?.at ?? null, week?.lastAt ?? null);

      return {
        response: state.response,
        sensorName: device?.name ?? null,
        nowLux: reading?.lux ?? null,
        week,
        /** Half a day of silence, which the week card turns into its error block. */
        staleFor: this.staleHours(lastAt),
        /** "Sat 12:40" — when it last reported, for that block's second line. */
        lastReport: lastAt === null ? null : this.reportedAt(lastAt),
        ...this.elevationTimes(state.response),
        /**
         * Where today's sun is, for the card that replaces the sensor's week
         * when there is no sensor. Only sent on that path: with a sensor it is
         * the week that carries the argument, and this would be a second
         * picture of something the sensor already measures directly.
         */
        sun: sensor === null ? this.sunNow() : null,
      };
    });

    handler('setDaylight', async (payload: unknown) => {
      const result = sanitiseResponse((payload as { response?: unknown })?.response ?? payload);
      for (const field of result.corrected) {
        this.log(`Corrected ${field} to its default: the screen sent something unusable`);
      }
      const [allowed] = await validateSensorsAgainstCatalog(
        result.response.sensor === null ? [] : [result.response.sensor], this.app.catalog,
      );
      result.response.sensor = allowed ?? null;
      state.response = result.response;
      // An edit made with a sensor chosen was made looking at the lux numbers.
      if (state.response.sensor !== null) state.luxChosen = true;

      await this.app.luminance.retain(allowed ? [allowed] : [], sessionOwner);

      return {
        response: state.response,
        corrected: result.corrected,
        now: this.app.daylight.evaluate(state.response),
        ...this.elevationTimes(state.response),
      };
    });

    /**
     * Apply the response to the real lights, before anything is saved.
     *
     * FORCED, so both dampers are bypassed: the deadband and the slew limit
     * exist to stop a closed loop hunting over minutes, and slewing a preview
     * over ninety seconds would read as a button that did nothing.
     */
    handler('previewNow', async () => {
      const runtime = await this.app.daylights.ephemeral(this.buildPlan(state));
      try {
        const outcome = await runtime.applyNow('preview', { force: true, waitForResults: true, preview: true });
        await runtime.drain();
        return outcome;
      } finally {
        await runtime.stop();
      }
    });

    // --------------------------------------------------------------- review

    registerReviewHandler(host, handler, async () => {
      const summary = await resolveSummary(this.app.catalog, state.target!);
      const response = state.response;
      const verdict = this.app.daylight.evaluate(response);
      const sensorName = response.sensor === null
        ? host.translate('review.theSun')
        : (await this.app.catalog.device(response.sensor))?.name
          ?? host.translate('review.missingSensor');

      /**
       * Both ends read as "threshold → brightness", in the unit the screen used.
       *
       * With a sensor that is lux; following the sun it is an angle, and the
       * response screen labels each with the clock time it happens today. The
       * review states the stored value rather than that label, because the label
       * is only true for today and this row outlives it.
       */
      const end = (threshold: string, brightness: number) =>
        `${threshold} → ${Math.round(brightness * 100)}%`;

      const usingSensor = response.sensor !== null;

      /**
       * What the device would do RIGHT NOW, and where the number came from.
       *
       * The one thing on this screen a person can check against the room they
       * are standing in: two thresholds and a response curve are a prediction,
       * and this is the prediction evaluated. It is also the fastest way to
       * catch a response set the wrong way round.
       */
      const hero = {
        kind: 'now' as const,
        percent: `${Math.round(verdict.brightness * 100)}%`,
        detail: host.translate(usingSensor ? 'review.nowFromSensor' : 'review.nowFromSun', {
          lux: Math.round((this.app.daylight.sensors() as WatchedSensor[])
            .find(watched => watched.deviceId === response.sensor)?.lux ?? 0),
          degrees: Math.round(verdict.elevation ?? 0),
          sensor: sensorName,
        }),
      };

      return {
        stepIndex: 4,
        stepCount: 4,
        hero,
        rows: [
          {
            labelKey: 'review.lights',
            value: await this.lightsSummary(state.target!, summary),
            view: 'lights',
          },
          { labelKey: 'review.readsFrom', value: sensorName, view: 'sensor' },
          {
            labelKey: 'review.darkRoom',
            value: end(usingSensor
              ? host.translate('review.underLux', { lux: response.darkLux })
              : host.translate('review.belowDegrees', { degrees: response.darkElevation }),
            response.dark),
            view: 'response',
          },
          {
            labelKey: 'review.brightRoom',
            value: end(usingSensor
              ? host.translate('review.overLux', { lux: response.brightLux })
              : host.translate('review.aboveDegrees', { degrees: response.brightElevation }),
            response.bright),
            view: 'response',
          },
          {
            // What it would do RIGHT NOW. Two thresholds are abstract until the
            // screen says where the room currently sits between them.
            labelKey: 'review.rightNow',
            value: `${Math.round(verdict.brightness * 100)}%`,
          },
        ],
        // Two of the three: a brightness written to an off lamp switches it on,
        // so there is no "set lights before they turn on" to offer here.
        control: await reviewControl(host, state, false),
      };
    });
    registerControlHandlers(handler, state, { offerBefore: false });

    registerSaveHandler(host, handler, state, {
      device,
      idPrefix: 'dayl',
      storeKey: 'daylight',
      naming: { fallback: 'Room-sensing Light', suffix: 'daylight' },
      buildPlan: () => this.buildPlan(state),
    });

    releaseOnDisconnect(host, session, sessionOwner);
  }

  /**
   * What the lights row reads back — and WHICH of the two shapes it stored.
   *
   * "Everything in Kitchen" and "4 picked" behave differently the next time
   * somebody adds a lamp to that room, and this line is the only place that
   * difference is ever visible. `lights.html` deliberately does not show it:
   * making the picker explain its own storage would be a control nobody asked
   * for, on the screen least able to afford one.
   */
  private async lightsSummary(
    target: TargetSpec,
    summary: { count: number },
  ): Promise<string> {
    return lightsSummary(this.pairHost(), target, summary, () => this.app.catalog.allZones());
  }

  /**
   * When the sun sets today, as a clock time — or null where it does not.
   *
   * Shown on the sensor screen beside "The sun", because that option needs to
   * say something concrete about this house rather than being the choice you
   * make by not making one.
   */
  private timezone(): string | null {
    return timezoneOf(this.pairHost());
  }

  private sunsetToday(): string | null {
    const location = usableLocation(this.app.daylight.sky().location);
    if (!location) return null;
    const times = sunTimes(location.latitude, location.longitude, Date.now());
    if (times.sunsetMs === null) return null;
    return formatMinutes(localNow(this.timezone() ?? undefined, times.sunsetMs).minutesOfDay);
  }

  /**
   * The two sun ends, labelled with the clock time they happen at TODAY.
   *
   * "−3°" is not a thing anybody can picture; "around 20:18 today" is. The
   * stored value stays the angle, because an angle is the same all year and a
   * time is not — which is exactly why the label says today.
   *
   * Found by walking the day in ten-minute steps rather than by solving for the
   * elevation: the crossing may not exist at all (a winter day that never
   * reaches the bright end), and a search says so by finding nothing where an
   * inversion would have to invent an answer.
   */
  /**
   * Today's sun, as the three numbers the response screen draws it from.
   *
   * `peak` is the highest the sun gets TODAY rather than a constant, because
   * that is what makes the tick mean anything: 20° in December is most of the
   * day's range and in June it is barely morning, and a scale fixed at the
   * solstice would put every winter reading in the same left-hand inch.
   *
   * Walked in ten-minute steps like `elevationTimes`, and for the same reason —
   * a closed form for "the maximum" exists, and one that also survives a polar
   * day and a Homey that has never been told where it is does not.
   */
  private sunNow(): { elevation: number; peak: number; sunset: string | null; now: string } | null {
    const location = usableLocation(this.app.daylight.sky().location);
    if (!location) return null;

    const timezone = this.timezone() ?? undefined;
    const at = Date.now();
    const minutesOfDay = localNow(timezone, at).minutesOfDay;
    const startOfDay = at - minutesOfDay * 60_000;

    let peak = -90;
    for (let minute = 0; minute < 1440; minute += 10) {
      const elevation = solarElevation(
        location.latitude, location.longitude, startOfDay + minute * 60_000,
      );
      if (elevation > peak) peak = elevation;
    }

    const times = sunTimes(location.latitude, location.longitude, at);
    return {
      elevation: solarElevation(location.latitude, location.longitude, at),
      peak,
      sunset: times.sunsetMs === null ? null : formatMinutes(
        localNow(timezone, times.sunsetMs).minutesOfDay,
      ),
      now: formatMinutes(minutesOfDay),
    };
  }

  private elevationTimes(response: DaylightResponse): { atDark: string | null; atBright: string | null } {
    const location = usableLocation(this.app.daylight.sky().location);
    if (!location) return { atDark: null, atBright: null };

    const timezone = this.timezone() ?? undefined;
    const startOfDay = Date.now() - localNow(timezone, Date.now()).minutesOfDay * 60_000;

    const crossing = (degrees: number, falling: boolean): string | null => {
      let previous: number | null = null;
      for (let minute = 0; minute < 1440; minute += 10) {
        const at = startOfDay + minute * 60_000;
        const elevation = solarElevation(location.latitude, location.longitude, at);
        if (previous !== null) {
          const fell = previous > degrees && elevation <= degrees;
          const rose = previous < degrees && elevation >= degrees;
          if (falling ? fell : rose) return formatMinutes(minute);
        }
        previous = elevation;
      }
      return null;
    };

    return {
      // The dark end is the evening crossing and the bright end the morning one,
      // which is what makes the two labels read as a day rather than as a pair
      // of unrelated times.
      atDark: crossing(response.darkElevation, true),
      atBright: crossing(response.brightElevation, false),
    };
  }

  /**
   * How many hours a sensor has been silent, or null if that is not a worry.
   *
   * The threshold is `SENSOR_STALE_MS`, shared with the runtime's own health
   * leg — see the constant for why it is half a day and why there is only one
   * of it. What is local here is the SHAPE of the answer: whole hours, because
   * that is what the screen's sentence takes.
   */
  private staleHours(at: number | null): number | null {
    if (at === null) return null;
    const elapsed = Date.now() - at;
    return elapsed >= SENSOR_STALE_MS ? Math.floor(elapsed / 3_600_000) : null;
  }

  /**
   * A moment as the week card names it: the grid's own weekday label and a
   * clock time, on the Homey's clock — the same two things the grid's rows and
   * columns are, so the sentence can be checked against the hatched cells.
   */
  private reportedAt(at: number): string {
    const local = localNow(this.timezone() ?? undefined, at);
    const day = WEEKDAY_KEYS[(local.isoWeekday - 1) % 7]!;
    return `${this.homey.__(day)} ${formatMinutes(local.minutesOfDay)}`;
  }

  private buildPlan(state: SessionState): DaylightPlan {
    if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));

    return {
      schemaVersion: CURRENT_DAYLIGHT_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      response: state.response,
      ...writesLightsField(state.writesLights),
    };
  }

};
