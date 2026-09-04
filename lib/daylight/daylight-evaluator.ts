import { solarElevation } from './solar-elevation';
import {
  brightnessFor, levelFromElevation, resolveLevel, type DaylightSource,
} from './daylight-response';
import { usableLocation, type DaylightResponse, type Location } from './daylight-types';
import type { LuminanceSource, WatchedSensor } from './luminance-source';

/**
 * The one object the four runtimes take, so that none of them knows about
 * geolocation, subscriptions or solar arithmetic.
 *
 * Everything below it is pure or is the shared subscription service; everything
 * above it just asks "what brightness, then". That seam is what lets a schedule
 * and a Curve light use this feature without either of them growing a dependency
 * on where the Homey is.
 *
 * `location` is injected as a closure for the same reason `timezone` is: `lib/`
 * has no access to `this.homey`, and `this.homey.geolocation.getLatitude()`
 * THROWS when the permission is missing rather than returning nothing — so the
 * try/catch belongs in `app.ts`, at the boundary, and what arrives here is
 * either a position or `null` (platform §16).
 */

export interface DaylightEvaluatorDeps {
  location: () => unknown;
  luminance: LuminanceSource;
  now?: () => number;
}

export interface DaylightVerdict {
  /** 0 = fully dark outside, 1 = fully bright. */
  level: number;
  /** Perceptual brightness 0–1, ready for toDevice() at write time. */
  brightness: number;
  source: DaylightSource;
  /** Degrees above the horizon, or null when there is no usable position. */
  elevation: number | null;
}

export interface SkyVerdict {
  elevation: number | null;
  level: number | null;
  location: Location | null;
}

export class DaylightEvaluator {
  constructor(private readonly deps: DaylightEvaluatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Read the position afresh every time rather than caching it.
   *
   * It is a synchronous accessor over a value that changes when somebody moves
   * house, and `ManagerGeolocation` fires a `location` event we would otherwise
   * have to subscribe to and invalidate against. Cheaper to ask.
   */
  private location(): Location | null {
    return usableLocation(this.deps.location());
  }

  /**
   * What one response asks for, right now.
   *
   * Never throws and never returns a NaN: every branch below it clamps, because
   * the caller is a tick that turns this into a `dim` write, and a NaN there is
   * a lamp told nothing at all with no error to show for it.
   */
  evaluate(response: DaylightResponse): DaylightVerdict {
    const position = this.location();
    const elevation = position === null
      ? null
      : solarElevation(position.latitude, position.longitude, this.now());

    const reading = response.sensors.length > 0
      ? this.deps.luminance.read(response.sensors)
      : null;

    const { level, source } = resolveLevel(response, { elevation, reading });
    return { level, brightness: brightnessFor(response, level), source, elevation };
  }

  /**
   * The sky on its own, for the settings page.
   *
   * Independent of any one device's response, because the question a person asks
   * when a room is the wrong brightness is "does this thing know where the sun
   * is at all" — and that is answerable without naming a device.
   */
  sky(): SkyVerdict {
    const position = this.location();
    if (position === null) return { elevation: null, level: null, location: null };

    const elevation = solarElevation(position.latitude, position.longitude, this.now());
    return { elevation, level: levelFromElevation(elevation), location: position };
  }

  /** Every sensor being watched, whichever device asked for it. */
  sensors(): WatchedSensor[] {
    return this.deps.luminance.watched();
  }
}
