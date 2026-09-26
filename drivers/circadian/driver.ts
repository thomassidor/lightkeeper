import Homey from 'homey';

import {
  resolveSummary, targetDeviceIds, targetLights,
} from '../../lib/pairing/target-picker';
import type { LightkeeperApp } from '../../lib/app-contract';
import { CURRENT_CIRCADIAN_SCHEMA_VERSION } from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_SIMPLE_PLAN, FALLBACK_SUNRISE, FALLBACK_SUNSET, MAX_OFFSET, OFFSET_STEP,
  expandSimplePlan, resolveBoundaries, sanitiseZones, zoneValueAt,
  type CircadianZones, type SimpleCircadianPlan,
} from '../../lib/circadian/simple-curve';
import { formatMinutes } from '../../lib/time/wall-clock';
import { messageOf } from '../../lib/support/homey-errors';
import { localNow } from '../../lib/time/local-clock';
import { sunTimes } from '../../lib/daylight/solar-elevation';
import { usableLocation } from '../../lib/daylight/daylight-types';
import type { AnchorContext, CurveValue } from '../../lib/circadian/circadian-curve';
import type { Transition } from '../../lib/support/interpolate';
import { keepsLightsUpdated, writesLightsField } from '../../lib/runtime/writes-lights';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  lightsSummary, registerIntroHandler, registerReviewHandler, transitionKey, warmthKey, warmthSwatch,
} from '../../lib/pairing/flow-screens';
import { registerControlHandlers, reviewControl } from '../../lib/pairing/control-choice';
import {
  curvePreStageProbe,
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
 * (`SIMPLE_SHAPE`), not a setting: once the times are adjustable this is the
 * Colour Curve Light with fewer fields, and the two device types stop being different
 * products. Somebody who wants their own times, or a colour at a particular hour,
 * adds a Colour Curve Light instead.
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
  /** How each zone blends into the next. See `zoneValueAt`. */
  transition: Transition;
  /** "Set lights before they turn on" — see lib/pairing/control-choice.ts. */
  preStage: boolean;
  /** The lamps the review screen's test proved. Absent = never tested. */
  preStageLights?: string[] | undefined;
  /** This session's test, with names, for the review to draw back. */
  tested?: Array<{ deviceId: string; name: string; ok: boolean }> | undefined;
  /** Keep the lights up to date all day, or only publish. See lib/runtime/writes-lights.ts. */
  writesLights: boolean;
  /**
   * The lamps as they were before this session's first scrub, or absent.
   *
   * Taken ONCE, before the first preview write, and held for the life of the
   * pairing SESSION — which is what this used to say while living on the
   * driver, where it is held for the life of the app. A Homey driver is a
   * singleton, and there is no `disconnect` handler here to clear it: abandon
   * the try-it screen without pressing "Stop preview", open another session,
   * press it there, and `putBack` wrote the PREVIOUS session's lamps back to
   * the previous session's values while leaving this session's lamps scrubbed.
   *
   * Re-taking it on every scrub would snapshot the values the previous scrub
   * wrote, and "Stop preview" would put them back to the last preview — which
   * is not a restore, it is a no-op wearing a restore's name. So: once per
   * session, and a session is what `bindSession` builds.
   */
  restore?: LampSnapshot[] | null;
}

/**
 * What the try-it screen restores, and the only capabilities it touches.
 *
 * `light_mode` is in it because the preview CHANGES it: `planColor` and
 * `planTemperature` each write the mode ahead of the value it enables, so a
 * lamp in colour mode that was shown a warmth comes out of the preview in
 * temperature mode. Restoring its hue without restoring the mode first is
 * sending a value the mode it is in makes it ignore — silently, reported as
 * accepted (platform §6) — which is one of CLAUDE.md's safety properties.
 */
const RESTORABLE = ['dim', 'light_mode', 'light_temperature', 'light_hue', 'light_saturation', 'onoff'];

