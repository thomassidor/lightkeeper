import type { CredentialService, CredentialStatus } from './credential-service';
import type { IntakeRecord } from './bridge/bridge-event-intake';
import type { HomeyApiService } from './homey-api-service';
import type { DeviceCatalog } from './device-catalog';
import type { SourceDiscoveryService } from './source-discovery-service';
import type { FlowBridgeManager } from './bridge/flow-bridge-manager';
import type { HealthMonitor } from './runtime/health-monitor';
import type { ControllerRuntimeManager } from './runtime/controller-runtime-manager';
import type { ScheduleRuntimeManager } from './schedules/schedule-runtime-manager';
import type { CircadianRuntimeManager } from './circadian/circadian-runtime-manager';
import type { DaylightRuntimeManager } from './daylight/daylight-runtime-manager';
import type { DaylightEvaluator } from './daylight/daylight-evaluator';
import type { LuminanceSource } from './daylight/luminance-source';
import type { BoundedLog } from './support/bounded-log';
import type { WriteRecord } from './outputs/light-target-adapter';
import type { ControllerDiagnostics } from './runtime/controller-runtime';
import type { ScheduleDiagnostics } from './schedules/schedule-runtime';
import type { CircadianDiagnostics } from './circadian/circadian-runtime';
import type { DaylightDiagnostics } from './daylight/daylight-runtime';
import type { TimeCardDiscovery } from './schedules/time-card-discovery';

/**
 * The app, as everything outside it is allowed to see it.
 *
 * `app.ts` must stay `module.exports = class …` — a Homey entry point that uses
 * `export default` is not loaded at all — so there is no class to import a type
 * from. This interface is that type, written down once instead of `homey.app`
 * being `any` at eleven call sites in `api.ts` and three in the device layer.
 *
 * It is deliberately the PUBLIC surface and no more. Anything not listed here is
 * the app's own business, and a consumer reaching past it is a consumer that
 * should be asking for something to be added.
 */
