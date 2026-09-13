import { clamp01 } from './light-intent';
import type { Capability } from './intent-planner';

/** Optimistic desired state, per target. */
export interface TargetRuntimeState {
  actualOn?: boolean;
  actualDim?: number;
  actualTemperature?: number;
  desiredOn?: boolean;
  desiredDim?: number;
  desiredTemperature?: number;
  /**
   * Hue and saturation, tracked but never used for arithmetic.
   *
   * Nothing in the app plans a RELATIVE colour change — there is no "a bit more
   * blue" gesture and no colour ramp — so these exist for the echo dedupe and
   * for diagnostics, not for a delta. `light_mode` is a string and has no
   * numeric state at all; see the switch below.
   */
  actualHue?: number;
  actualSaturation?: number;
  desiredHue?: number;
  desiredSaturation?: number;
}

/**
 * The five capability values a target's live state is seeded from.
 *
 * Named, and read by `liveValuesOf()` below, because it was written out twice —
 * once in `target-resolver.ts`'s `primeCache()` and once in
 * `light-target-adapter.ts`'s `refresh()` — and the two DRIFTED. The adapter
 * passed three of the five, so a refresh blanked the hue and saturation
 * `primeCache()` had just seeded, and the next hue echo read as somebody
 * reaching for the vendor app. One shape and one reader make that impossible
 * rather than merely fixed.
 */
export interface LiveValues {
  onoff?: boolean;
  dim?: number;
  light_temperature?: number;
  light_hue?: number;
  light_saturation?: number;
}

/**
 * Pull those five off a device as `homey-api` handed it back.
 *
 * `capabilitiesObj` is optional all the way down because the client genuinely
 * may not send it, and every field is optional because a lamp need not have the
 * capability at all — an absent value must stay absent rather than becoming 0,
 * which is why nothing here coerces (CLAUDE.md: `Number(null)` is 0, and 0 lux
 * is pitch dark; the same trap, one axis over).
 *
 * Every field goes through `validCapabilityValue()` — the SAME guard
 * `applyExternalChange()` applies to a live report — so an unusable value is
 * absent here too. A bare `as number | undefined` does not coerce, but it does
 * mistype: a `null` from an integration that has not reported yet, or one whose
 * sensor battery is flat, arrived typed as `number` and was then read as a real
 * reading. A Daylight light's `aimFor` tests `=== undefined`, so `null` counted
 * as present, `toPerceptual(null)` clamped to 0, and the first tick wrote
 * `dim 0.01` to a LIT lamp before fading it back up. The docblock above always
 * claimed this; now the code does it.
 */
export function liveValuesOf(device: {
  capabilitiesObj?: Record<string, { value?: unknown } | undefined>;
}): LiveValues {
  const obj = device.capabilitiesObj;
  const usable = <T>(capability: Capability, value: unknown): T | undefined =>
    validCapabilityValue(capability, value) ? (value as T) : undefined;
  return {
    onoff: usable<boolean>('onoff', obj?.onoff?.value),
    dim: usable<number>('dim', obj?.dim?.value),
    light_temperature: usable<number>('light_temperature', obj?.light_temperature?.value),
    light_hue: usable<number>('light_hue', obj?.light_hue?.value),
    light_saturation: usable<number>('light_saturation', obj?.light_saturation?.value),
  };
}

/**
 * The smallest change a capability declaring `decimals` can represent, or
 * `undefined` where it declares none.
 *
 * `10^-decimals`, and that arithmetic was written out twice — in the intent
 * planner's `representableStep` and in the circadian runtime's `stepFor`.
 *
 * The MISS CASE deliberately stays at the call sites, because the two callers
 * mean opposite things by it and both are right. The planner treats `undefined`
 * as "nothing is being rounded away, so a zero is a zero the caller asked for" —
 * `litDim` and `advanceDim` both depend on that, and a helper defaulting to 0.01
 * would silently arm those safety nets on lamps that declare no resolution. The
 * runtime falls back to 0.01 as a deadband floor, because it needs SOME
 * threshold to compare against. So this returns `undefined` and lets each say
 * what it wants done about it.
 */
export function stepFromDecimals(decimals: number | undefined): number | undefined {
  if (decimals === undefined || !Number.isFinite(decimals)) return undefined;
  return Math.pow(10, -Math.max(0, Math.floor(decimals)));
}

