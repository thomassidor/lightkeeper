import type { LightkeeperApp } from '../../lib/app-contract';
import { mintDeviceId } from '../../lib/bridge/flow-bridge-manager';
import Homey from 'homey';
import {
  colourSwatch, lightsSummary, registerIntroHandler, registerReviewHandler,
} from '../../lib/pairing/flow-screens';
import {
  isSourceKind, sourceRows, type SourceDevice, type SourceKind,
} from '../../lib/pairing/source-picker';
import { LEAVE_ALONE } from '../../lib/outputs/lightkeeper-settings';
import { isLightkeeperPreset, type LightkeeperPreset } from '../../lib/mapping/mapping-types';

import {
  DEFAULT_BEHAVIOR, FUNCTION_CAPABILITY, FUNCTION_PRESET,
  type LightFunction, type MappingRule,
} from '../../lib/mapping/mapping-types';
import { FEATURED_COLORS, PALETTE } from '../../lib/circadian/palette';
import {
  CURRENT_SCHEMA_VERSION, dedupeByInputKey, type ControllerProfile,
} from '../../lib/profiles/controller-profile';
import { validateMappingRules } from '../../lib/validation/pairing-dto';
import { availableFunctions, honouredFunctions } from '../../lib/mapping/mapping-engine';
import { groupByControl, type SelectableInput } from '../../lib/inputs/selectable-input';
import type { TargetSpec } from '../../lib/outputs/light-intent';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { findUncompilableBindings } from '../../lib/bridge/flow-binding-compiler';
import {
  resolveSummary, targetDeviceIds, targetLights,
} from '../../lib/pairing/target-picker';
import { buildSourceList } from '../../lib/pairing/source-list';
import {
  mappingGroups, mappingRuleRows, ruleTargetFrom, storedRuleFrom,
} from '../../lib/pairing/mapping-screen';
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
  /**
   * Which of the two source pickers is open, when one is.
   *
   * The same reason `editing` is here rather than in a query string: `job.html`
   * pushes ONE view for two questions, so the driver is told which before
   * `showView('source')` and the view asks it back. One source of truth, and a
   * reload cannot land on the wrong picker.
   */
  editingSource?: SourceKind;
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
      // Lightkeeper's own devices are excluded the way they are from the light
      // picker: a schedule or a circadian light is not a remote, it carries
      // generated capability cards like anything else, and offering one here
      // would only ever be noise. `lightCandidates()` has made the same
      // exclusion since it was written; this list had not.
      const devices = (await this.app.catalog.allDevices())
        .filter(device => !this.app.catalog.isOwnDevice(device));
      const ranked = await this.app.discovery.rankSources(devices);
      // `current` as well as the rooms: repair opens on the remote the
      // controller was built from, and the screen marks it from this rather
      // than from each source's own `selected` — one field to read instead of
      // a search through every room.
      return {
        ...buildSourceList(ranked as any[], state.sourceDeviceId),
        /** Both lists, for the search box that spans both. */
        total: ranked.length,
        current: state.sourceDeviceId ?? null,
      };
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
      /**
       * Narrowing the lights re-aims the buttons that named one of them.
       *
       * A button may drive a SUBSET of the device's lights, so unticking a lamp
       * on this screen can leave a rule pointing at a light the device no longer
       * targets — which the runtime would refuse to write to anyway, leaving a
       * row that reads as configured and moves nothing.
       *
       * A rule left with nothing falls back to "all of them" rather than being
       * deleted: the job was a decision and the lights were a refinement of it,
       * so the refinement is what goes. It is not a silent change either — the
       * buttons screen is the very next thing this flow shows, and every row
       * says which lights it drives.
       */
      onSelected: async target => {
        const kept = new Set(await targetDeviceIds(this.app.catalog, target));
        state.mappings = state.mappings.map(rule => {
          if (rule.target?.kind !== 'devices') return rule;
          const narrowed = rule.target.deviceIds.filter(id => kept.has(id));
          return { ...rule, target: ruleTargetFrom(narrowed) };
        });
      },
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

      /**
       * The job AND the lights it drives, on the row, as one line.
       *
       * Per-button lights would otherwise be a setting you can only discover by
       * opening a row and reading a checklist — and a remote whose top button
       * dims the floor lamp while its bottom button dims everything is
       * indistinguishable, on this screen, from one that does neither. The
       * summary is what makes the whole mapping legible without opening
       * anything.
       */
      const lights = await targetLights(this.app.catalog, state.target);

      const jobs: Record<string, { label: string; detail: string }> = {};
      for (const rule of state.mappings) {
        if (rule.inputKey === null) continue;
        const label = this.homey.__(`functions.${rule.function}`);
        const aimed = await this.lightsPhrase(rule.target, lights);
        jobs[rule.inputKey] = {
          label,
          // One light in the whole device and the second half says nothing: it
          // is the same lamp on every row, and the row is shorter without it.
          detail: aimed === null ? label : this.homey.__('buttons.detail', { job: label, lights: aimed }),
        };
      }

      return {
        gestures: state.catalogue.map(input => ({
          key: input.key,
          // "Top · Press" as ONE line, because the row's second line now carries
          // the job and its lights. Split on the normalizer's own separator so a
          // control with no action of its own ("1 up rotary") stays as it is.
          label: input.label.split(' — ').join(' · '),
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

      /**
       * A retired job keeps its tile for as long as THIS button is the one
       * using it.
       *
       * `availableFunctions` is what may be chosen and no longer includes
       * `temperature_cycle` (see RETIRED_FUNCTIONS). A button already assigned
       * to it would otherwise open an editor with nothing selected, which reads
       * as "this button does nothing" about a button that does something.
       */
      const honoured = honouredFunctions(summary.support);
      const tiles = rule && !offered.includes(rule.function) && honoured.includes(rule.function)
        ? [...offered, rule.function]
        : offered;

      const lights = await targetLights(this.app.catalog, state.target);
      const aimed = rule?.target ? await targetDeviceIds(this.app.catalog, rule.target) : null;

      /**
       * "On – with Lightkeeper" is withdrawn when there is nothing to take
       * anything FROM.
       *
       * `availableFunctions` answers what the chosen LAMPS can do, which for
       * this job is every lamp that switches on. Whether the house owns a
       * circadian light, a curve, a schedule or a Room-sensing Light is a
       * different question and only the driver can ask it — and a card that
       * opens two pickers onto two empty lists is a dead end somebody has to
       * back out of.
       *
       * Kept for a button that already uses it, exactly as a retired job is
       * kept above: the device may have been configured while a curve existed
       * and be repaired after it was deleted, and taking the row away would
       * read as "this button does nothing" about a button that still does
       * something — it degrades to plain "on".
       */
      const composable = this.sourceCount() > 0;
      const offerable = composable || rule?.function === 'lightkeeper_on'
        ? tiles
        : tiles.filter(fn => fn !== 'lightkeeper_on');

      return {
        title: input ? input.label.split(' — ').join(' · ') : '',
        /**
         * Nine jobs as a grid, and "do nothing" is NOT one of them.
         *
         * A button with no job is a finished button, so the absence of a job is
         * offered as plainly as any job — but apart from the grid rather than as
         * a tenth kind of job inside it. The screen draws the separation; this
         * list is only the grid's own contents.
         */
        jobs: offerable.map(fn => ({
          id: fn,
          label: this.homey.__(`functions.${fn}`),
          /**
           * 'none' | 'brightness' | 'colour' | 'lightkeeper' — which editor the
           * tile opens, AND how the screen tells a grid cell from the card
           * above it. `lightkeeper` is drawn full width with two rows and a
           * switch, which is why it is found by this rather than by position.
           */
          preset: FUNCTION_PRESET[fn],
        })),
        chosen: rule?.function ?? null,
        presetKind: rule ? FUNCTION_PRESET[rule.function] : 'none',
        preset: rule?.preset ?? null,
        /**
         * The same closed palette a Colour Curve Light chooses from, painted by
         * the view from the two axes rather than from a hex string: there is no
         * hex anywhere in the palette, and inventing one here would be a second
         * definition of "amber" to keep in step.
         */
        colors: PALETTE.map(colour => ({
          id: colour.id,
          label: this.homey.__(colour.labelKey),
          /**
           * The CSS the swatch is painted in, computed HERE.
           *
           * `colourSwatch()` already turns Homey's two normalised axes into an
           * hsl() a browser will paint, and the curve screen carries a second
           * copy of that maths because its chart repaints on every drag and
           * cannot ask the driver. This screen draws its swatches once, so it
           * asks — a third copy of two magic curves is a third place to get
           * them wrong.
           */
          swatch: colourSwatch(colour),
        })),
        featuredColors: FEATURED_COLORS,
        /**
         * WHICH lights, and the answer is a subset of the device's own — never
         * the whole Homey. The second half of the sentence this screen is:
         * this button does THIS, to THESE.
         */
        lights: lights.map(light => ({ id: light.id, name: light.name })),
        /**
         * "All three lights", as a phrase rather than as a field.
         *
         * Composed here because the view cannot: a count as a WORD is a locale
         * lookup per number, and `lib/` and the views are both the wrong side
         * of `homey.__` for that.
         */
        allLabel: this.homey.__('job.allLights', { count: this.countWord(lights.length) }),
        /** null means all of them, and keeps meaning that as the room changes. */
        chosenLights: aimed,
        /**
         * What the two chosen setups are CALLED, for the hero card's two rows.
         *
         * Resolved here because neither half of the answer is reachable from
         * the view: `lib/` cannot translate "Leave it alone", and a webview
         * cannot look a runtime up by id. The row would otherwise have to print
         * the stored `lk-curve-…` at somebody.
         */
        sourceNames: this.sourceNames(rule?.preset),
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
    const applyGesture = async (
      asked: { job?: unknown; preset?: unknown; lights?: unknown } | undefined,
    ) => {
      if (!state.editing) throw new Error('No button is being edited.');
      const job = typeof asked?.job === 'string' ? asked.job : null;

      const kept = state.mappings.filter(rule => rule.inputKey !== state.editing);

      if (job === null) {
        state.mappings = kept;
        return { cleared: true };
      }

      /**
       * `honouredFunctions`, not `availableFunctions`: a button already set to a
       * retired job keeps its tile, so the screen can send that job straight
       * back at us when something else on the row changes. Validating against
       * what may be CHOSEN would then refuse to re-save a mapping it had just
       * drawn as chosen.
       */
      const summary = await resolveSummary(this.app.catalog, state.target!);
      const { rules, dropped } = validateMappingRules(
        [{
          id: `r-${state.editing}`,
          /**
           * Passed through unread: null is "all of this controller's lights"
           * and a list is a subset, and both are checked against what the
           * previous screen actually chose — a pair session is a scriptable Web
           * API surface (platform §14), so a light nobody selected must not
           * become a target by being named here.
           */
          lights: asked?.lights ?? null,
          function: job,
          inputKey: state.editing,
          ...(asked?.preset ? { preset: asked.preset } : {}),
        }],
        new Set(await targetDeviceIds(this.app.catalog, state.target!)),
        honouredFunctions(summary.support),
        new Set(state.catalogue.map(input => input.key)),
      );

      if (rules.length === 0) {
        throw new Error(dropped[0]?.reason ?? 'That job cannot be used here.');
      }

      state.mappings = [...kept, storedRuleFrom(rules[0]!)];
      return { set: true };
    };

    handler('setGesture', async (payload: unknown) => applyGesture(
      payload as { job?: unknown; preset?: unknown; lights?: unknown } | undefined,
    ));

    // -------------------------------------------------- the two source pickers

    /** Which of the two questions the pushed picker is about to ask. */
    handler('editSource', async (kind: unknown) => {
      if (!state.editing) throw new Error('No button is being edited.');
      // Checked against the two literals for the same reason `editGesture`
      // checks its key: a pair session is a scriptable Web API surface
      // (platform §14), and a third kind would open a screen for a question
      // this app does not ask.
      if (!isSourceKind(kind)) throw new Error('That is not a source this button takes.');
      state.editingSource = kind;
      return { editing: kind };
    });

    handler('getSource', async () => {
      const kind = state.editingSource;
      if (!kind) throw new Error('No source is being chosen.');

      const rule = state.mappings.find(candidate => candidate.inputKey === state.editing);
      const preset = rule?.preset;
      const chosen = preset !== undefined && isLightkeeperPreset(preset)
        ? (kind === 'colour' ? preset.colourSource : preset.brightnessSource)
        : LEAVE_ALONE;

      return {
        kind,
        title: this.homey.__(kind === 'colour' ? 'job.takeColourTitle' : 'job.takeBrightnessTitle'),
        blurb: this.homey.__('job.takeBlurb'),
        /**
         * What the swatches and the levels ARE, under the list rather than over
         * it. Both say the same thing in different words — these are live
         * readings, not the values this button will be fixed at — and the
         * screen's own subtitle has already said the important half.
         */
        note: this.homey.__(kind === 'colour' ? 'job.swatchNote' : 'job.levelNote'),
        empty: this.homey.__('job.noSources'),
        chosen,
        sources: sourceRows(kind, await this.sourceDevices(kind), {
          name: this.homey.__('flow.leaveAlone'),
          subtitle: this.homey.__('flow.leaveAloneHint'),
        }),
      };
    });

    /**
     * One source chosen, through the same validation and the same conversion
     * `setGesture` uses.
     *
     * Not a hand-built rule written into `state.mappings`: that is exactly the
     * second conversion `storedRuleFrom`'s docblock records the cost of, and it
     * would be free to store a preset this build cannot read back.
     */
    handler('setSource', async (payload: unknown) => {
      const kind = state.editingSource;
      if (!kind) throw new Error('No source is being chosen.');
      const asked = payload as { id?: unknown } | undefined;
      const id = typeof asked?.id === 'string' && asked.id.length > 0 ? asked.id : LEAVE_ALONE;

      const rule = state.mappings.find(candidate => candidate.inputKey === state.editing);
      const existing = rule?.preset;
      const base: LightkeeperPreset = existing !== undefined && isLightkeeperPreset(existing)
        ? existing
        // What a button starts with the moment the job is chosen. Both sources
        // unanswered, and `pressAgainOff` ON — see the note in job.html: the
        // second press is what makes one button a whole light switch.
        : { colourSource: LEAVE_ALONE, brightnessSource: LEAVE_ALONE, pressAgainOff: true };

      const preset: LightkeeperPreset = kind === 'colour'
        ? { ...base, colourSource: id }
        : { ...base, brightnessSource: id };

      /**
       * Clearing the LAST source is refused, with a sentence rather than with
       * the validator's own message.
       *
       * `readMappingPreset` refuses the same shape and would throw here anyway
       * — but as "preset names no Lightkeeper device to take a colour or a
       * brightness from", printed at somebody who has just tapped "Leave it
       * alone". The refusal is right (a button that names neither is plain
       * "On" wearing a name that promises more); only the wording was not.
       */
      if (preset.colourSource === LEAVE_ALONE && preset.brightnessSource === LEAVE_ALONE) {
        throw new Error(this.homey.__('job.needASource'));
      }

      await applyGesture({
        job: 'lightkeeper_on',
        preset,
        lights: rule?.target?.kind === 'devices' ? rule.target.deviceIds : null,
      });
      return { chosen: id };
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

      /**
       * `storedRuleFrom`, not a rebuild here.
       *
       * This path used to write the rule out field by field and drop the
       * preset, while `setGesture` — the one the buttons screen actually uses —
       * carried it. A `brightness_set` or a `color_set` saved through here was
       * stored as a job that says "set a value" and names none, which is the one
       * shape `validateControllerProfile` quarantines: the device paired, wrote
       * its store, and came up unavailable on the next `onInit`.
       *
       * Not reachable from today's screens — but a pair session is a scriptable
       * Web API surface (platform §14), so this path is somebody's script, and
       * one shared conversion is what stops the two answers drifting again.
       */
      state.mappings = unique.filter(r => r.inputKey).map(storedRuleFrom);
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
          // `.trim()` before the `||`, which the shared `registerSaveHandler`
          // in lib/pairing/pair-session.ts has and this copy did not: a
          // whitespace-only name is truthy, so it was accepted verbatim and
          // produced a device whose tile appears to have no name at all. The
          // derivation is the answer to "the user gave us nothing", and a name
          // of spaces IS nothing. This is the one driver that does not use the
          // shared handler, which is exactly why it still carried the old line.
          name: name?.trim() || await this.deriveName(state),
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
  /**
   * Which lights a rule drives, as the shortest true phrase for them.
   *
   * null when there is nothing worth saying — a device with one light says the
   * same name on every row, and a row is clearer without it.
   *
   * The shape of the answer is the whole point: "all three" for the default
   * stays short whether the device has three lights or thirty, a subset of one
   * or two is worth naming outright, and past that a count beats a list that
   * would wrap onto a third line. The alternative — naming every light — is
   * what made the old mapping grid unreadable on a house with nine lamps.
   */
  private async lightsPhrase(
    target: TargetSpec | null,
    lights: Array<{ id: string; name: string }>,
  ): Promise<string | null> {
    if (lights.length <= 1) return null;

    if (target === null) {
      return this.homey.__('targets.allCount', { count: this.countWord(lights.length) });
    }

    const aimed = new Set(await targetDeviceIds(this.app.catalog, target));
    const names = lights.filter(light => aimed.has(light.id)).map(light => light.name);

    if (names.length === lights.length) {
      return this.homey.__('targets.allCount', { count: this.countWord(lights.length) });
    }
    // Every named light has gone. Not reachable from the screens — narrowing the
    // selection re-aims the rule first — but this reads a STORED profile, and
    // saying so beats an empty half-sentence.
    if (names.length === 0) return this.homey.__('targets.noneOfThem');
    if (names.length === 1) return names[0]!;
    if (names.length === 2) {
      return this.homey.__('targets.pair', { first: names[0]!, second: names[1]! });
    }
    return this.homey.__('targets.someLights', { count: this.countWord(names.length) });
  }

  /**
   * How many Lightkeeper devices this house has that publish anything.
   *
   * The question behind offering "On – with Lightkeeper" at all. Controllers
   * are deliberately absent: a remote has no desired state to publish, only the
   * last thing somebody pressed, so counting them would offer a job whose two
   * pickers were still empty.
   */
  private sourceCount(): number {
    return this.app.curves.all().length
      + this.app.schedules.all().length
      + this.app.daylights.all().length;
  }

  /**
   * The two chosen setups, as the words the hero card's rows print.
   *
   * "Leave it alone" for an unset one, and for a set one that no live runtime
   * answers to — which is what a deleted curve looks like from here. Printing
   * the stored id instead would be honest about the store and useless to the
   * person reading it, and the press degrades to plain "on" anyway.
   */
  private sourceNames(preset: MappingRule['preset']): { colour: string; brightness: string } {
    const leaveAlone = this.homey.__('flow.leaveAlone');
    if (preset === undefined || !isLightkeeperPreset(preset)) {
      return { colour: leaveAlone, brightness: leaveAlone };
    }
    return {
      colour: this.app.curves.get(preset.colourSource)?.deviceName ?? leaveAlone,
      brightness: (this.app.daylights.get(preset.brightnessSource)
        ?? this.app.curves.get(preset.brightnessSource)
        ?? this.app.schedules.get(preset.brightnessSource))?.deviceName ?? leaveAlone,
    };
  }

  /**
   * Every device that can answer one of the two questions, with what it is
   * showing right now.
   *
   * The two lists differ and the difference is the rule: a COLOUR comes only
   * from a curve-driven device, because only those two device types compute a
   * hue and only they publish a warmth they are actively driving; a BRIGHTNESS
   * comes from any of the three types that publish one. It is the same split
   * `app.ts`'s `sourceRegistry()` makes for the Flow card and for the press
   * itself, and all three have to agree or a screen offers a device the press
   * will then call missing.
   */
  private async sourceDevices(kind: SourceKind): Promise<SourceDevice[]> {
    const subtitles = await this.ownDeviceSubtitles();
    const describe = (id: string, name: string) => ({
      id, name, subtitle: subtitles.get(id) ?? '',
    });

    if (kind === 'colour') {
      return this.app.curves.all().map(runtime => ({
        ...describe(runtime.controllerId, runtime.deviceName),
        values: runtime.publishedValues(),
        // The live value, not the board: the board publishes the colour as a
        // NAME and a swatch needs the two axes. Same read `set_lights` makes.
        current: runtime.currentValue(),
      }));
    }

    return [
      ...this.app.daylights.all(), ...this.app.curves.all(), ...this.app.schedules.all(),
    ].map(runtime => ({
      ...describe(runtime.controllerId, runtime.deviceName),
      values: runtime.publishedValues(),
    }));
  }

  /**
   * "Colour Curve Light · Living room", per Lightkeeper device id.
   *
   * The join is `data.id`, because a runtime is keyed on the `lk-…` string this
   * app minted and the catalogue is keyed on Homey's own uuid — see
   * `CatalogDevice.dataId`, which exists for this and for nothing else.
   *
   * The device TYPE is the driver's own manifest name rather than a locale key
   * of ours, so a driver renamed in `driver.compose.json` renames itself here
   * too and cannot be renamed in one place only. A row that does not join gets
   * an empty subtitle rather than a guess.
   */
  private async ownDeviceSubtitles(): Promise<Map<string, string>> {
    const devices = await this.app.catalog.allDevices();
    const subtitles = new Map<string, string>();

    for (const device of devices) {
      if (!device.dataId || !this.app.catalog.isOwnDevice(device)) continue;
      const parts = [this.driverNameOf(device.driverId), device.zoneName].filter(part => part !== '');
      subtitles.set(device.dataId, parts.join(' · '));
    }
    return subtitles;
  }

  /** One of this app's own driver names, from the manifest that declares it. */
  private driverNameOf(driverId: string | null): string {
    const id = driverId?.split(':').pop() ?? '';
    const drivers = (this.homey.manifest as { drivers?: unknown })?.drivers;
    const found = Array.isArray(drivers)
      ? drivers.find((driver: { id?: unknown }) => driver?.id === id)
      : undefined;
    const name = (found as { name?: unknown } | undefined)?.name;

    // The manifest field is `{ "en": … }` — the object form every user-facing
    // string in this app keeps so a language stays a sibling key. The CLI is
    // free to resolve it to a plain string for the running locale, so both
    // shapes are read rather than one assumed.
    if (typeof name === 'string') return name;
    const english = (name as { en?: unknown } | undefined)?.en;
    return typeof english === 'string' ? english : '';
  }

  /**
   * A small count as a word, because "all three" is a phrase and "all 3" is a
   * field. Past twelve the digits read better than the words do.
   */
  private countWord(count: number): string {
    const words = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six',
      'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    ];
    const word = words[count];
    return word === undefined ? String(count) : this.homey.__(`count.${word}`);
  }

  private async lightsSummary(
    target: TargetSpec,
    summary: { count: number },
  ): Promise<string> {
    return lightsSummary(this.pairHost(), target, summary, () => this.app.catalog.allZones());
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
