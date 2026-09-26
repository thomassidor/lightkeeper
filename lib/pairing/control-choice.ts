import { targetDeviceIds } from './target-picker';
import type { HandlerRegistrar, PairSessionHost } from './pair-session';
import { LocalisedError } from '../support/localised-error';
import type { PreStageLampResult } from '../circadian/circadian-runtime';
import type { TargetSpec } from '../outputs/light-intent';
import { keepsLightsUpdated, writesLightsField } from '../runtime/writes-lights';

/**
 * "How Lightkeeper controls your lights": the one choice on the review screen
 * of the three engine device types, and the two stored flags behind it.
 *
 * It replaced two controls that answered one question in two places. "Keep
 * these lights up to date" was a switch on each engine's own editing step, and
 * "Set the colour before lights come on" was a switch hidden behind
 * `SHOW_PRE_STAGE` on two of them — so the household decided HOW their lights
 * are driven halfway through deciding WHAT they are driven to, and one of the
 * two decisions was not drawn at all. The 2026-09-23 design moves both to the
 * last screen, as three options of one radio group:
 *
 *   after   "Change lights after they turn on"   — today's behaviour, and the
 *                                                  default
 *   before  "Set lights before they turn on"     — `preStage: true`, and only
 *                                                  for the lamps the test proved
 *   none    "Don't change lights automatically"  — `writesLights: false`
 *
 * **No new stored shape.** The three are the two flags the plans already had,
 * plus `preStageLights`: the lamps the test watched stay off. "Before", chosen
 * and not yet tested, is `preStage: true` with no list, and pre-stages nothing
 * (`preStagesLamp()` in lib/circadian/circadian-types.ts) — which is exactly
 * "until the test has run, the device behaves as option 1", and is also what
 * every device paired before this change with `preStage: true` now reads as.
 *
 * **A Room-sensing Light is offered two of the three.** It writes brightness
 * and nothing else, and a `dim` write is what switches a lamp on (platform §12),
 * so a test of "before" would fail on every lamp there is. `offerBefore: false`
 * removes the option, and `setControl` refuses it rather than trusting the
 * screen — pair sessions are a scriptable surface (platform §14).
 */

export type ControlMode = 'after' | 'before' | 'none';

/** All three, in the capability's own order — what an un-narrowed picker offers. */
export const ALL_CONTROL_MODES: readonly ControlMode[] = ['after', 'before', 'none'];

/**
 * The same choice as a picker on the device itself, so it can be changed
 * without opening Repair.
 *
 * Its values are the three `ControlMode`s verbatim, which is what lets the tile
 * and the review screen share every rule below rather than translate between
 * two vocabularies. A Room-sensing Light narrows the picker to two through
 * `capabilitiesOptions` — and, on a device paired before the picker existed,
 * through `DeviceLifecycle.narrowControlPicker` (platform §18) — and `DeviceLifecycle.setControlMode` refuses the third
 * regardless — a capability value is as scriptable as a pair session.
 */
export const CONTROL_CAPABILITY = 'lightkeeper_control';

/** A stored plan's slice of the choice: every engine plan has this shape. */
export interface ControlPlan {
  preStage?: boolean;
  preStageLights?: string[];
  writesLights?: boolean;
}

/** Anything that is one of the three, and nothing else. */
export function isControlMode(value: unknown): value is ControlMode {
  return value === 'after' || value === 'before' || value === 'none';
}

/** Which of the three a STORED plan amounts to — `writesLights` absent is on. */
export function controlModeOfPlan(plan: ControlPlan): ControlMode {
  return controlModeOf({ preStage: plan.preStage, writesLights: keepsLightsUpdated(plan) });
}

/**
 * A copy of a stored plan with the choice moved, for the tile's picker.
 *
 * The pure twin of `applyControlMode` below, which moves a pairing SESSION.
 * Two rules it must keep that the session's version does not have to: the
 * `writesLights` key is stored only when false (see `writesLightsField`), and
 * `preStage` is written only where the plan already has one — a Room-sensing
 * Light's plan has none, and growing one would be a flag its validator never
 * stores. `preStageLights` is kept, for the reason `applyControlMode` gives.
 */
export function planWithControlMode<T extends ControlPlan>(plan: T, mode: ControlMode): T {
  const { writesLights: _dropped, ...rest } = plan;
  return {
    ...rest,
    ...writesLightsField(mode !== 'none'),
    ...(plan.preStage !== undefined ? { preStage: mode === 'before' } : {}),
  } as T;
}

/**
 * The warning a device should carry for its choice, or null.
 *
 * "Before" chosen with no lamp ever proven pre-stages nothing — the design's
 * "until the test has run, the device behaves as option 1". That is the right
 * behaviour and an invisible one, and the tile's picker makes it easy to reach:
 * the review screen runs the test beside the option, the tile cannot (it would
 * blink every lamp that is on, from a Flow as readily as from a finger). So the
 * device says so instead.
 */
export function controlWarningKey(plan: ControlPlan): string | null {
  if (controlModeOfPlan(plan) !== 'before') return null;
  return (plan.preStageLights ?? []).length === 0 ? 'warnings.preStageUntested' : null;
}