/** Capability metadata read per target — never assumed uniform. */
export interface CapabilityOptions {
  min: number;
  max: number;
  step?: number;
  decimals?: number;
}

export interface TargetCapabilities {
  onoff: boolean;
  dim?: CapabilityOptions;
  light_temperature?: CapabilityOptions;
  light_hue?: CapabilityOptions;
  light_saturation?: CapabilityOptions;
  /**
   * Whether the lamp can be switched between colour and colour-temperature
   * modes. A boolean rather than options because it is an enum capability with
   * no range — and a lamp that has hue and saturation but no `light_mode` simply
   * has no temperature mode to switch out of.
   */
  light_mode?: boolean;
}

/**
 * Echoes arrive duplicated — observed on real hardware, where one `dim` write
 * produced two identical callbacks. Without a guard the cache would treat the
 * second as an external change, clobbering desired state mid-burst and (in
 * the ramp engine) cancelling ramps spuriously.
 */
const ECHO_DEDUPE_MS = 1500;

/**
 * How far a reported value must be from the one we wrote before it counts as
 * somebody overriding us, and how long after our own write a change is still
 * ours.
 *
 * The tolerance is comfortably above `light_temperature`'s own 0.01 resolution
 * (platform §6), so a bridge that rounds our 0.47 to 0.46 does not read as a
 * human reaching for the vendor app — and far below any change a person would
 * make on purpose.
 *
 * The settle window exists because `ECHO_DEDUPE_MS` above only covers an EXACT
 * repeat within 1.5 s: a bridge can report an intermediate value part-way
 * through a transition, and that is still our write arriving late.
 *
 * They live here, beside the echo dedupe they extend, because the circadian and
 * daylight runtimes each declared their own copy — the daylight one under the
 * comment "Both copied from the circadian runtime, because both mean the same
 * thing there", which is an argument for one definition rather than two.
 */
export const OVERRIDE_TOLERANCE = 0.03;
export const OVERRIDE_SETTLE_MS = 3000;

/**
 * How long a lamp is left alone after somebody takes it over by hand.
 *
 * There used to be no such thing. An override was cleared by either edge of
 * `onoff`, by the target leaving the plan, or by the runtime stopping, and by
 * nothing else — "switch it off and on again" was offered as the gesture for
 * giving a light back. That is a fine gesture and a terrible only one, because
 * it assumes the thing that raised the override was a person.
 *
 * From a 3.83-day recording on the reference Homey: one lamp accepted every
 * write, acknowledged it, and then reverted to its own fixed `dim 0.41` /
 * `light_temperature 0.83` ninety seconds later, every single time, whatever it
 * had been sent. Each revert read as a human, so its circadian device stood
 * down — for 23.6 h, then 23.1 h, then 15.5 h, 15.2 h, 11.0 h back to back.
 * ~88 of 93 recorded hours doing nothing at all, with the lamp on the whole
 * time and the device reporting `ready`.
 *
 * Four hours is the balance: long enough that someone who dimmed the lamps for
 * an evening is not fought over them, short enough that a lamp the app cannot
 * actually drive costs one evening rather than a week. It bounds the damage
 * without pretending to tell a stubborn bulb from a person — nothing available
 * here can do that, which is exactly why the escape hatch has to be time.
 */
export const OVERRIDE_EXPIRY_MS = 4 * 60 * 60 * 1000;

/**
 * Is a reported value within the tolerance of the one we wrote?
 *
 * A function rather than three open-coded `Math.abs(a - b) <= OVERRIDE_TOLERANCE`
 * comparisons, because in binary floating point that expression is not the
 * tolerance the docblock above describes:
 *
 * ```
 * Math.abs(0.83 - 0.86) === 0.030000000000000027   // > 0.03  -> "overridden"
 * Math.abs(0.10 - 0.13) === 0.03                   // <= 0.03 -> forgiven
 * ```
 *
 * So a lamp exactly one tolerance away was forgiven or not depending on where
 * on the 0..1 axis it sat. Seen in a real recording: a bridge reporting
 * `light_temperature` 0.83 against our 0.86 — three hundredths, precisely the
 * rounding this constant exists to absorb — was classified as a person reaching
 * for the vendor app, which under the override rules stands the runtime down.
 *
 * `EPSILON` is a slack far below `light_temperature`'s own 0.01 resolution
 * (platform §6), so it widens nothing a lamp can express; it only stops the
 * boundary landing on which side of a double's last bit the subtraction fell.
 */
