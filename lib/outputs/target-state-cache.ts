import { clamp01 } from './light-intent';

/** Optimistic desired state, per target. */
export interface TargetRuntimeState {
  actualOn?: boolean;
  actualDim?: number;
  actualTemperature?: number;
  desiredOn?: boolean;
  desiredDim?: number;
  desiredTemperature?: number;
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
}

/**
 * Echoes arrive duplicated — observed on real hardware, where one `dim` write
 * produced two identical callbacks. Without a guard the cache would treat the
 * second as an external change, clobbering desired state mid-burst and (in
 * the ramp engine) cancelling ramps spuriously.
 */
const ECHO_DEDUPE_MS = 1500;

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

  supports(deviceId: string, capability: 'onoff' | 'dim' | 'light_temperature'): boolean {
    const caps = this.capabilities.get(deviceId);
    if (!caps) return false;
    return capability === 'onoff' ? caps.onoff : caps[capability] !== undefined;
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
  initialise(deviceId: string, actual: { onoff?: boolean; dim?: number; light_temperature?: number }): void {
    const state = this.state(deviceId);
    state.actualOn = actual.onoff;
    state.actualDim = actual.dim;
    state.actualTemperature = actual.light_temperature;
    state.desiredOn = actual.onoff;
    state.desiredDim = actual.dim;
    state.desiredTemperature = actual.light_temperature;
  }

  /**
   * A capability change arrived from Homey. Returns true when it represents a
   * genuine external change rather than the echo of our own write.
   */
  applyExternalChange(
    deviceId: string,
    capability: 'onoff' | 'dim' | 'light_temperature',
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
    }

    if (isDuplicate) return false;

    // A real external change (someone used the Hue app) must win, or desired
    // state drifts permanently out of step with the room.
    const matchesDesired = capability === 'onoff' ? state.desiredOn === value
      : capability === 'dim' ? state.desiredDim === value
        : state.desiredTemperature === value;

    if (!matchesDesired) {
      if (capability === 'onoff') state.desiredOn = value as boolean;
      if (capability === 'dim') state.desiredDim = value as number;
      if (capability === 'light_temperature') state.desiredTemperature = value as number;
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
  noteEcho(deviceId: string, capability: 'onoff' | 'dim' | 'light_temperature', value: unknown): number {
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
    capability: 'onoff' | 'dim' | 'light_temperature',
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
