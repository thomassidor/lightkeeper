import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import Homey from 'homey';

import { DEFAULT_BEHAVIOR, FUNCTION_CAPABILITY, type LightFunction, type MappingRule } from '../../lib/mapping/mapping-types';
import {
  CURRENT_SCHEMA_VERSION, dedupeByInputKey, type ControllerProfile,
} from '../../lib/profiles/controller-profile';
import { validateMappingRules, validateTargetAgainstCatalog } from '../../lib/validation/pairing-dto';
import { availableFunctions } from '../../lib/mapping/mapping-engine';
import { groupByControl, type SelectableInput } from '../../lib/inputs/selectable-input';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { flowWriteProbe } from '../../lib/credential-service';
import { findUncompilableBindings } from '../../lib/bridge/flow-binding-compiler';
import {
  listTargetsPayload, resolveSummary, targetDeviceIds, targetLights,
} from '../../lib/pairing/target-picker';
import { groupSourcesByRoom } from '../../lib/pairing/source-list';
import { mappingGroups, mappingRuleRows, ruleTargetFor } from '../../lib/pairing/mapping-screen';
import { deriveControllerName } from '../../lib/pairing/derive-name';

/**
 * The Driver owns: pair/repair session handlers, UI data
 * endpoints and virtual device creation. Flow-card discovery algorithms and
 * scheduler internals stay out.
 *
 * The same three screens serve both pairing and repair; repair pre-selects the
 * existing values.
 */

interface SessionState {
  sourceDeviceId?: string;
  sourceDriverId?: string;
  sourceOwnerUri?: string;
  sourceName?: string;
  target?: TargetSpec;
  catalogue: SelectableInput[];
  fingerprint?: string;
  fingerprintV2?: string;
  mappings: MappingRule[];
  /** Set during repair. */
  existingDeviceId?: string;
}

