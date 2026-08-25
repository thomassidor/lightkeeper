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
  readonly recentEvents: Array<{
    at: number; cardId: string; controller: string; eventKey: string;
    magnitude?: number; accepted: boolean; reason?: string;
  }> = [];

  private recordEvent(entry: {
    cardId: string; controller: string; eventKey: string;
    magnitude?: number; accepted: boolean; reason?: string;
  }): void {
    this.recentEvents.unshift({ at: Date.now(), ...entry });
    if (this.recentEvents.length > 40) this.recentEvents.pop();
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
        void this.controllers?.onCredentialChange();
        // Schedules write Flows too, so a dead key degrades their maintenance in
        // exactly the same way — and a recovered one must bring them back
        // without a restart.
        void this.schedules?.onCredentialChange();
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
    this.controllers = new ControllerRuntimeManager({
      api: this.api,
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
      void this.controllers.onCatalogChange();
      void this.schedules.onCatalogChange();
      void this.circadian.onCatalogChange();
    });

    // A stored key must be re-checked after every restart, or pairing asks for
    // a key the user has already given. Deliberately not awaited: a slow or
    // unreachable Homey must not delay app start.
    void this.revalidateCredential();

    this.log('Lightkeeper initialised');
  }

  /** Proves the stored key can still WRITE, not merely read. */
  async revalidateCredential(): Promise<void> {
    if (!this.credentials.hasCredential()) {
      this.log('No API key stored yet');
      return;
    }
    const status = await this.credentials.revalidate(async (client: any) => {
      const folder = await client.flow.createFlowFolder({
        flowfolder: { name: 'Lightkeeper (checking permissions)' },
      });
      await client.flow.deleteFlowFolder({ id: folder.id });
    });
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
    await this.controllers?.destroyAll();
    await this.schedules?.destroyAll();
    await this.circadian?.destroyAll();
    await this.api?.destroy();
  }

};
