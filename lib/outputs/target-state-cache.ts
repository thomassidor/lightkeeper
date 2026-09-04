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
 */
export function liveValuesOf(device: {
  capabilitiesObj?: Record<string, { value?: unknown } | undefined>;
}): LiveValues {
  const obj = device.capabilitiesObj;
  return {
    onoff: obj?.onoff?.value as boolean | undefined,
    dim: obj?.dim?.value as number | undefined,
    light_temperature: obj?.light_temperature?.value as number | undefined,
    light_hue: obj?.light_hue?.value as number | undefined,
    light_saturation: obj?.light_saturation?.value as number | undefined,
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
  /** Per device: when `onoff` last moved, from any cause. See lastOnOffChangeAt. */
  private readonly onOffObservedAt = new Map<string, number>();

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
        state.actualOn = value as boolean;
        // Recorded even for a duplicate echo: the question this answers is
        // "has this lamp's power been touched since our write", and an echo
        // of our own onoff write is still evidence of when.
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
    this.recentEchoes.set(key, { value, at: this.now() });
    const seq = (this.writeSeq.get(key) ?? 0) + 1;
    this.writeSeq.set(key, seq);
    return seq;
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

  /** Forget everything about one device. Used when it stops being a target. */
  forget(deviceId: string): void {
    this.states.delete(deviceId);
    this.capabilities.delete(deviceId);
    this.onOffObservedAt.delete(deviceId);
    for (const key of [...this.recentEchoes.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.recentEchoes.delete(key);
    }
    for (const key of [...this.writeSeq.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.writeSeq.delete(key);
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