export interface LightkeeperApp {
  readonly credentials: CredentialService;
  readonly api: HomeyApiService;
  readonly catalog: DeviceCatalog;
  readonly discovery: SourceDiscoveryService;
  readonly bridge: FlowBridgeManager;
  readonly controllers: ControllerRuntimeManager;
  readonly schedules: ScheduleRuntimeManager;
  /**
   * One registry for BOTH curve-driven device types — the circadian light and
   * the curve light. See app.ts for why they share it.
   */
  readonly curves: CircadianRuntimeManager;
  readonly daylights: DaylightRuntimeManager;
  /**
   * The daylight evaluator and the sensor service it reads.
   *
   * Both are on the public surface because the PAIRING SCREENS use them, not
   * only the runtimes: a driver has to answer "what does this response read
   * right now" before anything is saved, and a pairing session has to retain
   * its chosen sensors while its screen is open. Neither is reachable through a
   * registry.
   */
  readonly daylight: DaylightEvaluator;
  readonly luminance: LuminanceSource;
  readonly health: HealthMonitor;
  readonly recentEvents: BoundedLog<BridgeEventRecord>;
  readonly recentWrites: BoundedLog<WriteRecord>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * A bridge event as received, accepted or refused.
 *
 * A generated Flow that fires and produces no light change is otherwise
 * undiagnosable from outside the Homey: this is the record of whether the card
 * was reached at all, and if it was refused, why.
 *
 * DERIVED from what the intake actually produces, plus the timestamp `app.ts`
 * stamps on it. It used to restate all six fields, in a third place after the
 * intake and the app's own log — and a field renamed in one of them would have
 * failed silently, as an empty row on the settings page.
 */
export type BridgeEventRecord = { at: number } & IntakeRecord;

// ------------------------------------------------------------ API responses

/**
 * What `getStatus` returns, which is the settings page's whole contract.
 *
 * Written down because there is no schema between the two and the page is the
 * only consumer: a field renamed here and not there fails silently, as an empty
 * row rather than an error.
 */
export interface StatusResponse {
  credential: CredentialStatus;
  recentEvents: readonly BridgeEventRecord[];
  controllers: ControllerSummary[];
  schedules: ScheduleSummary[];
  circadian: CircadianSummary[];
  daylight: DaylightSummary[];
  /**
   * What the daylight feature reads right now, for the WHOLE Homey rather than
   * for any one device.
   *
   * Independent of a device on purpose: the question somebody asks when a room
   * is the wrong brightness is "does this thing know where the sun is at all",
   * and that is answerable — and is the fastest check that the geolocation
   * permission resolved — without naming a device. `null` means it does not
   * know, which is the answer worth showing.
   */
  sky: { elevation: number | null; level: number | null } | null;
  /** Every watched sensor, whichever device asked for it, with each reading's AGE. */
  sensors: Array<{
    deviceId: string; name: string; lux: number | null; at: number | null; available: boolean;
  }>;
  /**
   * EVERY runtime's writes in one time-ordered log — the "did anything reach a
   * light" indicator for the whole Homey. It used to come from the first
   * controller only, which made it permanently empty on a Homey running nothing
   * but schedules. The per-device view is in `getDiagnostics`.
   */
  recentWrites: readonly WriteRecord[];
}

/**
 * The four device summaries the settings page renders, DERIVED from each
 * runtime's own diagnostics rather than restated beside them.
 *
 * They were four hand-written interfaces listing the same field names as the
 * `*Diagnostics` shapes they are built from, and nine of those fields were typed
 * `unknown` — so they cost a second edit site and bought no type safety at the
 * one place a mismatch matters. `BridgeEventRecord` above is derived for exactly
 * this reason, and its comment says what restating costs: a renamed field
 * "would have failed silently, as an empty row on the settings page".
 *
 * Only the fields api.ts actually SHAPES are declared here:
 *
 *  - `id` — `controllerId` under the name the page uses.
 *  - `managedFlows` — a COUNT here, an array in diagnostics.
 *  - `overridden` — a count api.ts derives from `targets`; not in diagnostics.
 *  - `sourceName` — read off the profile, not from diagnostics.
 *
 * `api.ts` still copies field by field rather than spreading, and must keep
 * doing so: the explicit copy is what BOUNDS what reaches the settings page, and
 * diagnostics carries device and zone names by design. A spread would grow this
 * payload silently on every future diagnostics field.
 */
export type ControllerSummary =
  Pick<ControllerDiagnostics, 'state' | 'schedulerReady' | 'targetNames'>
  & {
    id: string;
    sourceName: string | null;
    mappings: number;
    /** A count, where diagnostics carries the references themselves. */
    managedFlows: number;
  };

export type ScheduleSummary =
  Pick<ScheduleDiagnostics,
  'state' | 'name' | 'enabled' | 'entries' | 'timezone' | 'timezoneResolved'
  | 'localTime' | 'targetNames' | 'lastAction'>
  & {
    id: string;
    managedFlows: number;
  };

export type CircadianSummary =
  Pick<CircadianDiagnostics,
  'state' | 'name' | 'enabled' | 'now' | 'nextPoint' | 'points' | 'timezone'
  | 'localTime' | 'targetNames' | 'preStage' | 'preStageDisabled'>
  & {
    id: string;
    /**
     * Lights somebody has taken over by hand — counted from `targets`, which is
     * why this is not Picked. Shown because a light that stopped following the
     * curve on purpose looks exactly like one that stopped by accident.
     */
    overridden: number;
  };

export type DaylightSummary =
  Pick<DaylightDiagnostics,
  'state' | 'name' | 'enabled' | 'now' | 'response' | 'targetNames' | 'sensors'>
  & {
    id: string;
    /** As above: counted from `targets`, not carried by diagnostics. */
    overridden: number;
  };

export interface DiagnosticsResponse {
  generatedAt: number;
  app: { id: string; version: string };
  credential: CredentialStatus;
  recentEvents: readonly BridgeEventRecord[];
  controllers: ControllerDiagnostics[];
  schedules: ScheduleDiagnostics[];
  circadian: CircadianDiagnostics[];
  daylight: DaylightDiagnostics[];
  /**
   * Which of Homey's own trigger cards the schedules are built on, and what else
   * was on offer. A card URI may never be constructed (platform §3), so when a
   * firmware moves this card the candidate list IS the investigation.
   *
   * `notLookedUp` rather than an error: reporting this must not PROVOKE the
   * lookup, which reads every trigger card on the Homey and raises the app's
   * memory floor for the rest of its run (platform §15). A running schedule has
   * already resolved it, so it is absent only when nothing needed it.
   */
  timeCard: TimeCardDiscovery | { card: null; error: string } | { card: null; notLookedUp: string };
}