/**
 * The capabilities each `light_mode` value enables — and so the only colour
 * axis a restore sends, after the mode itself.
 *
 * The other axis is deliberately NOT restored: on a gating lamp it would be
 * ignored, and on the lamps that switch mode on any colour write it would undo
 * the mode that was just put back. Its snapshotted value is invisible while the
 * lamp is in the other mode, which is the state it was found in. The same
 * one-axis rule `restoreLamp` in the circadian runtime applies to the review
 * screen's pre-stage test.
 */
const AXIS_FOR_MODE: Record<string, readonly string[]> = {
  color: ['light_hue', 'light_saturation'],
  temperature: ['light_temperature'],
};

interface LampSnapshot {
  id: string;
  name: string;
  /** Whether it was ON, which is what the screen reports per lamp. */
  on: boolean;
  values: Record<string, unknown>;
}

/**
 * The capabilities a restore writes, in the order it writes them.
 *
 * Brightness, then the mode, then the one axis that mode enables, then the
 * switch. A pure function of the snapshot, so the ORDER — the thing worth
 * proving — is one line to read; `driver-circadian.test.ts` proves it through
 * the try-it handlers, against the writes a fake lamp actually received.
 */
function restoreOrder(values: Record<string, unknown>): string[] {
  const mode = typeof values.light_mode === 'string' ? values.light_mode : null;
  const axes = mode !== null && AXIS_FOR_MODE[mode]
    ? ['light_mode', ...AXIS_FOR_MODE[mode]!]
    // No mode we can read: a one-mode lamp, so every axis it reported.
    : ['light_temperature', 'light_hue', 'light_saturation'];
  return ['dim', ...axes, 'onoff'].filter(capability => capability in values);
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
      transition: plan?.transition ?? DEFAULT_SIMPLE_PLAN.transition,
      preStage: plan?.preStage ?? false,
      preStageLights: plan?.preStageLights,
      // Absent means ON, the opposite of `preStage` above.
      writesLights: plan ? keepsLightsUpdated(plan) : true,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      zones: DEFAULT_SIMPLE_PLAN.zones,
      adjustBrightness: DEFAULT_SIMPLE_PLAN.adjustBrightness,
      transition: DEFAULT_SIMPLE_PLAN.transition,
      preStage: DEFAULT_SIMPLE_PLAN.preStage,
      writesLights: true,
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
      if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));
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
        transition: state.transition,
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
      state.transition = result.transition;

      const bounds = resolveBoundaries(state.zones, this.sunContext());
      return {
        zones: state.zones,
        adjustBrightness: state.adjustBrightness,
        transition: state.transition,
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
    registerControlHandlers(handler, state, {
      offerBefore: true,
      probe: curvePreStageProbe(host, () => expandSimplePlan(this.buildPlan(state))),
    });

    // -------------------------------------------------------------- try it

    /**
     * The day as the try-it screen scrubs through it.
     *
     * SAMPLES of the real engine, every ten minutes against today's sun, not
     * points for the screen to interpolate itself. The screen used to be sent
     * the six points and ease between them with its own copy of the maths; with
     * the zones blended boundary-centred and shaped by the chosen transition
     * (`zoneValueAt`) that copy would be a second engine, and the day screen's
     * copy had already drifted from the first. Ten minutes is finer than the
     * strip draws and the screen reads between samples linearly.
     */
    handler('getPreview', async () => {
      if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));
      const context = this.sunContext();
      const bounds = resolveBoundaries(state.zones, context);

      return {
        points: Array.from({ length: 144 }, (_, i) => ({
          minute: i * 10,
          warmth: this.valueAt(state, context, i * 10).warmth,
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
     * **Every lamp's state is taken before the first write**, so "Stop preview"
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
      if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));
      const minute = Number((payload as { minute?: unknown })?.minute);
      if (!Number.isFinite(minute)) throw new Error(this.homey.__('errors.notATimeOfDay'));

      const context = this.sunContext();
      const value = this.valueAt(state, context, minute);

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

      state.restore ??= await this.snapshot(state.target);
      const snapshot = state.restore;

      const runtime = await this.app.curves.ephemeral(frozen);
      try {
        const outcome = await runtime.applyNow('preview', { force: true, waitForResults: true, preview: true });
        await runtime.drain();

        /**
         * What each lamp was actually SENT, from the runtime's own per-device
         * decisions.
         *
         * This used to report `lamp.on` from the snapshot — whether the lamp was
         * lit BEFORE the preview — under a field the screen renders as "Set" or
         * "Left alone". That is a different fact wearing a write result's name,
         * and it is wrong in both directions: a pre-staged lamp that was off is
         * written to, and a lit lamp the runtime declined is not.
         */
        const commands = new Map(
          (runtime.diagnostics().lastAction?.targets ?? [])
            .map(target => [target.deviceId, target.commands]),
        );
        return {
          ...outcome,
          targets: snapshot.map(lamp => ({
            name: lamp.name,
            written: (commands.get(lamp.id) ?? 0) > 0,
          })),
        };
      } finally {
        await runtime.stop();
      }
    });

    /** Put every lamp back where it was before this session's first scrub. */
    handler('restorePreview', async () => {
      const snapshot = state.restore;
      state.restore = null;
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
      const stops = this.strip(state, this.sunContext()).map((warmth, i) =>
        `${warmthSwatch(warmth)} ${((i / 48) * 100).toFixed(2)}%`);

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
          { labelKey: 'review.transition', value: host.translate(transitionKey(state.transition)), view: 'day' },
        ],
        control: await reviewControl(host, state, true),
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
   * previous scrub wrote, and "Stop preview" would put them back to the last
   * preview — which is not a restore, it is a no-op wearing a restore's name.
   *
   * Only the six capabilities this app ever writes, `light_mode` among them.
   * Reading everything a lamp has would snapshot values nothing is going to
   * change and give the restore more to get wrong.
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
   * `light_mode` AHEAD of the colour axis it enables, and only that axis — see
   * `AXIS_FOR_MODE`. A lamp with no `light_mode` has one mode and cannot gate,
   * so everything it reported is written back as before.
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
        let written = 0;
        for (const capability of restoreOrder(lamp.values)) {
          await device.setCapabilityValue({
            capabilityId: capability, value: lamp.values[capability],
          });
          written += 1;
        }
        // Counted on having WRITTEN something, not on having read the device.
        // `snapshot()` records no values at all for a lamp the catalogue had
        // none for, and those were being reported back as lamps put back —
        // "3 lights restored" for a loop that sent nothing.
        if (written > 0) restored += 1;
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
    return lightsSummary(this.pairHost(), target, summary, () => this.app.catalog.allZones());
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

  /** The real engine at one minute of today, for the screens that draw it. */
  private valueAt(state: SessionState, context: AnchorContext, minute: number): CurveValue {
    return zoneValueAt(state.zones, context, state.adjustBrightness, state.transition, minute);
  }

  /**
   * The day as 49 warmths, midnight to midnight — the review's hero. Computed
   * by the engine. The day screen draws the same strip from its own copy,
   * because it redraws under a finger mid-drag; pair-view-zone-copy.test.ts
   * holds that copy to this.
   */
  private strip(state: SessionState, context: AnchorContext): number[] {
    return Array.from({ length: 49 }, (_, i) => this.valueAt(state, context, (i / 48) * 1440).warmth);
  }

  private buildPlan(state: SessionState): SimpleCircadianPlan {
    if (!state.target) throw new Error(this.homey.__('errors.chooseLightsFirst'));

    return {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      zones: state.zones,
      adjustBrightness: state.adjustBrightness,
      transition: state.transition,
      preStage: state.preStage,
      ...(state.preStageLights !== undefined ? { preStageLights: [...state.preStageLights] } : {}),
      ...writesLightsField(state.writesLights),
    };
  }

};
