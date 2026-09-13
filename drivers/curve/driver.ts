import Homey from 'homey';
import {
  colourSwatch, registerIntroHandler, registerReviewHandler, warmthSwatch,
} from '../../lib/pairing/flow-screens';

import {
  resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import type { LightkeeperApp } from '../../lib/app-contract';
import { valueAt } from '../../lib/circadian/circadian-curve';
import { CURRENT_CURVE_SCHEMA_VERSION } from '../../lib/circadian/curve-migrations';
import {
  DEFAULT_POINTS, MAX_POINTS, MIN_POINTS, sanitiseCurve,
  type CircadianPlan, type CircadianPoint,
} from '../../lib/circadian/circadian-types';
import { FEATURED_COLORS, PALETTE } from '../../lib/circadian/palette';
import { formatMinutes } from '../../lib/time/wall-clock';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  handlerRegistrar,
  registerCurvePreviewHandlers,
  registerSaveHandler,
  registerTargetHandlers,
  timezoneOf,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

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
  target?: TargetSpec;
  points: CircadianPoint[];
  adjustBrightness: boolean;
  preStage: boolean;
}

module.exports = class CurveDriver extends Homey.Driver {

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
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      points: [...DEFAULT_POINTS], adjustBrightness: false, preStage: false, ...initial,
    };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);

    handler('add_device', async () => true);

    // ---------------------------------------------------------------- intro

    registerIntroHandler(host, handler, {
      titleKey: 'intro.curveTitle',
      blurbKey: 'intro.curveBlurb',
      hero: 'curve',
      decisions: [
        { whatKey: 'intro.whichLights', whyKey: 'intro.whichLightsWhy' },
        { whatKey: 'intro.theCurve', whyKey: 'intro.theCurveWhy' },
        { whatKey: 'intro.checkIt', whyKey: 'intro.checkItWhy' },
      ],
      nextView: 'lights',
    });

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, {
      subtitleKey: 'targets.subtitleCurve',
      stepIndex: 1,
      stepCount: 3,
      nextView: 'curve',
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
        /**
         * How many of that list to show before "Show more colours".
         *
         * Sent rather than hardcoded in the view, because the split is a fact
         * about the palette and this is the palette's only consumer. The rest
         * fold out IN PLACE and never onto a second screen: a set is a decision,
         * and a set of twenty-four shown at once is a tuning session.
         */
        featuredColors: FEATURED_COLORS,
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


    // --------------------------------------------------------------- review

    registerReviewHandler(host, handler, async () => {
      const summary = await resolveSummary(this.app.catalog, state.target!);
      const minutes = state.points
        .map(point => (point.anchor.kind === 'clock' ? point.anchor.at : 0))
        .sort((a, b) => a - b);

      /**
       * One bar an hour: colour for the colour, height for the brightness.
       *
       * The same picture the curve screen draws, for the same reason the
       * circadian review carries its day strip — the two rows below say how
       * many points and when, and neither says what the day looks like.
       */
      const bars = Array.from({ length: 24 }, (_, hour) => {
        const at = valueAt(state.points, hour * 60);
        return {
          // `valueAt` has already resolved the palette id to hue and saturation
          // — and to the FLAT hold a segment with one coloured end produces, so
          // the bar shows what the lamps would actually be sent.
          color: at.color ? colourSwatch(at.color) : warmthSwatch(at.warmth),
          height: state.adjustBrightness ? (at.brightness ?? 1) : 1,
        };
      });

      return {
        stepIndex: 3,
        stepCount: 3,
        hero: { kind: 'bars', bars },
        rows: [
          {
            labelKey: 'review.lights',
            value: await this.lightsSummary(state.target!, summary),
            view: 'lights',
          },
          {
            // The count AND the span, because "5" alone does not say whether
            // they are spread across a day or bunched into an hour.
            labelKey: 'review.colourChanges',
            value: `${state.points.length} · ${formatMinutes(minutes[0] ?? 0)}`
              + `–${formatMinutes(minutes[minutes.length - 1] ?? 0)}`,
            view: 'curve',
          },
        ],
        promiseKey: 'review.promiseCurve',
        promiseTokens: { count: summary.count },
      };
    });
    registerCurvePreviewHandlers(host, handler, () => this.buildPlan(state));

    // ----------------------------------------------------------------- save

    registerSaveHandler(host, handler, state, {
      device,
      idPrefix: 'curv',
      storeKey: 'curve',
      naming: { fallback: 'Curve light', suffix: 'curve' },
      buildPlan: () => this.buildPlan(state),
    });

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

  private timezone(): string | null {
    return timezoneOf(this.pairHost());
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
      preStage: state.preStage,
    };
  }

};