/** The slice of a driver's session state the choice moves. */
export interface ControlState {
  /** Absent on a Room-sensing Light, which has nothing to pre-stage. */
  preStage?: boolean;
  /** Proven lamps. Absent = never tested. See CircadianPlan.preStageLights. */
  preStageLights?: string[] | undefined;
  writesLights: boolean;
  /** This SESSION's test, with names, for the review to draw. Never stored. */
  tested?: Array<{ deviceId: string; name: string; ok: boolean }> | undefined;
  target?: TargetSpec | undefined;
}

/** Which of the three the stored flags amount to. */
export function controlModeOf(state: Pick<ControlState, 'preStage' | 'writesLights'>): ControlMode {
  // `none` first: a publish-only device writes to no lamp, so whether it would
  // have pre-staged one is moot — and the runtime refuses the probe for it.
  if (!state.writesLights) return 'none';
  return state.preStage === true ? 'before' : 'after';
}

/**
 * Set the two flags from a chosen mode.
 *
 * `preStageLights` is KEPT when leaving "before", deliberately: somebody who
 * tries "Don't change" and comes back should not have to re-run a test they
 * already watched. The list pre-stages nothing unless `preStage` is true, so
 * keeping it costs nothing.
 */
function applyControlMode(state: ControlState, mode: ControlMode): void {
  state.writesLights = mode !== 'none';
  // Only touched where it exists: a Room-sensing Light's session has no such
  // field, and growing one here would be a flag its plan never stores.
  if (state.preStage !== undefined) state.preStage = mode === 'before';
}

export interface ControlOptions {
  /** False on a Room-sensing Light — see the module comment. */
  offerBefore: boolean;
  /**
   * The per-lamp test, against this session's own plan. Absent where
   * `offerBefore` is false: there is nothing to test.
   */
  probe?: () => Promise<{ lights: PreStageLampResult[]; reason?: string }>;
}

/**
 * `setControl` and, where "before" is offered, `testPreStage`.
 *
 * The test's result is written into the session straight away rather than
 * returned for the screen to send back: the list is what gets STORED, and a
 * list the screen could echo is a list the screen could invent.
 */
export function registerControlHandlers(
  handler: HandlerRegistrar,
  state: ControlState,
  options: ControlOptions,
): void {
  handler('setControl', async (payload: unknown) => {
    const mode = (payload as { mode?: unknown } | null)?.mode;
    if (!isControlMode(mode)) {
      throw new LocalisedError('errors.notAControlMode', { mode: String(mode) });
    }
    if (mode === 'before' && !options.offerBefore) {
      throw new LocalisedError('errors.cannotSetBefore');
    }
    applyControlMode(state, mode);
    return { mode: controlModeOf(state) };
  });

  const probe = options.probe;
  if (!options.offerBefore || !probe) return;

  handler('testPreStage', async () => {
    const outcome = await probe();
    state.tested = outcome.lights.map(lamp => ({ deviceId: lamp.deviceId, name: lamp.name, ok: lamp.ok }));
    state.preStageLights = outcome.lights.filter(lamp => lamp.ok).map(lamp => lamp.deviceId);
    return {
      lights: state.tested.map(({ name, ok }) => ({ name, ok })),
      restored: outcome.lights.filter(lamp => lamp.restored).length,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  });
}

/** What `review.html` draws under the rows. Built here; see `registerReviewHandler`. */
export interface ReviewControl {
  modes: ControlMode[];
  selected: ControlMode;
  /** How many lamps "Test my {n} lights" will test. */
  lightCount: number;
  /**
   * The result list, when there is one: this session's test, or — on a repair —
   * the stored list read back against today's lamps. `fresh` says which, so the
   * screen can say "Tested just now" only when it was.
   */
  tested?: { fresh: boolean; lights: Array<{ name: string; ok: boolean }> };
}

/**
 * The control as the review screen should draw it, from the session.
 *
 * On a repair nobody has tested anything in THIS session, but the plan carries
 * the lamps that passed last time — so those are read back against the lamps
 * the device drives today, a lamp added since reading as the fallback it is
 * until it is tested.
 */
export async function reviewControl(
  host: PairSessionHost,
  state: ControlState,
  offerBefore: boolean,
): Promise<ReviewControl> {
  const modes: ControlMode[] = offerBefore ? ['after', 'before', 'none'] : ['after', 'none'];
  const ids = state.target ? await targetDeviceIds(host.app.catalog, state.target) : [];
  // A mode this device cannot offer reads as the default rather than as a
  // radio group with nothing selected.
  const mode = controlModeOf(state);
  const selected = modes.includes(mode) ? mode : 'after';
  const control: ReviewControl = { modes, selected, lightCount: ids.length };
  if (!offerBefore) return control;

  // This session's test answers only for the lamps it tested. Go back, add a
  // lamp, and come here again, and the fresh list would be silent about it —
  // so a changed set of lamps is read back like a repair instead.
  const testedIds = new Set((state.tested ?? []).map(lamp => lamp.deviceId));
  const sameLamps = state.tested !== undefined
    && testedIds.size === ids.length && ids.every(id => testedIds.has(id));

  if (sameLamps) {
    control.tested = { fresh: true, lights: state.tested!.map(({ name, ok }) => ({ name, ok })) };
  } else if (state.preStageLights !== undefined && ids.length > 0) {
    const passed = new Set(state.preStageLights);
    const lights: Array<{ name: string; ok: boolean }> = [];
    for (const id of ids) {
      const device = await host.app.catalog.device(id);
      lights.push({ name: device?.name ?? id, ok: passed.has(id) });
    }
    control.tested = { fresh: false, lights };
  }
  return control;
}
