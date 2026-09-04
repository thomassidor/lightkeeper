import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import { validateTargetAgainstCatalog } from '../../lib/validation/pairing-dto';
import Homey from 'homey';
import { randomUUID } from 'node:crypto';

import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { deriveSuffixedName } from '../../lib/pairing/derive-name';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse, type DaylightResponse,
} from '../../lib/daylight/daylight-types';
import { CURRENT_SCHEDULE_SCHEMA_VERSION } from '../../lib/schedules/schedule-migrations';
import {
  MAX_ENTRIES, sanitiseEntries,
  type ScheduleBoundary, type ScheduleEntry, type SchedulePlan,
} from '../../lib/schedules/schedule-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { flowWriteProbe } from '../../lib/credential-service';
import { messageOf } from '../../lib/support/homey-errors';

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

    // The targets view is ONE file shared by all four drivers (platform §8), so the
    // line telling the user which lights these are has to be supplied per driver.
    // Resolved here rather than in `lib/`, which cannot translate.
    handler('listTargets', async () => ({
      ...await listTargetsPayload(this.app.catalog, state.target),
      subtitle: this.homey.__('targets.subtitleSchedule'),
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
          data: { id: mintDeviceId('sched') },
          store: { schedule: plan },
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
