import { randomUUID } from 'node:crypto';

import { listTargetsPayload, resolveSummary } from './target-picker';
import { listSensorsPayload } from './sensor-picker';
import { validateTargetAgainstCatalog } from '../validation/pairing-dto';
import {
  DEFAULT_RESPONSE, MAX_LUX, MIN_LUX, sanitiseResponse, type DaylightResponse,
} from '../daylight/daylight-types';
import { messageOf } from '../support/homey-errors';
import type { LightkeeperApp } from '../app-contract';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * The pairing-session MECHANICS every driver repeats, lifted out of the five
 * `driver.ts` files so they can be tested.
 *
 * `lib/pairing/` already held every pairing DECISION — the light picker, the
 * sensor picker, the remote picker, the mapping sections, the default names.
 * What stayed behind in the drivers was the plumbing around those decisions, and
 * it was the same plumbing five times: ~1,030 of the five files' 1,768 lines
 * were byte-identical or one token apart. Nothing enforced that, because
 * platform §13 means a file containing `extends Homey.Driver` can never be
 * imported by a test — `require('homey')` resolves to the CLI, whose main
 * executes the CLI. So the daylight card's three handlers carried a comment
 * asserting they were identical on four drivers, and a comment is all that held
 * it.
 *
 * This is the same split `lib/devices/device-lifecycle.ts` made one layer down
 * and `lib/bridge/bridge-event-intake.ts` made for the bridge cards: every rule
 * here, taking its host as an argument; the SDK shell in the driver.
 *
 * What deliberately did NOT move: each driver's own `get`/`set` pair, its
 * `buildPlan`, its `SessionState`, its module docblock, and the Daylight
 * light's own `getDaylight` — which genuinely differs (`standalone: true`, a
 * target guard, and it retains on the way IN rather than only on the way out).
 */

/**
 * What a driver lends the shared mechanics.
 *
 * Deliberately not `Homey.Driver`: naming that type is what would make this
 * file unimportable by a test, which is the entire reason it exists. Four
 * members, all of which a plain object can supply.
 */
export interface PairSessionHost {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** `homey.__`. `lib/` has no access to it, so the host resolves keys. */
  translate(key: string): string;
  /** `homey.clock`, absent on a rig that has no Homey behind it. */
  clock?: { getTimezone(): string } | undefined;
  app: LightkeeperApp;
}

/**
 * A pair session, as the SDK hands it over.
 *
 * `any[]` and not `unknown[]`, which was tried: a handler declares the payload
 * IT expects — `(spec: unknown)`, `(name: string)`, `({ entryId, boundary })` —
 * and a parameter of type `unknown` is not assignable to any of those, so
 * `unknown[]` makes every real handler a type error. The view sends whatever it
 * sends and each handler is the thing that says what it wanted, which is the
 * documented shape of `any` at a Homey seam.
 */
export interface PairSession {
  setHandler(name: string, fn: (...args: any[]) => unknown): void;
}

/** The slice of a driver's session state the shared handlers touch. */
export interface SharedSessionState {
  target?: TargetSpec | undefined;
  daylight?: DaylightResponse | undefined;
}

/** Registers a named handler on the session. What `handler(...)` was. */
export type HandlerRegistrar = (
  name: string,
  fn: (...args: any[]) => Promise<unknown>,
) => void;

/**
 * Wrap every handler so failures reach the CLI log.
 *
 * A handler that throws inside a pairing view otherwise surfaces as a screen
 * that simply does nothing, which is impossible to diagnose from the outside.
 */
export function handlerRegistrar(host: PairSessionHost, session: PairSession): HandlerRegistrar {
  return (name, fn) => {
    session.setHandler(name, async (...args: any[]) => {
      try {
        const result = await fn(...args);
        host.log(`pair/${name} ok`);
        return result;
      } catch (error) {
        host.error(`pair/${name} failed:`, messageOf(error), (error as Error)?.stack);
        throw error;
      }
    });
  };
}

/**
 * This session's claim on the shared sensor service, and why it needs an id of
 * its own.
 *
 * The daylight card shows what each chosen sensor currently reads, and a sensor
 * nobody is subscribed to has no reading — so the session has to retain them
 * while it is open. `retain` is ref-counted and TOTAL per owner, so a fixed
 * string would make two people pairing at once release each other's sensors, and
 * either screen would silently start showing the sky.
 *
 * Pair it with `releaseOnDisconnect` below. Without that, abandoning a pairing
 * screen leaves a subscription on somebody's battery-powered motion sensor for
 * as long as the app runs.
 */
