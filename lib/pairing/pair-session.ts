import { randomUUID } from 'node:crypto';

import { listTargetsPayload, resolveSummary } from './target-picker';
import { listSensorsPayload } from './sensor-picker';
import { deriveSuffixedName } from './derive-name';
import { mintDeviceId } from '../bridge/flow-bridge-manager';
import { flowWriteProbe } from '../credential-service';
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

/**
 * The API-key screen's two handlers, for the two device types that need a key.
 *
 * `nextView` is the only difference between the controller's copy and the
 * schedule's, and it has to be a parameter because the credential VIEW is a
 * byte-for-byte copy shared between the two drivers (platform §8) — so the view
 * cannot know what follows it, and the driver does.
 *
 * Only these two generate Flows, so only these two ever ask (platform §1 and
 * §12). The three curve-and-daylight types have no credential screen at all.
 */
export function registerCredentialHandlers(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  nextView: string,
): void {
  handler('getCredentialStatus', async () => ({
    ...host.app.credentials.getStatus(),
    nextView,
  }));

  handler('setCredential', async (token: string) => {
    // Validating with a READ is not enough: reads succeed on credentials that
    // cannot write. Prove a write, then immediately clean it up.
    return host.app.credentials.setCredential(
      token,
      (client: any) => flowWriteProbe(client, (...args: unknown[]) => host.log(...args)),
    );
  });
}

/**
 * The last screen's Save, and the default name that means it needs no text
 * field.
 *
 * Four drivers had this identically, differing in exactly two tokens — the id
 * prefix and the store key — plus a `deriveName` method each whose three-line
 * body differed only in two strings. Both are parameters now, and the four
 * `deriveName` methods are gone.
 *
 * `device` present means REPAIR: apply to the device already there and report
 * `updated`, so the caller does not create a second one. Absent means pairing,
 * and the returned shape is what Homey's `createDevice` consumes.
 *
 * The controller is deliberately not a caller. Its save carries the mapping
 * rules and a re-attach path, and is a different 28 lines.
 */
export function registerSaveHandler<TPlan>(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  state: SharedSessionState,
  options: {
    /** The repair target, if this session is repairing rather than pairing. */
    device?: { applyPlan(plan: TPlan): Promise<void> } | undefined;
    /** The device-id prefix. Typed by `mintDeviceId`, not by this file. */
    idPrefix: Parameters<typeof mintDeviceId>[0];
    /** Where the plan lands in the device store, and the migration chain's key. */
    storeKey: string;
    /** The two words that make the default name this device type's own. */
    naming: { fallback: string; suffix: string };
    buildPlan: () => TPlan;
  },
): void {
  handler('save', async (name: string) => {
    const plan = options.buildPlan();

    if (options.device) {
      await options.device.applyPlan(plan);
      return { updated: true };
    }

    return {
      created: true,
      device: {
        // Homey lets the user rename a device afterwards, which is the natural
        // place for it — so the last screen asks for nothing.
        name: name || await deriveSuffixedName(host.app.catalog, state.target, {
          fallback: options.naming.fallback,
          suffix: options.naming.suffix,
          zoneFallback: 'Zone',
        }),
        data: { id: mintDeviceId(options.idPrefix) },
        store: { [options.storeKey]: plan },
      },
    };
  });
}

/**
 * "Try it now" for the two curve-driven types, before anything is saved.
 *
 * The primary defence against a device that looks configured and does nothing:
 * both handlers build an EPHEMERAL runtime over the plan on screen, so there is
 * something to see before a device exists.
 *
 * `curvePlan` is the one difference between the circadian light and the Curve
 * light. A circadian light stores two ends and expands them through
 * `expandSimplePlan`; a Curve light stores the points already. Both arrive here
 * as the same shape, which is why one pair of handlers serves both.
 *
 * A Daylight light is not a caller: it has no pre-stage to prove, because a
 * `dim` write turns an off lamp on and a brightness-only device type has
 * nothing to pre-stage.
 */
export function registerCurvePreviewHandlers(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  curvePlan: () => Parameters<PairSessionHost['app']['curves']['ephemeral']>[0],
): void {
  handler('previewNow', async () => {
    const runtime = await host.app.curves.ephemeral(curvePlan());
    try {
      // Forced: the user pressed a button and is owed a visible change, even
      // where the lights happen to be close to the curve already.
      const outcome = await runtime.applyNow('preview', { force: true });
      // Drained, so the count reported is writes attempted rather than writes
      // queued behind the burst limit.
      await runtime.drain();
      return outcome;
    } finally {
      await runtime.stop();
    }
  });

  handler('testPreStage', async () => {
    // Proven on this household's own lights rather than assumed: a colour write
    // to an off lamp turns it on through some integrations (platform §6), and
    // this is the only way to find out which.
    const runtime = await host.app.curves.ephemeral(curvePlan());
    try {
      return await runtime.probePreStage();
    } finally {
      await runtime.stop();
    }
  });
}
