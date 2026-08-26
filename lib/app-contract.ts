import type { CredentialService, CredentialStatus } from './credential-service';
import type { HomeyApiService } from './homey-api-service';
import type { DeviceCatalog } from './device-catalog';
import type { SourceDiscoveryService } from './source-discovery-service';
import type { FlowBridgeManager } from './bridge/flow-bridge-manager';
import type { HealthMonitor } from './runtime/health-monitor';
import type { ControllerRuntimeManager } from './runtime/controller-runtime-manager';
import type { ScheduleRuntimeManager } from './schedules/schedule-runtime-manager';
import type { CircadianRuntimeManager } from './circadian/circadian-runtime-manager';
import type { BoundedLog } from './support/bounded-log';
import type { WriteRecord } from './outputs/light-target-adapter';
import type { ControllerDiagnostics } from './runtime/controller-runtime';
import type { ScheduleDiagnostics } from './schedules/schedule-runtime';
import type { CircadianDiagnostics } from './circadian/circadian-runtime';
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
 */
export interface BridgeEventRecord {
  at: number;
  cardId: string;
  controller: string;
  eventKey: string;
  magnitude?: number;
  accepted: boolean;
  reason?: string;
}

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
  /**
   * EVERY runtime's writes in one time-ordered log — the "did anything reach a
   * light" indicator for the whole Homey. It used to come from the first
   * controller only, which made it permanently empty on a Homey running nothing
   * but schedules. The per-device view is in `getDiagnostics`.
   */
  recentWrites: readonly WriteRecord[];
}

export interface ControllerSummary {
  id: string;
  state: string;
  sourceName: string | null;
  mappings: number;
  managedFlows: number;
  schedulerReady: boolean;
  targetNames: string[];
}

export interface ScheduleSummary {
  id: string;
  state: string;
  name: string;
  enabled: boolean;
  entries: unknown[];
  managedFlows: number;
  /** The Homey's own clock, echoed back: "it fired an hour late" is usually this. */
  timezone: string;
  timezoneResolved: boolean;
  localTime: string;
  targetNames: string[];
  lastAction: unknown;
}

export interface CircadianSummary {
  id: string;
  state: string;
  name: string;
  enabled: boolean;
  /** Where the curve is now and where it goes next — "this works" without dusk. */
  now: unknown;
  nextPoint: unknown;
  points: unknown[];
  timezone: string;
  localTime: string;
  targetNames: string[];
  /**
   * Lights somebody has taken over by hand. Shown because a light that stopped
   * following the curve on purpose looks exactly like one that stopped by
   * accident.
   */
  overridden: number;
  preStage: boolean;
  preStageDisabled: unknown;
}

export interface DiagnosticsResponse {
  generatedAt: number;
  app: { id: string; version: string };
  credential: CredentialStatus;
  recentEvents: readonly BridgeEventRecord[];
  controllers: ControllerDiagnostics[];
  schedules: ScheduleDiagnostics[];
  circadian: CircadianDiagnostics[];
  /**
   * Which of Homey's own trigger cards the schedules are built on, and what else
   * was on offer. A card URI may never be constructed (CLAUDE.md §3), so when a
   * firmware moves this card the candidate list IS the investigation.
   */
  timeCard: TimeCardDiscovery | { card: null; error: string };
}
