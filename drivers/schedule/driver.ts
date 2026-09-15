import Homey from 'homey';
import type { LightkeeperApp } from '../../lib/app-contract';
import { registerIntroHandler, registerReviewHandler } from '../../lib/pairing/flow-screens';

import {
  resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { CURRENT_SCHEDULE_SCHEMA_VERSION } from '../../lib/schedules/schedule-migrations';
import { daysLabel } from '../../lib/schedules/schedule-bindings';
import {
  MAX_ENTRIES, overlappingPairs, sanitiseEntries, sanitiseScheduleDays,
  type IsoWeekday,
  type ScheduleBoundary, type ScheduleEntry, type SchedulePlan,
} from '../../lib/schedules/schedule-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import {
  handlerRegistrar,
  registerCredentialHandlers,
  registerSaveHandler,
  registerTargetHandlers,
  timezoneOf,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

/**
 * The schedule driver owns: pair/repair session handlers, the data its two
 * screens need, and virtual device creation.
 *
 * Three views, the first two shared byte-for-byte with the remote controller
 * (the API key, then the light picker), because a schedule writes Flows for the
 * same reason a controller does and picks lights from the same catalogue. Only
 * the third screen is its own. The same views serve pairing and repair; repair
 * arrives with the existing values already selected.
 */

interface SessionState {
  target?: TargetSpec;
  entries: ScheduleEntry[];
  days: IsoWeekday[] | null;
}

module.exports = class ScheduleDriver extends Homey.Driver {

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
    this.log('Schedule driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, { entries: [] });
  }

  override async onRepair(session: any, device: any) {
    const plan: SchedulePlan = device.getStoreValue('schedule');
    await this.bindSession(session, {
      target: plan?.target,
      entries: plan?.entries ?? [],
      // Seeded so a repair session opens the card on what the device already
      // has rather than on the defaults.
      days: plan?.days ?? null,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = { entries: [], days: null, ...initial };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);

    // ---------------------------------------------------------- credentials

    // The view id the credential screen jumps to, which is this driver's step 1
    // — not the controller's. 'targets' was that view's id before the pairing
    // rewrite renamed it, and a showView() naming a view that no longer exists
    // renders an EMPTY screen rather than failing: intro -> credential -> blank,
    // for every household that already had a key stored.
    registerCredentialHandlers(host, handler, 'lights');

    handler('add_device', async () => true);

    // ---------------------------------------------------------------- intro

    registerIntroHandler(host, handler, {
      titleKey: 'intro.scheduleTitle',
      blurbKey: 'intro.scheduleBlurb',
      hero: 'schedule',
      decisions: [
        { whatKey: 'intro.whichLights', whyKey: 'intro.whichLightsWhy' },
        { whatKey: 'intro.theBlocks', whyKey: 'intro.theBlocksWhy' },
        { whatKey: 'intro.checkIt', whyKey: 'intro.checkItWhy' },
      ],
      // The key screen, when it is needed at all. It skips itself when a valid
      // key is already stored, so every schedule after the first goes straight
      // to the lights.
      nextView: 'credential',
    });

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, {
      subtitleKey: 'targets.subtitleSchedule',
      stepIndex: 1,
      stepCount: 3,
      nextView: 'blocks',
    });

    // ------------------------------------------------------------ schedules

    handler('getSchedule', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const [summary, lights] = await Promise.all([
        resolveSummary(this.app.catalog, state.target),
        targetLights(this.app.catalog, state.target),
      ]);

      return {
        maxEntries: MAX_ENTRIES,
        // Which controls to offer at all: brightness and warmth are hidden
        // rather than shown-and-ignored when nothing selected supports them.
        support: summary.support,
        lights,
        entries: state.entries,
        days: state.days,
        // Which windows fight, so the screen can draw the region and say the
        // later one wins. Reported, never enforced: the runtime has a
        // deterministic answer and refusing to save was the worse surprise.
        overlaps: overlappingPairs(state.entries, state.days),
        // Shown on screen, because "on at 22:00" is meaningless without saying
        // whose 22:00 — and a Homey in the wrong timezone is a real support case.
        timezone: this.timezone(),
      };
    });

    /**
     * Replace the whole set, like the controller's setRules: simpler and less
     * racy than per-row edits, and the list is at most twelve long.
     *
     * Everything arriving here is untrusted — it comes from a webview — so it goes
     * through sanitiseEntries(), which DROPS an invalid row and says why rather
     * than repairing it into a schedule the user never asked for.
     */
    handler('setSchedules', async (raw: unknown) => {
      const payload = (raw && typeof raw === 'object' && 'entries' in raw
        ? raw
        : { entries: raw }) as { entries?: unknown; days?: unknown };

      const { entries, dropped } = sanitiseEntries(payload.entries);
      for (const drop of dropped) {
        this.log(`Dropped schedule ${drop.index + 1}: ${drop.reason}`);
      }
      state.entries = entries;
      // One day set for the whole schedule. Sent with the rows rather than on
      // its own handler because the two are edited on one screen and a partial
      // save — new rows against the old days — is a schedule nobody asked for.
      if (payload.days !== undefined) state.days = sanitiseScheduleDays(payload.days);

      return {
        count: entries.length,
        dropped,
        days: state.days,
        overlaps: overlappingPairs(entries, state.days),
      };
    });

    /**
     * Test control — applies one end of one schedule immediately, against the
     * real lights, before anything is saved and before any Flow exists. The
     * primary defence against a schedule that looks configured and does nothing.
     */
    handler('test', async ({ entryId, boundary }: { entryId: string; boundary: ScheduleBoundary }) => {
      if (!state.target) throw new Error('Choose some lights first.');
      const runtime = await this.app.schedules.ephemeral(this.buildPlan(state));
      try {
        return await runtime.testEntry(entryId, boundary === 'off' ? 'off' : 'on');
      } finally {
        await runtime.stop();
      }
    });

    // ----------------------------------------------------------------- save

    // --------------------------------------------------------------- review

    registerReviewHandler(host, handler, async () => {
      const summary = await resolveSummary(this.app.catalog, state.target!);
      return {
        stepIndex: 3,
        stepCount: 3,
        rows: [
          {
            labelKey: 'review.lights',
            value: await this.lightsSummary(state.target!, summary),
            view: 'lights',
          },
          {
            labelKey: 'review.timeBlocks',
            value: String(state.entries.length),
            view: 'blocks',
          },
          {
            labelKey: 'review.onTheseDays',
            value: daysLabel(state.days),
            view: 'blocks',
          },
        ],
        promiseKey: 'review.promiseSchedule',
        promiseTokens: { count: summary.count },
      };
    });

    registerSaveHandler(host, handler, state, {
      device,
      idPrefix: 'sched',
      storeKey: 'schedule',
      naming: { fallback: 'Light schedule', suffix: 'schedule' },
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

  private buildPlan(state: SessionState): SchedulePlan {
    if (!state.target) throw new Error('Choose some lights first.');
    if (state.entries.length === 0) throw new Error('Add at least one schedule.');

    return {
      schemaVersion: CURRENT_SCHEDULE_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      entries: state.entries,
      days: state.days,
      managedFlows: [],
    };
  }

};
