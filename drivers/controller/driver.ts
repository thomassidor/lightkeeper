import type { LightkeeperApp } from '../../lib/app-contract';
import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import Homey from 'homey';
import { PressListener } from '../../lib/pairing/press-listener';
import { registerIntroHandler, registerReviewHandler } from '../../lib/pairing/flow-screens';

import {
  DEFAULT_BEHAVIOR, FUNCTION_CAPABILITY, FUNCTION_NEEDS_PRESET,
  type LightFunction, type MappingRule,
} from '../../lib/mapping/mapping-types';
import {
  CURRENT_SCHEMA_VERSION, dedupeByInputKey, type ControllerProfile,
} from '../../lib/profiles/controller-profile';
import { validateMappingRules } from '../../lib/validation/pairing-dto';
import { availableFunctions } from '../../lib/mapping/mapping-engine';
import { groupByControl, type SelectableInput } from '../../lib/inputs/selectable-input';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { findUncompilableBindings } from '../../lib/bridge/flow-binding-compiler';
import {
  resolveSummary, targetDeviceIds, targetLights,
} from '../../lib/pairing/target-picker';
import { groupSourcesByRoom } from '../../lib/pairing/source-list';
import { mappingGroups, mappingRuleRows, ruleTargetFor } from '../../lib/pairing/mapping-screen';
import { deriveControllerName } from '../../lib/pairing/derive-name';
import {
  handlerRegistrar,
  registerCredentialHandlers,
  registerTargetHandlers,
  type PairSessionHost,
} from '../../lib/pairing/pair-session';

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
  /**
   * Which gesture the pushed job editor is editing.
   *
   * Held here rather than passed through `showView`, because a pair session has
   * no query string and a reload of `job.html` would otherwise land on nothing.
   * One source of truth, and the editor cannot open on the wrong row.
   */
  editing?: string;
}