export function newSessionOwner(): string {
  return `pair-${randomUUID()}`;
}

/**
 * Give the sensors back when the screen closes, however it closes.
 *
 * Saved, cancelled or abandoned — all three arrive here, and all three must
 * release. A saved device retains its own sensors under its own device id, so
 * releasing this session's claim never takes a live device's subscription with
 * it; that is exactly what the ref count is for.
 */
export function releaseOnDisconnect(
  host: PairSessionHost,
  session: PairSession,
  sessionOwner: string,
): void {
  session.setHandler('disconnect', async () => {
    try {
      await host.app.luminance.release(sessionOwner);
    } catch (error) {
      host.error('Releasing the pairing session sensors failed:', messageOf(error));
    }
  });
}

/**
 * The Homey's own timezone, or null.
 *
 * `null` rather than a guess: a schedule refuses to fire on a clock it does not
 * trust, and every screen that shows a time says so instead of showing one that
 * might be an hour out.
 */
export function timezoneOf(host: PairSessionHost): string | null {
  try {
    return host.clock?.getTimezone() ?? null;
  } catch {
    return null;
  }
}

/**
 * The light picker's two handlers, which every driver has.
 *
 * `subtitleKey` is the only thing that differs between the five — one shared
 * `targets.html` serves all of them (platform §8), so the line that says WHICH
 * lights these are has to come from the driver. Resolved here through the host
 * rather than in `lib/`, which cannot translate.
 */
export function registerTargetHandlers(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  state: SharedSessionState,
  subtitleKey: string,
): void {
  handler('listTargets', async () => ({
    ...await listTargetsPayload(host.app.catalog, state.target),
    subtitle: host.translate(subtitleKey),
  }));

  handler('selectTargets', async (spec: unknown) => {
    // The pairing channel is a webview, so this is the same class of boundary
    // as a generated Flow's arguments: shape AND membership are checked before
    // anything is persisted. A well-formed id naming something that is not a
    // light saves a device that resolves to nothing.
    const target = await validateTargetAgainstCatalog(spec, host.app.catalog);
    state.target = target;
    return resolveSummary(host.app.catalog, target);
  });
}

/**
 * The three handlers the shared daylight card calls.
 *
 * Identical on the three drivers that carry the card as a SECTION of their own
 * screen — a schedule, a circadian light and a Curve light — and deliberately
 * separate from each driver's own `get`/`set` pair rather than folded into it.
 * That is what lets one view file serve four screens: the card fetches and
 * pushes its own response and never asks the surrounding screen to thread it
 * through.
 *
 * The Daylight light is NOT a caller. Its screen IS the card, so its
 * `getDaylight` reports `standalone: true`, guards on a chosen target, and
 * retains on the way in — three real differences, which is why it keeps its own.
 */
export function registerDaylightCardHandlers(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  state: SharedSessionState,
  sessionOwner: string,
): void {
  handler('listSensors', async () => listSensorsPayload(
    host.app.catalog, state.daylight?.sensors ?? [],
  ));

  handler('getDaylight', async () => {
    const response = state.daylight ?? DEFAULT_RESPONSE;
    return {
      // FALSE here: this card is a section of this driver's own screen, which
      // owns the Save and the Test. Only the Daylight light's own screen is
      // the card, and only there does it draw a footer.
      standalone: false,
      response,
      limits: { minLux: MIN_LUX, maxLux: MAX_LUX },
      now: host.app.daylight.evaluate(response),
      sky: host.app.daylight.sky(),
      sensorReadings: host.app.daylight.sensors(),
    };
  });

  handler('setDaylight', async (payload: unknown) => {
    const result = sanitiseResponse((payload as { response?: unknown })?.response ?? payload);
    for (const field of result.corrected) {
      host.log(`Corrected daylight ${field} to its default: the screen sent something unusable`);
    }
    state.daylight = result.response;

    // Retained before `now` can mean anything: a sensor nobody is subscribed
    // to has no reading, and the card would show the sky for a device that has
    // just been given a sensor.
    await host.app.luminance.retain(result.response.sensors, sessionOwner);

    return {
      response: result.response,
      corrected: result.corrected,
      now: host.app.daylight.evaluate(result.response),
      sensorReadings: host.app.daylight.sensors(),
    };
  });
}