module.exports = class ControllerDriver extends Homey.Driver {

  private get app(): any {
    return this.homey.app;
  }

  override async onInit() {
    this.log('Controller driver initialised');
  }

  override async onPair(session: any) {
    await this.bindSession(session, {});
  }

  override async onRepair(session: any, device: any) {
    const profile: ControllerProfile = device.getStoreValue('profile');
    await this.bindSession(session, {
      sourceDeviceId: profile?.source?.deviceId,
      sourceDriverId: profile?.source?.driverId,
      sourceOwnerUri: profile?.source?.ownerAppId,
      sourceName: profile?.source?.name,
      fingerprint: profile?.source?.eventSurfaceFingerprint,
      fingerprintV2: profile?.source?.eventSurfaceFingerprintV2,
      target: profile?.target,
      catalogue: profile?.catalogue ?? [],
      mappings: profile?.mappings ?? [],
      existingDeviceId: device.getData().id,
    }, device);
  }

  private async bindSession(session: any, initial: Partial<SessionState>, device?: any) {
    const state: SessionState = {
      catalogue: [],
      mappings: [],
      ...initial,
    };

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
      nextView: 'source',
    }));

    handler('setCredential', async (token: string) => {
      // Validating with a READ is not enough: reads succeed on credentials that
      // cannot write. Prove a write, then immediately clean it up.
      return this.app.credentials.setCredential(
        token,
        (client: any) => flowWriteProbe(client, (...args: unknown[]) => this.log(...args)),
      );
    });

    // The pairing view must emit 'add_device' after createDevice for the
    // device to actually be created — createDevice alone only stages it.
    // Some SDK builds handle this internally; having a handler makes the
    // explicit emit harmless either way.
    handler('add_device', async () => true);

    // ------------------------------------------------------- one-tap re-attach

    /**
     * Offered at the top of repair. On BILRESA, cards vanish after a
     * restart and the device must be re-added; making the user redo the whole
     * mapping every time would defeat the product.
     */
    handler('checkReattach', async () => {
      if (!device) return null;
      const profile: ControllerProfile = device.getStoreValue('profile');
      if (!profile) return null;

      const candidate = await this.app.health.findReattachCandidate(profile);
      if (!candidate) return null;

      return { ...candidate, currentName: profile.source.name ?? 'the previous remote' };
    });

    handler('applyReattach', async () => {
      if (!device) throw new Error('Re-attach is only available when repairing.');
      const profile: ControllerProfile = device.getStoreValue('profile');
      const candidate = await this.app.health.findReattachCandidate(profile);
      if (!candidate) throw new Error('That remote is no longer available.');

      const newSource = await this.app.catalog.device(candidate.deviceId);
      const discovered = await this.app.discovery.discover(newSource);

      // The whole discovery result, not just its inputs: a re-attach must adopt
      // the new device's own surface hashes or the next health check reports the
      // surface as moved. See applyReattach.
      const updated = HealthMonitor.applyReattach(profile, candidate, discovered);
      await device.applyProfile(updated);

      return { mappings: updated.mappings.length, deviceName: candidate.deviceName };
    });

    // -------------------------------------------------------------- sources

    handler('listSources', async () => {
      const devices = await this.app.catalog.allDevices();
      const ranked = await this.app.discovery.rankSources(devices);
      return { rooms: groupSourcesByRoom(ranked as any[], state.sourceDeviceId) };
    });

    handler('selectSource', async (deviceId: string) => {
      const device = await this.app.catalog.device(deviceId);
      if (!device) throw new Error('That device is no longer available.');

      const result = await this.app.discovery.discover(device);

      // Changing the source invalidates bindings.
      if (state.sourceDeviceId && state.sourceDeviceId !== deviceId) {
        state.mappings = [];
      }
      state.sourceDeviceId = deviceId;
      state.catalogue = result.inputs;
      state.fingerprint = result.fingerprint;
      // Written on every save and repair, which is what makes the v1-to-v2
      // upgrade one-way. See surfaceMoved() in health-monitor.ts.
      state.fingerprintV2 = result.fingerprintV2;
      // Recorded for one-tap re-attach, which matches on owner app plus
      // driver plus fingerprint — never on model name alone.
      state.sourceDriverId = device.driverId ?? undefined;
      state.sourceOwnerUri = device.ownerUri ?? undefined;
      state.sourceName = device.name;

      return {
        deviceName: device.name,
        ownerName: device.ownerName,
        eventCount: result.inputs.length,
        controls: groupByControl(result.inputs).map(g => ({
          controlId: g.controlId,
          label: g.label,
          inputs: g.inputs.map(i => ({ key: i.key, label: i.label, action: i.action })),
        })),
        // Allow selection but block completion, rather than hiding it.
        usable: result.inputs.length > 0,
        rejected: result.rejected,
      };
    });

    // -------------------------------------------------------------- targets

    // The targets view is ONE file shared by all four drivers (platform §8), so the
    // line telling the user which lights these are has to be supplied per driver.
    // Resolved here rather than in `lib/`, which cannot translate.
    handler('listTargets', async () => ({
      ...await listTargetsPayload(this.app.catalog, state.target),
      subtitle: this.homey.__('targets.subtitleController'),
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

    // -------------------------------------------------------------- mapping

    handler('getMapping', async () => {
      if (!state.target) throw new Error('Choose some lights first.');
      const summary = await resolveSummary(this.app.catalog, state.target);
      const offered = availableFunctions(summary.support);
      const lights = await targetLights(this.app.catalog, state.target);

      return {
        functions: offered.map(fn => ({
          function: fn,
          label: this.homey.__(`functions.${fn}`),
          capability: FUNCTION_CAPABILITY[fn],
        })),
        // The lights chosen on the previous screen, so each rule can be aimed
        // at a subset of them rather than always at all of them.
        lights,
        controls: groupByControl(state.catalogue).map(g => ({
          controlId: g.controlId,
          label: g.label,
          inputs: g.inputs.map(i => ({
            key: i.key,
            // Split so the UI can drop the action when a control has only one,
            // and avoid "1 up rotary — Press".
            controlLabel: i.label.split(' — ')[0],
            actionLabel: i.label.split(' — ').slice(1).join(' — '),
            label: i.label,
          })),
        })),
        // Sections and rows, and the one-light collapse that binds them. Both
        // in lib/pairing/mapping-screen.ts, where they can be tested together:
        // the two halves have to agree about `groupKey` or a saved rule lands
        // in a section that is not on the page.
        groups: mappingGroups(lights, this.homey.__('mapping.allLights')),
        rules: mappingRuleRows(state.mappings, lights),
      };
    });

    /**
     * Replace the whole rule set. Simpler and less racy than per-rule edits,
     * and the list is tiny.
     *
     * Each rule may aim at a subset of the controller's lights. null means
     * "inherit" — all of them.
     */
    handler('setRules', async (raw: unknown) => {
      if (!state.target) throw new Error('Choose some lights first.');

      /**
       * Checked against what is ALREADY chosen, not against the whole Homey.
       *
       * A rule aimed at a light this controller does not target, at a function
       * the chosen lamps cannot perform, or at an event this remote does not
       * expose, is a row that saves and can never move anything — the exact
       * failure this app exists to prevent.
       *
       * DROPPED and named rather than refused. Narrowing the lights and then
       * going forward leaves stored rules that no screen renders, and rejecting
       * the payload for them made repair permanently unsaveable behind a raw
       * validation message. See validateMappingRules.
       */
      const summary = await resolveSummary(this.app.catalog, state.target);
      const selected = new Set(await targetDeviceIds(this.app.catalog, state.target));
      const { rules, dropped } = validateMappingRules(
        raw,
        selected,
        availableFunctions(summary.support),
        new Set(state.catalogue.map(input => input.key)),
      );
      for (const row of dropped) {
        this.log(`Dropped mapping row ${row.index}: ${row.reason}`);
      }

      // One rule per gesture. The mapping screen already displaces a duplicate
      // visibly; this is the net behind it, because a gesture assigned twice
      // reaches the engine's first-match resolve() and the second assignment
      // silently does nothing.
      const { rules: unique, displaced } = dedupeByInputKey(rules);
      for (const dropped of displaced) {
        this.log(`Dropped duplicate assignment of "${dropped.inputKey}" to ${dropped.function}`);
      }

      state.mappings = unique
        .filter(r => r.inputKey)
        .map(r => ({
          id: r.id,
          function: r.function,
          inputKey: r.inputKey,
          // '__all__' inherits the controller's own targets.
          target: ruleTargetFor(r.groupKey),
        }));
      return { count: state.mappings.length };
    });

    /**
     * Test control — executes the intent directly against the rule's own
     * targets. No flow required, works before save. The primary defence against
     * silent failure.
     */
    handler('test', async ({ func, deviceIds }: { func: LightFunction; deviceIds: string[] | null }) => {
      if (!state.target) throw new Error('Choose some lights first.');
      const runtime = await this.app.controllers.ephemeral(this.buildProfile(state));
      try {
        return await runtime.testFunction(func, deviceIds && deviceIds.length ? deviceIds : undefined);
      } finally {
        await runtime.stop();
      }
    });

    // ----------------------------------------------------------------- save

    handler('save', async (name: string) => {
      const profile = this.buildProfile(state);
      this.preflightBindings(profile);

      if (device) {
        await device.applyProfile(profile);
        return { updated: true };
      }

      return {
        created: true,
        device: {
          name: name || await this.deriveName(state),
          // `lk-ctrl-`, matching the schedule driver's `lk-sched-`. The old
          // `ll-` was Light Link, the name before this one. Nothing parses the
          // prefix, so devices created under it keep working untouched.
          data: { id: mintDeviceId('ctrl') },
          store: { profile },
        },
      };
    });
  }

  /**
   * Refuse a save whose mappings cannot be compiled into Flows.
   *
   * The compiler declines a control whose range would need more flow variants
   * than the ceiling allows — BILRESA's `switch_multi_press_multi` is 9 x 18 =
   * 162 of them (platform §7), thirteen times over. Until now that was
   * discovered at the FIRST RECONCILE, which is after the device exists: the
   * user finished pairing, the mapping row said it was configured, and the
   * gesture did nothing. The reason was one line in the app log.
   *
   * Doing it here means the answer arrives on the screen where the mapping was
   * made, while the user is still looking at the control they picked.
   *
   * The decision is `findUncompilableBindings` (pure, offline, tested); the
   * SENTENCE is here, because `lib/` cannot translate one.
   */
  private preflightBindings(profile: ControllerProfile): void {
    const declined = findUncompilableBindings(
      profile.catalogue ?? [],
      new Set(profile.mappings.map(rule => rule.inputKey).filter((key): key is string => key !== null)),
      profile.source.name ?? 'remote',
    );
    if (declined.length === 0) return;

    // Thrown, not returned: the pair view surfaces a rejected save as an error
    // next to the button, which is where this belongs.
    throw new Error(
      this.homey.__('mapping.unsupportedControl', {
        controls: declined.map(item => `${item.label} (${item.reason})`).join('; '),
      }),
    );
  }

  /**
   * A readable default name, so the last screen needs no text field. Homey
   * lets the user rename a device afterwards, which is the natural place for
   * it — asking during setup adds a step most people would skip anyway.
   */
  private async deriveName(state: SessionState): Promise<string> {
    return deriveControllerName(this.app.catalog, state.target, state.sourceName ?? 'Remote');
  }

  private buildProfile(state: SessionState): ControllerProfile {
    if (!state.sourceDeviceId || !state.target) {
      throw new Error('Choose a remote and some lights first.');
    }
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enabled: true,
      source: {
        deviceId: state.sourceDeviceId,
        ...(state.sourceOwnerUri ? { ownerAppId: state.sourceOwnerUri } : {}),
        ...(state.sourceDriverId ? { driverId: state.sourceDriverId } : {}),
        ...(state.sourceName ? { name: state.sourceName } : {}),
        eventSurfaceFingerprint: state.fingerprint ?? '',
        ...(state.fingerprintV2 ? { eventSurfaceFingerprintV2: state.fingerprintV2 } : {}),
      },
      target: state.target,
      mappings: state.mappings.filter(m => m.inputKey !== null),
      behavior: { ...DEFAULT_BEHAVIOR },
      managedFlows: [],
      catalogue: state.catalogue,
    };
  }

};