module.exports = class ControllerDriver extends Homey.Driver {

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

    const host = this.pairHost();
    const handler = handlerRegistrar(host, session);
    /**
     * One per SESSION, so abandoning the screen cannot leave a subscription on
     * every remote in the house for as long as the app runs.
     */
    const listener = new PressListener({ api: this.app.api, log: (...args) => this.log(...args) });

    // ---------------------------------------------------------- credentials

    registerCredentialHandlers(host, handler, 'remote');

    // The pairing view must emit 'add_device' after createDevice for the
    // device to actually be created — createDevice alone only stages it.
    // Some SDK builds handle this internally; having a handler makes the
    // explicit emit harmless either way.
    handler('add_device', async () => true);

    // ---------------------------------------------------------------- intro

    registerIntroHandler(host, handler, {
      titleKey: 'intro.controllerTitle',
      blurbKey: 'intro.controllerBlurb',
      hero: 'remote',
      decisions: [
        { whatKey: 'intro.theRemote', whyKey: 'intro.theRemoteWhy' },
        { whatKey: 'intro.whichLights', whyKey: 'intro.whichLightsWhy' },
        { whatKey: 'intro.theButtons', whyKey: 'intro.theButtonsWhy' },
        { whatKey: 'intro.checkIt', whyKey: 'intro.checkItWhy' },
      ],
      /**
       * The key screen, and it sits HERE rather than at the end.
       *
       * The design canvas moves it behind the work, on the grounds that the key
       * only gates Flow writes at save. That is true and it is the wrong trade:
       * somebody who reaches a four-step review and then cannot produce a key
       * loses everything they just set up. It costs a returning user nothing —
       * the key is per Homey, and `credential.html` skips itself when a valid
       * one is stored — so every controller after the first goes straight to the
       * remote picker.
       */
      nextView: 'credential',
    });

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
      // The candidate came from a health check that ran a moment ago, and a
      // device can be removed between the two — in which case re-attaching to
      // it would discover an empty surface and silently produce a controller
      // with no mappings.
      if (!newSource) throw new Error('That remote is no longer available.');
      const discovered = await this.app.discovery.discover(newSource);

      // The whole discovery result, not just its inputs: a re-attach must adopt
      // the new device's own surface hashes or the next health check reports the
      // surface as moved. See applyReattach.
      const updated = HealthMonitor.applyReattach(profile, candidate, discovered);
      await device.applyPlan(updated);

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

    registerTargetHandlers(host, handler, state, {
      subtitleKey: 'targets.subtitleController',
      // Step TWO, not one: this is the only driver that asks for a remote first,
      // which is why the shared screen takes its own number rather than knowing.
      stepIndex: 2,
      stepCount: 4,
      nextView: 'buttons',
    });

    // --------------------------------------------------------------- review

    registerReviewHandler(host, handler, async () => {
      const summary = await resolveSummary(this.app.catalog, state.target!);
      const assigned = state.mappings.filter(rule => rule.inputKey !== null).length;

      return {
        stepIndex: 4,
        stepCount: 4,
        rows: [
          {
            labelKey: 'review.remote',
            value: state.sourceName ?? host.translate('review.missingRemote'),
            view: 'remote',
          },
          {
            labelKey: 'review.lights',
            value: await this.lightsSummary(state.target!, summary),
            view: 'lights',
          },
          {
            /**
             * How many of the remote's gestures have a job, out of how many it
             * has at all.
             *
             * Both numbers, because "4" alone cannot distinguish a remote that
             * is fully set up from one where half the buttons were never
             * reached. "Nothing" is a finished state on the buttons screen, so
             * this row reports rather than warns.
             */
            labelKey: 'review.buttonsWithAJob',
            value: `${assigned} / ${state.catalogue.length}`,
            view: 'buttons',
          },
        ],
        promiseKey: 'review.promiseController',
      };
    });

    // -------------------------------------------------------------- buttons

    /**
     * One row per thing the remote can do, in the order the buttons sit on it.
     *
     * The inverse of the old grid, which offered seven lighting functions each
     * with a dropdown of the remote's events. The user is holding the remote and
     * thinking "what should THIS button do", so that asked the question
     * backwards — and "Not assigned" five times read as unfinished work rather
     * than as a remote with five buttons and two jobs.
     *
     * One rule per gesture is structural here: a gesture IS a row, so it cannot
     * have two. `dedupeByInputKey` and `setRules` keep the same rule on the
     * paths this screen is not the only way in through.
     */
    handler('getButtons', async () => {
      if (!state.target) throw new Error('Choose some lights first.');

      const jobs: Record<string, { label: string }> = {};
      for (const rule of state.mappings) {
        if (rule.inputKey === null) continue;
        jobs[rule.inputKey] = { label: this.homey.__(`functions.${rule.function}`) };
      }

      return {
        gestures: state.catalogue.map(input => ({
          key: input.key,
          // Split so a control with one action does not read "Top — Press" when
          // "Top" is the whole of what there is to say.
          buttonLabel: input.label.split(' — ')[0],
          actionLabel: input.label.split(' — ').slice(1).join(' — '),
        })),
        jobs,
      };
    });

    /** Which row the pushed editor is about to edit. */
    handler('editGesture', async (key: unknown) => {
      const wanted = typeof key === 'string' ? key : '';
      // Checked against what this remote actually exposes: a pair session is a
      // scriptable Web API surface (platform §14), and a rule naming an event
      // the remote does not have is a rule that can never fire.
      if (!state.catalogue.some(input => input.key === wanted)) {
        throw new Error('That is not one of this remote\'s buttons.');
      }
      state.editing = wanted;
      return { editing: wanted };
    });

    handler('getGesture', async () => {
      if (!state.editing) throw new Error('No button is being edited.');
      if (!state.target) throw new Error('Choose some lights first.');

      const summary = await resolveSummary(this.app.catalog, state.target);
      const offered = availableFunctions(summary.support);
      const input = state.catalogue.find(candidate => candidate.key === state.editing);
      const rule = state.mappings.find(candidate => candidate.inputKey === state.editing);

      return {
        title: input?.label ?? '',
        /**
         * "Nothing" first, and it is a real choice rather than an absence.
         *
         * A button with no job is a finished button; offering it as an option is
         * what stops an unassigned row reading as work left undone.
         */
        jobs: [
          { id: null, label: this.homey.__('job.nothing'), needsPreset: false },
          ...offered.map(fn => ({
            id: fn,
            label: this.homey.__(`functions.${fn}`),
            needsPreset: FUNCTION_NEEDS_PRESET[fn],
          })),
        ],
        chosen: rule?.function ?? null,
        needsPreset: rule ? FUNCTION_NEEDS_PRESET[rule.function] : false,
        preset: rule?.preset ?? null,
      };
    });

    /**
     * Set, change or clear one gesture's job.
     *
     * Replaces the rule for THIS gesture and leaves every other alone, which is
     * the one place this driver edits a rule rather than replacing the set —
     * and it is safe because a gesture is a row, so there is exactly one rule to
     * replace.
     */
    handler('setGesture', async (payload: unknown) => {
      if (!state.editing) throw new Error('No button is being edited.');
      const asked = payload as { job?: unknown; preset?: unknown } | undefined;
      const job = typeof asked?.job === 'string' ? asked.job : null;

      const kept = state.mappings.filter(rule => rule.inputKey !== state.editing);

      if (job === null) {
        state.mappings = kept;
        return { cleared: true };
      }

      const { rules, dropped } = validateMappingRules(
        [{
          id: `r-${state.editing}`,
          groupKey: '__all__',
          function: job,
          inputKey: state.editing,
          ...(asked?.preset ? { preset: asked.preset } : {}),
        }],
        new Set(await targetDeviceIds(this.app.catalog, state.target!)),
        availableFunctions((await resolveSummary(this.app.catalog, state.target!)).support),
        new Set(state.catalogue.map(input => input.key)),
      );

      if (rules.length === 0) {
        throw new Error(dropped[0]?.reason ?? 'That job cannot be used here.');
      }

      state.mappings = [...kept, {
        id: rules[0]!.id,
        function: rules[0]!.function,
        inputKey: rules[0]!.inputKey,
        target: null,
        ...(rules[0]!.preset !== undefined ? { preset: rules[0]!.preset } : {}),
      }];
      return { set: true };
    });

    // ------------------------------------------------------- press to find

    /**
     * Listen for a real press, bounded and escapable.
     *
     * A convenience, never the only path: capability-based events are
     * observable directly, but a card-only remote cannot be heard at all
     * (platform §4) — so the list stays one tap away on both screens that offer
     * this, and a silent battery remote is never a dead end.
     */
    handler('startListening', async () => {
      const candidates = await this.app.catalog.allDevices();
      await listener.start(candidates as any[], heard => {
        // Two different screens listen, and they want different halves: the
        // remote picker wants the DEVICE, the buttons screen wants the gesture.
        // Both are emitted and each screen takes the one it asked about, which
        // is cheaper than two listeners over the same subscriptions.
        session.emit('heardSource', { id: heard.deviceId, name: heard.name });
        session.emit('heard', heard.key);
      });
      return { listening: true };
    });

    handler('stopListening', async () => {
      await listener.stop();
      return { listening: false };
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
        await device.applyPlan(profile);
        return { updated: true };
      }

      return {
        created: true,
        device: {
          name: name || await this.deriveName(state),
          // `lk-ctrl-`, matching the schedule driver's `lk-sched-`. The old
          // `ll-` was Light Link, the name before this one.
          //
          // The prefix IS parsed: `LIGHTKEEPER_DEVICE_ID` in
          // lib/bridge/flow-bridge-manager.ts is what proves a Flow's
          // `controller` argument was written by us rather than typed in by
          // hand, and it matches `lk-` only. So a new device KIND has to be
          // added to both `mintDeviceId` and that pattern — and an `ll-` device,
          // if any exists, has unattributable Flows: the sweep reads them as
          // not-generated and leaves them alone, which is the safe direction.
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
  /**
   * What the lights row reads back — and WHICH of the two shapes it stored.
   *
   * "Everything in Kitchen" and "4 picked" behave differently the next time
   * somebody adds a lamp to that room, and this line is the only place that
   * difference is ever visible.
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
