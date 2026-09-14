import Homey from 'homey';

import {
  resolveSummary, targetDeviceIds, targetLights,
} from '../../lib/pairing/target-picker';
import type { LightkeeperApp } from '../../lib/app-contract';
import { CURRENT_CIRCADIAN_SCHEMA_VERSION } from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_SIMPLE_PLAN, FALLBACK_SUNRISE, FALLBACK_SUNSET, MAX_OFFSET, OFFSET_STEP,
  expandSimplePlan, resolveBoundaries, sanitiseZones, zonePoints,
  type CircadianZones, type SimpleCircadianPlan,
} from '../../lib/circadian/simple-curve';
import { formatMinutes } from '../../lib/time/wall-clock';
import { resolvePoints, valueAt } from '../../lib/circadian/circadian-curve';
import { messageOf } from '../../lib/support/homey-errors';
import { localNow } from '../../lib/time/local-clock';
import { sunTimes } from '../../lib/daylight/solar-elevation';
import { usableLocation } from '../../lib/daylight/daylight-types';
import type { AnchorContext } from '../../lib/circadian/circadian-curve';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  registerIntroHandler, registerReviewHandler, warmthKey, warmthSwatch,
} from '../../lib/pairing/flow-screens';
import {
  handlerRegistrar,
  registerCurvePreviewHandlers,
  registerSaveHandler,
  registerTargetHandlers,
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
  target?: TargetSpec;
  zones: CircadianZones;
  adjustBrightness: boolean;
  preStage: boolean;
}

/** What the try-it screen restores, and the only capabilities it touches. */
const RESTORABLE = ['dim', 'light_temperature', 'light_hue', 'light_saturation', 'onoff'];

interface LampSnapshot {
  id: string;
  name: string;
  /** Whether it was ON, which is what the screen reports per lamp. */
  on: boolean;
  values: Record<string, unknown>;
}

