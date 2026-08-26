'use strict';

import Homey from 'homey';

import { CredentialService } from './lib/credential-service';
import { HomeyApiService } from './lib/homey-api-service';
import { DeviceCatalog } from './lib/device-catalog';
import { SourceDiscoveryService } from './lib/source-discovery-service';
import { FlowBridgeManager } from './lib/bridge/flow-bridge-manager';
import { ControllerRuntimeManager } from './lib/runtime/controller-runtime-manager';
import { HealthMonitor } from './lib/runtime/health-monitor';
import { ScheduleRuntimeManager } from './lib/schedules/schedule-runtime-manager';
import { CircadianRuntimeManager } from './lib/circadian/circadian-runtime-manager';
import { parseEventKey } from './lib/schedules/schedule-bindings';
import { flowWriteProbe } from './lib/credential-service';
import { fireAndForget } from './lib/support/async';
import { BoundedLog } from './lib/support/bounded-log';
import type { WriteRecord } from './lib/outputs/light-target-adapter';

/**
 * Lightkeeper.
 *
 * The App class owns: shared services, the Homey API clients,
 * bridge action listeners and runtime manager startup. Mapping logic and
 * source-specific parsing live in lib/.
 */
module.exports = class LightkeeperApp extends Homey.App {

  credentials!: CredentialService;
  api!: HomeyApiService;
  catalog!: DeviceCatalog;
  discovery!: SourceDiscoveryService;
  bridge!: FlowBridgeManager;
  controllers!: ControllerRuntimeManager;
  schedules!: ScheduleRuntimeManager;
  circadian!: CircadianRuntimeManager;
  health!: HealthMonitor;

  /**
   * Last received events. A generated Flow that fires but produces no
   * light change is otherwise undiagnosable from outside: this records whether
   * the bridge card was reached at all, and if it was rejected, why.
   */
  readonly recentEvents = new BoundedLog<{
    at: number; cardId: string; controller: string; eventKey: string;
    magnitude?: number; accepted: boolean; reason?: string;
  }>(40);

  /**
   * Every write attempted by every runtime, newest first.
   *
   * The settings page's "did anything reach a light" indicator used to read
   * the FIRST controller's own log, which is empty on a Homey that runs only
   * schedules and misleading on one that runs both — a household could watch
   * their schedule fire, look at the page, and see nothing. This is the whole
   * app's, in time order.
   *
   * Each runtime keeps its own log too, unchanged, because getDiagnostics
   * reports per device and "which of my four devices cannot reach its lights"
   * is a different question.
   */
  readonly recentWrites = new BoundedLog<WriteRecord>(50);

  private recordEvent(entry: {
    cardId: string; controller: string; eventKey: string;
    magnitude?: number; accepted: boolean; reason?: string;
  }): void {
    this.recentEvents.add({ at: Date.now(), ...entry });
  }

  private credentialFanOutTimer: NodeJS.Timeout | null = null;

  /**
   * Both Flow-writing registries, told once, on a trailing edge.
   *
   * The debounce is not politeness. The status flip that calls this is CAUSED
   * by a write, and at boot that write is the first reconcile's — so the
   * sequence is: runtime starts, reconciles, its first createFlow proves the
   * key, the status goes valid, and every runtime including the one still
   * mid-pass is asked to reconcile again. With N devices that is N reconciles
   * kicked off from inside N reconciles.
   *
   * Single-flight (FlowBridgeManager.reconcile) already makes each device's
   * overlapping passes converge to two; the trailing edge collapses the burst
   * of STATUS events itself, so the second pass runs once, after the storm,
   * against settled state.
   *
   * 250 ms: far longer than a boot storm's own inter-event gap, far shorter
   * than a person waiting for "I pasted a new key and nothing came back".
   */
  private fanOutCredentialChange(): void {
    if (this.credentialFanOutTimer !== null) this.homey.clearTimeout(this.credentialFanOutTimer);

    this.credentialFanOutTimer = this.homey.setTimeout(() => {
      this.credentialFanOutTimer = null;
      const log = (...args: unknown[]) => this.log(...args);
      if (this.controllers) {
        fireAndForget(this.controllers.onCredentialChange(), log, 'Controller credential fan-out');
      }
      if (this.schedules) {
        fireAndForget(this.schedules.onCredentialChange(), log, 'Schedule credential fan-out');
      }
      // Circadian lights are deliberately absent from this fan-out: they
      // generate no Flows, so no API key is involved in anything they do and
      // there is nothing here for them to recover from (CLAUDE.md §12).
    }, 250);
  }

  override async onInit() {
    this.credentials = new CredentialService({
      settings: {
        get: key => this.homey.settings.get(key),
        set: (key, value) => this.homey.settings.set(key, value),
        unset: key => this.homey.settings.unset(key),
      },
      createWriteClient: (address, token) => HomeyApiService.createWriteClient(address, token),
      // Inside an app this is http://127.0.0.1:80 — no LAN discovery needed.
      getLocalAddress: () => this.homey.api.getLocalUrl(),
      log: (...args) => this.log(...args),
      onStatusChange: status => {
        this.log(`Credential status: ${status.valid ? 'valid' : status.failure ?? 'absent'}`);
        this.fanOutCredentialChange();
        // Schedules write Flows too, so a dead key degrades their maintenance in
        // exactly the same way — and a recovered one must bring them back
        // without a restart. Both registries are notified from one debounced
        // fan-out — see fanOutCredentialChange().
        // Circadian lights are deliberately absent from this fan-out: they
        // generate no Flows, so no API key is involved in anything they do and
        // there is nothing here for them to recover from.
      },
    });

    this.api = new HomeyApiService(this.homey, this.credentials);
    this.catalog = new DeviceCatalog(this.api);
    this.discovery = new SourceDiscoveryService(this.api);
    this.bridge = new FlowBridgeManager(this.api, this.homey.manifest.id, (...args) => this.log(...args));
    this.health = new HealthMonitor(
      this.catalog,
      this.discovery,
      () => this.credentials.getStatus().valid,
    );
    // One shared sink, so a write from any runtime lands in one time-ordered
    // log. Wired here because this is the only place that can see all three.
    const onWriteResult = (entry: WriteRecord) => this.recentWrites.add(entry);

    this.controllers = new ControllerRuntimeManager({
      api: this.api,
      onWriteResult,
      catalog: this.catalog,
      discovery: this.discovery,
      bridge: this.bridge,
      // Without this the health checks never run outside the tests,
      // so an unpaired remote or a changed event surface stayed invisible until
      // the user pressed a button and nothing happened.
      health: this.health,
      log: (...args) => this.log(...args),
    });

    this.schedules = new ScheduleRuntimeManager({
      api: this.api,
      onWriteResult,
      catalog: this.catalog,
      bridge: this.bridge,
      // The SDK's only timezone primitive, and the one every schedule decision
      // is made against. Read per call rather than cached: a household that
      // corrects its Homey's timezone must not have to restart the app.
      timezone: () => {
        try {
          return this.homey.clock?.getTimezone();
        } catch {
          return undefined;
        }
      },
      log: (...args) => this.log(...args),
    });

    this.circadian = new CircadianRuntimeManager({
      api: this.api,
      onWriteResult,
      catalog: this.catalog,
      timezone: () => {
        try {
          return this.homey.clock?.getTimezone();
        } catch {
          return undefined;
        }
      },
      // The SDK's disposal-safe aliases: cleaned up with the Homey instance, so a
      // reloaded app cannot leave a timer behind writing to somebody's lights.
      // One interval for every circadian device — see the manager for why a curve
      // may use a timer where a schedule may not (CLAUDE.md §9).
      setInterval: (fn, ms) => this.homey.setInterval(fn, ms),
      clearInterval: handle => this.homey.clearInterval(handle as any),
      log: (...args) => this.log(...args),
    });

    this.registerBridgeCard('bridge_event');
    this.registerBridgeCard('bridge_numeric_event', args => Number(args.value));
    this.registerBridgeCard('bridge_token_event', args => Number(args.droptoken));

    // Zones and devices change under us; targets must follow. Every registry is
    // notified: watch() takes a single consumer, so the fan-out lives here.
    await this.catalog.watch(() => {
      const l = (...args: unknown[]) => this.log(...args);
      fireAndForget(this.controllers.onCatalogChange(), l, 'Controller catalogue change');
      fireAndForget(this.schedules.onCatalogChange(), l, 'Schedule catalogue change');
      fireAndForget(this.circadian.onCatalogChange(), l, 'Circadian catalogue change');
    });

    // A stored key must be re-checked after every restart, or pairing asks for
    // a key the user has already given. Deliberately not awaited: a slow or
    // unreachable Homey must not delay app start.
    fireAndForget(this.revalidateCredential(), (...args) => this.log(...args), 'Stored-key revalidation');

    this.log('Lightkeeper initialised');
  }

  /** Proves the stored key can still WRITE, not merely read. */
  async revalidateCredential(): Promise<void> {
    if (!this.credentials.hasCredential()) {
      this.log('No API key stored yet');
      return;
    }
    const status = await this.credentials.revalidate(
      (client: any) => flowWriteProbe(client, (...args: unknown[]) => this.log(...args)),
    );
    this.log(`Stored API key: ${status.valid ? 'valid' : status.failure}`);
  }

  /**
   * Generated flow arguments are user-editable and therefore untrusted.
   * Every incoming bridge argument is validated against an existing controller
   * and expected binding key before anything executes. On malformed or stale
   * input we fail closed: log and ignore, never execute heuristically.
   */
  private registerBridgeCard(cardId: string, magnitudeOf?: (args: any) => number) {
    const card = this.homey.flow.getActionCard(cardId);

    card.registerRunListener(async (args: any) => {
      const controllerId = String(args?.controller ?? '');
      const eventKey = String(args?.event_key ?? '');

      if (!controllerId || !eventKey) {
        this.recordEvent({ cardId, controller: controllerId, eventKey, accepted: false, reason: 'missing controller or event key' });
        this.log(`Ignoring ${cardId}: missing controller or event key`);
        return false;
      }

      const magnitude = magnitudeOf ? magnitudeOf(args) : undefined;
      const outcome = this.dispatchBridgeEvent(
        controllerId,
        eventKey,
        Number.isFinite(magnitude) ? magnitude : undefined,
      );

      this.recordEvent({
        cardId,
        controller: controllerId,
        eventKey,
        ...(Number.isFinite(magnitude) ? { magnitude } : {}),
        accepted: outcome.accepted,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });

      if (!outcome.accepted) {
        // A flow left behind by a deleted controller, or an edited event key.
        this.log(`Ignoring ${cardId}: ${outcome.reason}`);
        return false;
      }

      return true;
    });
  }

  /**
   * Route a validated bridge event to the registry that owns it.
   *
   * Two registries, not three: a circadian light has no Flows and therefore no
   * bridge events. It reacts to the lights themselves.
   *
   * Routed on the KEY'S SHAPE rather than by trying both registries: a schedule
   * boundary key is unmistakable, and asking the controller registry about one
   * first would produce a refusal reason about a missing mapping catalogue —
   * exactly the wrong sentence to leave in the diagnostics of a schedule that
   * did not fire.
   */
  private dispatchBridgeEvent(
    controllerId: string,
    eventKey: string,
    magnitude: number | undefined,
  ): { accepted: boolean; reason?: string } {
    if (parseEventKey(eventKey)) {
      return this.schedules.dispatchWithReason(controllerId, eventKey);
    }
    return this.controllers.dispatchWithReason(controllerId, eventKey, {
      ...(magnitude !== undefined ? { magnitude } : {}),
    });
  }

  override async onUninit() {
    // Never leave a light mid-ramp, a timer running or a listener attached.
    // The SDK's setTimeout is disposal-safe, but a pending fan-out would still
    // reconcile against registries that are being torn down.
    if (this.credentialFanOutTimer !== null) {
      this.homey.clearTimeout(this.credentialFanOutTimer);
      this.credentialFanOutTimer = null;
    }
    await this.controllers?.destroyAll();
    await this.schedules?.destroyAll();
    await this.circadian?.destroyAll();
    await this.api?.destroy();
  }

};
