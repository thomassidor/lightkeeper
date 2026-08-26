import Homey from 'homey';

import {
  listTargetsPayload, resolveSummary, targetLights,
} from '../../lib/pairing/target-picker';
import { CURRENT_SCHEDULE_SCHEMA_VERSION } from '../../lib/schedules/schedule-migrations';
import {
  MAX_ENTRIES, sanitiseEntries,
  type ScheduleBoundary, type ScheduleEntry, type SchedulePlan,
} from '../../lib/schedules/schedule-types';
import type { TargetSpec } from '../../lib/outputs/light-intent';

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
          this.error(`pair/${name} failed:`, (error as Error)?.message, (error as Error)?.stack);
          throw error;
        }
      });
    };

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
      return this.app.credentials.setCredential(token, async (client: any) => {
        const folder = await client.flow.createFlowFolder({
          flowfolder: { name: 'Lightkeeper (checking permissions)' },
        });
        await client.flow.deleteFlowFolder({ id: folder.id });
      });
    });

    handler('add_device', async () => true);

    // -------------------------------------------------------------- targets

    handler('listTargets', async () => listTargetsPayload(this.app.catalog, state.target));

    handler('selectTargets', async (spec: TargetSpec) => {
      state.target = spec;
      return resolveSummary(this.app.catalog, spec);
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
          data: { id: `lk-sched-${Date.now()}-${Math.round(Math.random() * 1e6)}` },
          store: { schedule: plan },
        },
      };
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
    if (!state.target) return 'Light schedule';

    if (state.target.kind === 'zone') {
      const zones = await this.app.catalog.allZones();
      const zone = zones.find((z: any) => z.id === (state.target as any).zoneId);
      return `${zone?.name ?? 'Zone'} schedule`;
    }

    const lights = await targetLights(this.app.catalog, state.target);
    if (lights.length === 0) return 'Light schedule';
    if (lights.length === 1) return `${lights[0].name} schedule`;

    // Where every light shares a room, the room reads better than a list.
    const zoneNames = new Set(lights.map(l => l.zoneName).filter(Boolean));
    if (zoneNames.size === 1) return `${[...zoneNames][0]} schedule`;

    return `${lights.length} lights schedule`;
  }

  private buildPlan(state: SessionState): SchedulePlan {
    if (!state.target) throw new Error('Choose some lights first.');
    if (state.entries.length === 0) throw new Error('Add at least one schedule.');

    return {
      schemaVersion: CURRENT_SCHEDULE_SCHEMA_VERSION,
      enabled: true,
      target: state.target,
      entries: state.entries,
      managedFlows: [],
    };
  }

};