module.exports = class CircadianDriver extends Homey.Driver {

  /**
   * The lamps as they were before the first scrub, or null.
   *
   * On the DRIVER rather than in the session state because it is not part of
   * the plan being built — it is a debt the screen incurs against the real room,
   * and it outlives any one handler call.
   */
  private restore: LampSnapshot[] | null = null;


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
    this.log('Circadian driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, {});
  }

  override async onRepair(session: any, device: any) {
    const plan: SimpleCircadianPlan = device.getStoreValue('circadian');
    await this.bindSession(session, {
      target: plan?.target,
      zones: plan?.zones ?? DEFAULT_SIMPLE_PLAN.zones,
      adjustBrightness: plan?.adjustBrightness ?? false,
      preStage: plan?.preStage ?? false,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      zones: DEFAULT_SIMPLE_PLAN.zones,
      adjustBrightness: DEFAULT_SIMPLE_PLAN.adjustBrightness,
      preStage: DEFAULT_SIMPLE_PLAN.preStage,
      ...initial,
    };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);

    handler('add_device', async () => true);

    // ---------------------------------------------------------------- intro

    registerIntroHandler(host, handler, {
      titleKey: 'intro.circadianTitle',
      blurbKey: 'intro.circadianBlurb',
      hero: 'day',
      decisions: [
        { whatKey: 'intro.whichLights', whyKey: 'intro.whichLightsWhy' },
        { whatKey: 'intro.theDay', whyKey: 'intro.theDayWhy' },
        { whatKey: 'intro.checkIt', whyKey: 'intro.checkItWhy' },
      ],
      nextView: 'lights',
    });

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, {
      subtitleKey: 'targets.subtitleCircadian',
      stepIndex: 1,
      stepCount: 3,
      nextView: 'day',
    });

    // ---------------------------------------------------------------- zones

    /**
     * Everything the day screen draws, in one reply.
     *
     * The boundaries are sent RESOLVED as well as stored. The screen shows a day
     * strip with sunrise and sunset marked on it and a handle sitting at
     * "sunrise +30m", and it cannot place either without knowing what time
     * sunrise is today — so the minutes come from here rather than from a second
     * round trip, and they come from the same `resolveBoundaries` the runtime
     * uses, clamps included. A screen that drew an unclamped handle would put it
     * somewhere the device will not actually go.
     */
    handler('getDay', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const [summary, lights] = await Promise.all([
        resolveSummary(this.app.catalog, state.target),
        targetLights(this.app.catalog, state.target),
      ]);

      const sun = this.sunContext();
      const bounds = resolveBoundaries(state.zones, sun);

      return {
        // Which controls to offer at all: brightness is hidden rather than
        // shown-and-ignored when nothing selected supports it.
        support: summary.support,
        lights,
        zones: state.zones,
        adjustBrightness: state.adjustBrightness,
        preStage: state.preStage,
        /** Today's sun, or nulls where there is none to anchor to. */
        sun: {
          sunriseMinute: sun.sunriseMinute ?? null,
          sunsetMinute: sun.sunsetMinute ?? null,
        },
        /** Where the two boundaries actually fall today, after clamping. */
        boundaries: {
          morningEndMinute: bounds.morningEndMinute,
          morningEnd: formatMinutes(bounds.morningEndMinute),
          eveningStartMinute: bounds.eveningStartMinute,
          eveningStart: formatMinutes(bounds.eveningStartMinute),
          /** False when there was no sunrise and the fixed hours were used. */
          fromSun: bounds.fromSun,
        },
        nextView: 'review',
        limits: {
          maxOffset: MAX_OFFSET,
          offsetStep: OFFSET_STEP,
          /**
           * The hours used when there is no sun to anchor to.
           *
           * Sent so the screen can NAME them rather than drawing a strip with no
           * sunrise on it and leaving the user to work out why. A Homey that has
           * never been told where it is, and a latitude inside a polar day, both
           * land here — and `fromSun: false` above is what says which case the
           * user is looking at.
           */
          fallbackSunrise: FALLBACK_SUNRISE,
          fallbackSunset: FALLBACK_SUNSET,
        },
        // Shown on screen, because "warm at 21:00" is meaningless without saying
        // whose 21:00 — and a Homey in the wrong timezone is a real support case.
        timezone: this.timezone(),
      };
    });

    /**
     * Replace all three zones at once, like the curve's `setCurve` and the
     * schedule's `setSchedules`. Everything arriving here is untrusted — it comes
     * from a webview — so it goes through `sanitiseZones`, which falls back per
     * FIELD and reports which fields it had to correct.
     *
     * Falling back rather than dropping, unlike the curve's sanitiser, because
     * there is nothing droppable: three zones are not a list, and a device with
     * two of them is not a degraded device — it is a device with no curve at all.
     */
    handler('setDay', async (payload: unknown) => {
      const result = sanitiseZones(payload);
      for (const field of result.corrected) {
        this.log(`Corrected ${field} to its default: the screen sent something unusable`);
      }
      state.zones = result.zones;
      state.adjustBrightness = result.adjustBrightness;
      state.preStage = (payload as { preStage?: unknown })?.preStage === true;

      const bounds = resolveBoundaries(state.zones, this.sunContext());
      return {
        zones: state.zones,
        adjustBrightness: state.adjustBrightness,
        corrected: result.corrected,
        // Echoed back so a handle the clamp moved snaps visibly rather than
        // sitting where the user dropped it and behaving as if it were elsewhere.
        boundaries: {
          morningEndMinute: bounds.morningEndMinute,
          morningEnd: formatMinutes(bounds.morningEndMinute),
          eveningStartMinute: bounds.eveningStartMinute,
          eveningStart: formatMinutes(bounds.eveningStartMinute),
          fromSun: bounds.fromSun,
        },
      };
    });

    registerCurvePreviewHandlers(host, handler, () => expandSimplePlan(this.buildPlan(state)));

    // -------------------------------------------------------------- try it

    /**
     * The day as the try-it screen scrubs through it.
     *
     * The RESOLVED points, against today's sun — the same six the runtime would
     * evaluate — so what the screen draws and what the device will do are one
     * curve rather than two that happen to agree today.
     */
    handler('getPreview', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const context = this.sunContext();
      const points = zonePoints(state.zones, context, state.adjustBrightness);
      const bounds = resolveBoundaries(state.zones, context);

      return {
        points: resolvePoints(points, context).map(point => ({
          minute: point.minute,
          warmth: point.warmth,
        })),
        /**
         * Where the two boundaries fall today, so the screen can name the ZONE
         * a scrubbed minute is in.
         *
         * "Evening · warm" says which of the three the user is looking at;
         * "Deep amber" alone says only what colour it happens to be, which is
         * the one thing the strip under it is already showing.
         */
        boundaries: {
          morningEndMinute: bounds.morningEndMinute,
          eveningStartMinute: bounds.eveningStartMinute,
        },
        nowMinute: localNow(this.timezone() ?? undefined, Date.now()).minutesOfDay,
      };
    });

    /**
     * Show one minute of the day on the real lamps.
     *
     * **Every lamp's state is taken before the first write**, so "Put them back"
     * can be a promise rather than a hope. That is what makes scrubbing safe to
     * offer at all, and it is why this is the primary action on that screen
     * while Save is not.
     *
     * The plan handed to the ephemeral runtime has its zones replaced by a
     * single flat pair at the scrubbed value: the runtime evaluates the curve at
     * the CURRENT minute and there is no way to ask it for another one, so the
     * honest way to show 19:40 at 10:04 is to build a curve that says 19:40
     * everywhere.
     */
    handler('previewAt', async (payload: unknown) => {
      if (!state.target) throw new Error('Choose some lights first.');
      const minute = Number((payload as { minute?: unknown })?.minute);
      if (!Number.isFinite(minute)) throw new Error('That is not a time of day.');

      const context = this.sunContext();
      const value = valueAt(zonePoints(state.zones, context, state.adjustBrightness), minute);

      const flat = expandSimplePlan(this.buildPlan(state));
      const frozen = {
        ...flat,
        zones: undefined,
        points: [
          { id: 'a', anchor: { kind: 'clock' as const, at: 0 }, warmth: value.warmth,
            ...(value.brightness !== undefined ? { brightness: value.brightness } : {}) },
          { id: 'b', anchor: { kind: 'clock' as const, at: 720 }, warmth: value.warmth,
            ...(value.brightness !== undefined ? { brightness: value.brightness } : {}) },
        ],
      };

      if (!this.restore) this.restore = await this.snapshot(state.target);

      const runtime = await this.app.curves.ephemeral(frozen);
      try {
        const outcome = await runtime.applyNow('preview', { force: true, waitForResults: true });
        await runtime.drain();
        return { ...outcome, targets: this.restore.map(lamp => ({ name: lamp.name, written: lamp.on })) };
      } finally {
        await runtime.stop();
      }
    });

    /** Put every lamp back where it was before the first scrub. */
    handler('restorePreview', async () => {
      const snapshot = this.restore;
      this.restore = null;
      if (!snapshot) return { restored: 0 };
      return { restored: await this.putBack(snapshot) };
    });

    // --------------------------------------------------------------- review

    registerReviewHandler(host, handler, async () => {
      const summary = await resolveSummary(this.app.catalog, state.target!);
      const bounds = resolveBoundaries(state.zones, this.sunContext());

      /**
       * Each zone's readback, in the words the day screen used.
       *
       * The warmth as a NAME rather than a number, because "Soft warm" is what
       * the slider said and 0.62 is not — and the brightness beside it only when
       * the user switched brightness on, so a device that only changes colour
       * does not read as one that also dims.
       */
      const zone = (key: 'morning' | 'midday' | 'evening') => {
        const warmth = host.translate(warmthKey(state.zones[key].temperature));
        if (!state.adjustBrightness) return warmth;
        const percent = Math.round((state.zones[key].brightness ?? 0) * 100);
        return `${warmth} · ${percent}%`;
      };

      /**
       * The day, as the band of colour the day screen drew.
       *
       * Four rows of words above a sentence do not add up to a picture of a
       * day, and this device's whole proposition is what that day looks like —
       * so the last screen before "Add device" shows it rather than describing
       * it. Forty-nine stops is the same sampling the day screen uses.
       */
      const points = zonePoints(state.zones, this.sunContext(), state.adjustBrightness);
      const stops = Array.from({ length: 49 }, (_, i) => {
        const percent = (i / 48) * 100;
        return `${warmthSwatch(valueAt(points, (i / 48) * 1440).warmth)} ${percent.toFixed(2)}%`;
      });

      return {
        stepIndex: 3,
        stepCount: 3,
        hero: { kind: 'strip', stops },
        rows: [
          { labelKey: 'review.lights', value: await this.lightsSummary(state.target!, summary), view: 'lights' },
          { labelKey: 'review.morning', value: zone('morning'), view: 'day' },
          { labelKey: 'review.midday', value: zone('midday'), view: 'day' },
          { labelKey: 'review.evening', value: zone('evening'), view: 'day' },
          {
            // Where the two boundaries actually fall today, and whether they
            // came from the sun at all. A device on the fixed-hours fallback
            // looks identical here otherwise.
            labelKey: bounds.fromSun ? 'review.followsSun' : 'review.fixedHours',
            value: `${formatMinutes(bounds.morningEndMinute)} – ${formatMinutes(bounds.eveningStartMinute)}`,
            view: 'day',
          },
        ],
        promiseKey: 'review.promiseCircadian',
        promiseTokens: { count: summary.count },
      };
    });

    // ----------------------------------------------------------------- save

    registerSaveHandler(host, handler, state, {
      device,
      idPrefix: 'circ',
      storeKey: 'circadian',
      naming: { fallback: 'Circadian light', suffix: 'circadian' },
      buildPlan: () => this.buildPlan(state),
    });

  }

  /**
   * What the lamps were before the first scrub, so they can be put back.
   *
   * Taken ONCE, before the first preview write, and held for the life of the
   * pairing session. Re-taking it on every scrub would snapshot the values the
   * previous scrub wrote, and "Put them back" would put them back to the last
   * preview — which is not a restore, it is a no-op wearing a restore's name.
   *
   * Only the five capabilities this app ever writes. Reading everything a lamp
   * has would snapshot values nothing is going to change and give the restore
   * more to get wrong.
   */
  private async snapshot(target: TargetSpec): Promise<LampSnapshot[]> {
    const ids = await targetDeviceIds(this.app.catalog, target);
    const snapshot: LampSnapshot[] = [];

    for (const id of ids) {
      const device = await this.app.catalog.device(id);
      if (!device) continue;
      const values: Record<string, unknown> = {};
      for (const capability of RESTORABLE) {
        const reported = device.capabilitiesObj?.[capability];
        if (reported && reported.value !== undefined && reported.value !== null) {
          values[capability] = reported.value;
        }
      }
      snapshot.push({ id, name: device.name, on: device.capabilitiesObj?.onoff?.value === true, values });
    }
    return snapshot;
  }

  /**
   * Put every lamp back, and count how many took it.
   *
   * `onoff` LAST, and that ordering is the whole of what makes this work: a
   * `dim` write turns an off lamp on (measured, platform §6), so restoring a
   * lamp that was off by writing its brightness first would leave it lit at the
   * value it had before somebody switched it off.
   *
   * A lamp that refuses is logged and skipped rather than failing the restore:
   * the other lamps in the room still want putting back.
   */
  private async putBack(snapshot: LampSnapshot[]): Promise<number> {
    const api = await this.app.api.read();
    let restored = 0;

    for (const lamp of snapshot) {
      try {
        const device = await api.devices.getDevice({ id: lamp.id });
        for (const capability of RESTORABLE) {
          if (capability === 'onoff') continue;
          if (!(capability in lamp.values)) continue;
          await device.setCapabilityValue({
            capabilityId: capability, value: lamp.values[capability],
          });
        }
        if ('onoff' in lamp.values) {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: lamp.values.onoff });
        }
        restored += 1;
      } catch (error) {
        this.error(`Could not put ${lamp.name} back:`, messageOf(error));
      }
    }
    return restored;
  }

  private timezone(): string | null {
    return timezoneOf(this.pairHost());
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
    const host = this.pairHost();
    if (target.kind === 'zone') {
      const zones = await this.app.catalog.allZones();
      const zone = zones.find((candidate: { id: string }) => candidate.id === target.zoneId);
      return host.translate('review.wholeRoom', { room: zone?.name ?? '?' });
    }
    return host.translate('review.someLights', { count: summary.count });
  }

  /**
   * Today's sunrise and sunset as minutes of the local day, or nothing.
   *
   * The pairing screen's copy of what `CircadianRuntime.sunContext` computes,
   * and it has to be its own because there is no runtime yet — the device being
   * paired does not exist. An empty context is not a failure: `resolveBoundaries`
   * falls back to fixed hours, and the screen is told so by `fromSun` and says
   * it in words rather than drawing a sunrise that is not there.
   */
  private sunContext(): AnchorContext {
    const location = usableLocation(this.app.daylight.sky().location);
    if (!location) return {};

    const now = Date.now();
    const times = sunTimes(location.latitude, location.longitude, now);
    if (times.sunriseMs === null || times.sunsetMs === null) return {};

    const timezone = this.timezone() ?? undefined;
    return {
      sunriseMinute: localNow(timezone, times.sunriseMs).minutesOfDay,
      sunsetMinute: localNow(timezone, times.sunsetMs).minutesOfDay,
    };
  }

  private buildPlan(state: SessionState): SimpleCircadianPlan {
    if (!state.target) throw new Error('Choose some lights first.');

    return {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      zones: state.zones,
      adjustBrightness: state.adjustBrightness,
      preStage: state.preStage,
    };
  }

};
