import { clamp01 } from './light-intent';

/** Spec §7.5 — optimistic desired state, per target. */
export interface TargetRuntimeState {
  actualOn?: boolean;
  actualDim?: number;
  actualTemperature?: number;
  desiredOn?: boolean;
  desiredDim?: number;
  desiredTemperature?: number;
  /** Restore-previous-brightness policy is reserved, but the value is cheap to keep. */
  lastNonZeroDim?: number;
  lastExternalUpdateAt?: number;
}

/** Capability metadata read per target — never assumed uniform (§7.1). */
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

  /** Seed from live device values at startup — never from persisted queues (§7.5). */
  initialise(deviceId: string, actual: { onoff?: boolean; dim?: number; light_temperature?: number }): void {
    const state = this.state(deviceId);
    state.actualOn = actual.onoff;
    state.actualDim = actual.dim;
    state.actualTemperature = actual.light_temperature;
    state.desiredOn = actual.onoff;
    state.desiredDim = actual.dim;
    state.desiredTemperature = actual.light_temperature;
    if (actual.dim !== undefined && actual.dim > 0) state.lastNonZeroDim = actual.dim;
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
        break;
      case 'dim':
        state.actualDim = value as number;
        if (typeof value === 'number' && value > 0) state.lastNonZeroDim = value;
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
      state.lastExternalUpdateAt = at;
      if (capability === 'onoff') state.desiredOn = value as boolean;
      if (capability === 'dim') state.desiredDim = value as number;
      if (capability === 'light_temperature') state.desiredTemperature = value as number;
      return true;
    }

    return false;
  }

  /** Record what we are about to write, so its echo is recognised. */
  noteWrite(deviceId: string, capability: 'onoff' | 'dim' | 'light_temperature', value: unknown): void {
    this.recentEchoes.set(`${deviceId}:${capability}`, { value, at: this.now() });
    const state = this.state(deviceId);
    if (capability === 'onoff') state.desiredOn = value as boolean;
    if (capability === 'dim') state.desiredDim = clamp01(value as number);
    if (capability === 'light_temperature') state.desiredTemperature = clamp01(value as number);
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

  forget(deviceId: string): void {
    this.states.delete(deviceId);
    this.capabilities.delete(deviceId);
    for (const key of [...this.recentEchoes.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.recentEchoes.delete(key);
    }
  }

  clear(): void {
    this.states.clear();
    this.capabilities.clear();
    this.recentEchoes.clear();
  }
}