const TOLERANCE_EPSILON = 1e-9;
export function withinOverrideTolerance(delta: number): boolean {
  return Math.abs(delta) <= OVERRIDE_TOLERANCE + TOLERANCE_EPSILON;
}

export function validCapabilityValue(capability: Capability, value: unknown): boolean {
  if (capability === 'onoff') return typeof value === 'boolean';
  if (capability === 'light_mode') return value === 'color' || value === 'temperature';
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export class TargetStateCache {
  private readonly states = new Map<string, TargetRuntimeState>();
  private readonly capabilities = new Map<string, TargetCapabilities>();
  private readonly recentEchoes = new Map<string, { value: unknown; at: number }>();
  /**
   * A monotonically increasing counter per (device, capability), handed out by
   * `noteEcho` and checked by `commitDesired`. Writes to one capability are
   * serialised by the scheduler, but a `drain()` and a fresh burst can still
   * overlap, and the loser must not commit.
   */
  private readonly writeSeq = new Map<string, number>();
  // Do not reuse a token after forget()/clear(): a late completion from the
  // old target lifetime must not finish a newly dispatched write to that id.
  private nextWriteSeq = 0;
  /** Per device: when `onoff` last moved, from any cause. See lastOnOffChangeAt. */
  private readonly onOffObservedAt = new Map<string, number>();
  private readonly powerTransitionAt = new Map<string, number>();
  private readonly dispatchedAt = new Map<string, number>();
  private readonly pendingWrites = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  setCapabilities(deviceId: string, capabilities: TargetCapabilities): void {
    this.capabilities.set(deviceId, capabilities);
  }

  capabilitiesOf(deviceId: string): TargetCapabilities | undefined {
    return this.capabilities.get(deviceId);
  }

  supports(deviceId: string, capability: Capability): boolean {
    const caps = this.capabilities.get(deviceId);
    if (!caps) return false;
    if (capability === 'onoff') return caps.onoff;
    // `light_mode` is a boolean, not options: it is an enum with no range.
    if (capability === 'light_mode') return caps.light_mode === true;
    return caps[capability] !== undefined;
  }

  state(deviceId: string): TargetRuntimeState {
    let state = this.states.get(deviceId);
    if (!state) {
      state = {};
      this.states.set(deviceId, state);
    }
    return state;
  }

  /** Last observed values, not optimistic desired state or a fresh device read. */
  reportedValues(deviceId: string): LiveValues {
    const state = this.state(deviceId);
    return {
      onoff: state.actualOn, dim: state.actualDim,
      light_temperature: state.actualTemperature,
      light_hue: state.actualHue, light_saturation: state.actualSaturation,
    };
  }

  /** Seed from live device values at startup — never from persisted queues. */
  initialise(deviceId: string, actual: LiveValues): void {
    const state = this.state(deviceId);
    state.actualOn = actual.onoff;
    state.actualDim = actual.dim;
    state.actualTemperature = actual.light_temperature;
    state.actualHue = actual.light_hue;
    state.actualSaturation = actual.light_saturation;
    state.desiredOn = actual.onoff;
    state.desiredDim = actual.dim;
    state.desiredTemperature = actual.light_temperature;
    state.desiredHue = actual.light_hue;
    state.desiredSaturation = actual.light_saturation;
  }

  /**
   * A capability change arrived from Homey. Returns true when it represents a
   * genuine external change rather than the echo of our own write.
   */
  applyExternalChange(
    deviceId: string,
    capability: Capability,
    value: unknown,
  ): boolean {
    // Bad reports must not poison actual/desired state, or null becomes an
    // apparent off/zero followed by a false manual override on the next report.
    if (!validCapabilityValue(capability, value)) return false;
    const at = this.now();
    const echoKey = `${deviceId}:${capability}`;
    const recent = this.recentEchoes.get(echoKey);
    const isDuplicate = recent !== undefined
      && recent.value === value
      && at - recent.at < ECHO_DEDUPE_MS;

    this.recentEchoes.set(echoKey, { value, at });

    const state = this.state(deviceId);
    switch (capability) {
      case 'onoff':
        if (state.actualOn !== value) this.powerTransitionAt.set(deviceId, at);
        state.actualOn = value as boolean;
        // The implied-on probe must honour every power report, including an
        // off report repeating the cached value. Override settling, however,
        // follows transitions so repeated reports cannot extend it forever.
        this.onOffObservedAt.set(deviceId, at);
        break;
      case 'dim':
        state.actualDim = value as number;
        break;
      case 'light_temperature':
        state.actualTemperature = value as number;
        break;
      case 'light_hue':
        state.actualHue = value as number;
        break;
      case 'light_saturation':
        state.actualSaturation = value as number;
        break;
      case 'light_mode':
        // A string with no arithmetic behind it. Tracked only through the echo
        // dedupe above, which is the only reason this arm exists at all — and it
        // exists explicitly so an added capability cannot fall through silently.
        break;
    }

    if (isDuplicate) return false;

    // A real external change (someone used the Hue app) must win, or desired
    // state drifts permanently out of step with the room.
    const matchesDesired = desiredOf(state, capability) === value;

    if (!matchesDesired) {
      if (capability === 'onoff') state.desiredOn = value as boolean;
      if (capability === 'dim') state.desiredDim = value as number;
      if (capability === 'light_temperature') state.desiredTemperature = value as number;
      if (capability === 'light_hue') state.desiredHue = value as number;
      if (capability === 'light_saturation') state.desiredSaturation = value as number;
      // `light_mode` has no desired state, so a change to it is reported as
      // external every time — which is right: it is either our write's echo
      // (caught above) or somebody switching the lamp's mode by hand.
      return true;
    }

    return false;
  }

  /**
   * A write is about to go out: remember the value so its echo is recognised
   * as ours rather than as somebody using the Hue app.
   *
   * Deliberately does NOT touch desired state, and the split is the point.
   * Registering the echo has to happen BEFORE dispatch, because a fast
   * integration can call back before `setCapabilityValue` even resolves.
   * Committing the desired value has to happen AFTER, because a write that
   * fails did not change the lamp — and a desired value committed for a write
   * that never landed is a fiction the next relative step then plans from.
   *
   * Returns a write SEQUENCE for the (device, capability). Hand it back to
   * `commitDesired` and a write that lost a race cannot clobber the newer
   * value that beat it home.
   */
  noteEcho(deviceId: string, capability: Capability, value: unknown): number {
    const key = `${deviceId}:${capability}`;
    this.dispatchedAt.set(key, this.now());
    this.recentEchoes.set(key, { value, at: this.now() });
    const seq = ++this.nextWriteSeq;
    this.writeSeq.set(key, seq);
    this.pendingWrites.set(key, seq);
    return seq;
  }

  finishWrite(deviceId: string, capability: Capability, seq: number): void {
    const key = `${deviceId}:${capability}`;
    if (this.pendingWrites.get(key) !== seq) return;
    this.pendingWrites.delete(key);
    this.dispatchedAt.set(key, this.now());
  }

  /**
   * A write LANDED: adopt its value as the desired state.
   *
   * `seq` is the value `noteEcho` returned for this write. If a later write to
   * the same device and capability has been dispatched since, this one no
   * longer describes what the lamp is being asked to do, and committing it
   * would walk the desired value backwards — a slow first write finishing
   * after a fast second one is exactly how a dial ends up reporting the level
   * it passed through rather than the one it stopped at.
   *
   * Omit `seq` where there is no write at all: `planBrightnessDelta`'s
   * off-branch adopts a level for a lamp it deliberately does not write to.
   */
  commitDesired(
    deviceId: string,
    capability: Capability,
    value: unknown,
    seq?: number,
  ): void {
    if (seq !== undefined) {
      this.finishWrite(deviceId, capability, seq);
      const current = this.writeSeq.get(`${deviceId}:${capability}`) ?? 0;
      if (seq !== current) return;
    }
    const state = this.state(deviceId);
    if (capability === 'onoff') {
      // A power write we made ourselves counts as the lamp's power moving —
      // an explicit "off" landing after a dim-with-impliesOn is somebody
      // saying no, and the probe must see it even before the echo arrives.
      if (state.desiredOn !== value) this.onOffObservedAt.set(deviceId, this.now());
      state.desiredOn = value as boolean;
    }
    if (capability === 'dim') state.desiredDim = clamp01(value as number);
    if (capability === 'light_temperature') state.desiredTemperature = clamp01(value as number);
    if (capability === 'light_hue') state.desiredHue = clamp01(value as number);
    if (capability === 'light_saturation') state.desiredSaturation = clamp01(value as number);
    // `light_mode` deliberately absent: a string, and nothing plans from it.
  }

  /**
   * When this device's `onoff` last MOVED, in either direction, from any
   * cause: a change observed over the subscription, or one we committed
   * ourselves.
   *
   * The implied-on probe is what needs it. It fires 1.5 s after a dim write to
   * check whether the lamp came up by itself, and 1.5 s is long enough for a
   * person to reach a wall switch — so the question it has to answer first is
   * "has this lamp's power been touched SINCE our write", and only a timestamp
   * can answer it:
   *
   *  - the desired value cannot: the lamp being off is the STARTING state for
   *    a dim-with-impliesOn, which is the whole case the feature exists for.
   *  - the actual value cannot either: off and on again leaves it exactly
   *    where our write wanted it.
   */
  lastOnOffChangeAt(deviceId: string): number | undefined {
    return this.onOffObservedAt.get(deviceId);
  }

  /** Startup restoration and in-flight writes precede successful bookkeeping.
   * Their intermediate reports are not evidence of an external override. */
  overrideSuppression(deviceId: string, capability: Capability): string | null {
    if (this.pendingWrites.has(`${deviceId}:${capability}`)) return 'write_pending';
    const powerAt = this.powerTransitionAt.get(deviceId);
    if (powerAt !== undefined && this.now() - powerAt < OVERRIDE_SETTLE_MS) return 'power_settling';
    const writeAt = this.dispatchedAt.get(`${deviceId}:${capability}`);
    if (writeAt !== undefined && this.now() - writeAt < OVERRIDE_SETTLE_MS) return 'write_settling';
    return null;
  }

  /** Forget everything about one device. Used when it stops being a target. */
  forget(deviceId: string): void {
    this.states.delete(deviceId);
    this.capabilities.delete(deviceId);
    this.onOffObservedAt.delete(deviceId);
    this.powerTransitionAt.delete(deviceId);
    for (const key of [...this.recentEchoes.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.recentEchoes.delete(key);
    }
    for (const key of [...this.writeSeq.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.writeSeq.delete(key);
    }
    for (const key of this.dispatchedAt.keys()) {
      if (key.startsWith(`${deviceId}:`)) this.dispatchedAt.delete(key);
    }
    for (const key of this.pendingWrites.keys()) {
      if (key.startsWith(`${deviceId}:`)) this.pendingWrites.delete(key);
    }
  }

  /** Desired value if known, else the last actual — never a read-modify-write. */
  currentDim(deviceId: string): number | undefined {
    const state = this.state(deviceId);
    return state.desiredDim ?? state.actualDim;
  }

  currentTemperature(deviceId: string): number | undefined {
    const state = this.state(deviceId);
    return state.desiredTemperature ?? state.actualTemperature;
  }

  currentOn(deviceId: string): boolean | undefined {
    const state = this.state(deviceId);
    return state.desiredOn ?? state.actualOn;
  }

  clear(): void {
    this.states.clear();
    this.capabilities.clear();
    this.recentEchoes.clear();
    this.writeSeq.clear();
    this.onOffObservedAt.clear();
    this.powerTransitionAt.clear();
    this.dispatchedAt.clear();
    this.pendingWrites.clear();
  }
}

/**
 * The desired value for one capability, or undefined where none is tracked.
 *
 * Extracted from a nested ternary that had grown a silent default: with three
 * capabilities, `else` meant `light_temperature`, so adding a fourth would have
 * compared a hue against a colour temperature and quietly decided they matched.
 */
function desiredOf(state: TargetRuntimeState, capability: Capability): unknown {
  switch (capability) {
    case 'onoff': return state.desiredOn;
    case 'dim': return state.desiredDim;
    case 'light_temperature': return state.desiredTemperature;
    case 'light_hue': return state.desiredHue;
    case 'light_saturation': return state.desiredSaturation;
    // No desired state, so nothing can match it. See applyExternalChange.
    case 'light_mode': return undefined;
  }
}
