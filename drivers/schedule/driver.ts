import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import Homey from 'homey';

import {
  resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import {
  sanitiseResponse, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { CURRENT_SCHEDULE_SCHEMA_VERSION } from '../../lib/schedules/schedule-migrations';
import {
  MAX_ENTRIES, sanitiseEntries,
  type ScheduleBoundary, type ScheduleEntry, type SchedulePlan,
} from '../../lib/schedules/schedule-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { flowWriteProbe } from '../../lib/credential-service';
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
  daylight?: DaylightResponse;
  target?: TargetSpec;
  entries: ScheduleEntry[];
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
      translate: (key: string) => this.homey.__(key),
      clock: this.homey.clock,
      app: this.app,
    };
  }

  private get app(): any {
    return this.homey.app;
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
      daylight: plan?.daylight,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = { entries: [], ...initial };

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);
    const sessionOwner = newSessionOwner();

    // ---------------------------------------------------------- credentials

    handler('getCredentialStatus', async () => ({
      ...this.app.credentials.getStatus(),
      // The credential view is shared byte-for-byte between drivers, so it
      // cannot know what follows it. The driver does.
      nextView: 'targets',
    }));

    handler('setCredential', async (token: string) => {
      // Validating with a READ is not enough: reads succeed on credentials that
      // cannot write. Prove a write, then immediately clean it up.
      return this.app.credentials.setCredential(
        token,
        (client: any) => flowWriteProbe(client, (...args: unknown[]) => this.log(...args)),
      );
    });

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    registerTargetHandlers(host, handler, state, 'targets.subtitleSchedule');

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
      const { entries, dropped } = sanitiseEntries(raw);
      for (const drop of dropped) {
        this.log(`Dropped schedule ${drop.index + 1}: ${drop.reason}`);
      }
      state.entries = entries;
      return { count: entries.length, dropped };
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
          data: { id: mintDeviceId('sched') },
          store: { schedule: plan },
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
      fallback: 'Light schedule', suffix: 'schedule', zoneFallback: 'Zone',
    });
  }

  private buildPlan(state: SessionState): SchedulePlan {
    if (!state.target) throw new Error('Choose some lights first.');
    if (state.entries.length === 0) throw new Error('Add at least one schedule.');

    return {
      schemaVersion: CURRENT_SCHEDULE_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      entries: state.entries,
      // Absent stays absent: `undefined` is "this device has no response", and
      // the validator refuses a window that follows the daylight without one.
      ...(state.daylight !== undefined ? { daylight: state.daylight } : {}),
      managedFlows: [],
    };
  }

};
