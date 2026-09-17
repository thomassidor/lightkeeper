'use strict';

import { EvidenceFeature } from './lib/support/evidence-feature';
import type { LightkeeperApp } from './lib/app-contract';
import Homey from 'homey';

import { CredentialService } from './lib/credential-service';
import { HomeyApiService } from './lib/homey-api-service';
import { DeviceCatalog } from './lib/device-catalog';
import { SourceDiscoveryService } from './lib/source-discovery-service';
import { FlowCardCatalogue } from './lib/flow-card-catalogue';
import { FlowBridgeManager } from './lib/bridge/flow-bridge-manager';
import { ControllerRuntimeManager } from './lib/runtime/controller-runtime-manager';
import { HealthMonitor } from './lib/runtime/health-monitor';
import { ScheduleRuntimeManager } from './lib/schedules/schedule-runtime-manager';
import { CircadianRuntimeManager } from './lib/circadian/circadian-runtime-manager';
import { LuminanceSource } from './lib/daylight/luminance-source';
import { DaylightEvaluator } from './lib/daylight/daylight-evaluator';
import { DaylightRuntimeManager } from './lib/daylight/daylight-runtime-manager';
import {
  intakeBridgeEvent, type IntakeRecord, type MagnitudeReader,
} from './lib/bridge/bridge-event-intake';
import { flowWriteProbe } from './lib/credential-service';
import { fireAndForget } from './lib/support/async';
import { BoundedLog } from './lib/support/bounded-log';
import type { WriteRecord } from './lib/outputs/light-target-adapter';
import { messageOf } from './lib/support/homey-errors';
import { markPhase, sampleHeap } from './lib/support/heap-report';
import { timezoneOf } from './lib/time/local-clock';
import { FlowLightWriter } from './lib/flow/light-writer';
import { isPowerChoice, planSetLights, LEAVE_ALONE, type ColourSource, type ValueSource } from './lib/flow/set-lights';
import { lightChoices, matching, parseTargetChoice, sourceChoices } from './lib/flow/flow-arguments';
import { isDarkEnough } from './lib/flow/darkness-condition';

/**
 * The first mark, and it has to be HERE rather than in `onInit`.
 *
 * Every import above has already run by this line — the app's ~100 modules and,
 * through them, `homey-api` — so this reading is the floor the app starts from
 * before a single line of its own logic executes. `onInit` cannot see it, which
 * is exactly why "the app uses N MB" was never attributable.
 */
/** How often the heap trend is sampled. See where it is started, in `onInit`. */
const HEAP_SAMPLE_MS = 30 * 60_000;

markPhase('modules-loaded');

/**
 * Lightkeeper.
 *
 * The App class owns: shared services, the Homey API clients,
 * bridge action listeners and runtime manager startup. Mapping logic and
 * source-specific parsing live in lib/.
 */
const LightkeeperAppImpl = class LightkeeperApp extends Homey.App {

  evidence!: EvidenceFeature;

  credentials!: CredentialService;
  api!: HomeyApiService;
  catalog!: DeviceCatalog;
  /**
   * ONE flow card catalogue for the whole app.
   *
   * Shared rather than one per consumer because the thing being shared is a
   * ~11.6 MB read (platform §15): source discovery, the schedule registry's
   * time-card lookup and the bridge's own card resolution all ask about the
   * same cards, and at boot they ask at once.
   */
  cards!: FlowCardCatalogue;
  discovery!: SourceDiscoveryService;
  bridge!: FlowBridgeManager;
  controllers!: ControllerRuntimeManager;
  schedules!: ScheduleRuntimeManager;
  /**
   * ONE registry, TWO device types.
   *
   * A circadian light and a Colour Curve Light are the same engine — the difference is
   * only what each stores and which pairing screen it shows. Sharing the registry
   * is what keeps §12's "one `setInterval` for every circadian device on the
   * Homey" true across both, rather than two timers over two maps.
   *
   * Named `curves` because a curve is what both of them run; `circadian` stays as
   * an alias because the settings page and the diagnostics export both read it.
   */
  curves!: CircadianRuntimeManager;

  /**
   * The daylight feature's three app-level objects, and why all three are here
   * rather than inside the manager that mostly uses them.
   *
   * `luminance` holds one ref-counted subscription per light sensor for the
   * WHOLE app: a Room-sensing Light, three schedules and a Colour Curve Light may every one
   * of them name the sensor in the hall, and five listeners on one battery
   * device is five teardowns to get right.
   *
   * `daylight` is the evaluator over it — the seam that means no runtime knows
   * about geolocation or solar arithmetic. FOUR consumers: the daylight manager,
   * the schedule and curve managers (whose plans may carry a response), and the
   * pairing screens, which show what it currently reads.
   *
   * `daylights` is the registry of live Room-sensing Lights, and owns the second
   * `setInterval` in this app. (There is a third, in `onInit`, which samples the
   * heap and belongs to no device.)
   */
  luminance!: LuminanceSource;
  daylight!: DaylightEvaluator;
  daylights!: DaylightRuntimeManager;
  health!: HealthMonitor;

  /**
   * The write path behind the `set_lights` Flow card.
   *
   * One for the app rather than one per invocation, and it belongs to no device:
   * the card can be pointed at any lights in the house, including lights no
   * Lightkeeper device owns. See its own header.
   */
  lights!: FlowLightWriter;

  /**
   * Last received events. A generated Flow that fires but produces no
   * light change is otherwise undiagnosable from outside: this records whether
   * the bridge card was reached at all, and if it was rejected, why.
   */
  readonly recentEvents = new BoundedLog<{ at: number } & IntakeRecord>(40);

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
      // there is nothing here for them to recover from (platform §12).
    }, 250);
  }

  override async onInit() {
    // Three marks, and the gap between the first two is the point: everything
    // this app's modules cost is already spent before this line runs.
    markPhase('onInit-start');
    this.evidence = new EvidenceFeature({
      settings: { get: key => this.homey.settings.get(key),
        set: (key, value) => this.homey.settings.set(key, value),
        unset: key => this.homey.settings.unset(key) },
      context: () => this.evidenceContext(),
      sample: () => ({
        runtimes: [
          ...this.controllers.all().map(runtime => ({ kind: 'controller', runtime, configuration: runtime.currentProfile })),
          ...this.schedules.all().map(runtime => ({ kind: 'schedule', runtime, configuration: runtime.currentPlan })),
          ...this.curves.all().map(runtime => ({ kind: 'curve', runtime, configuration: runtime.currentPlan })),
          ...this.daylights.all().map(runtime => ({ kind: 'daylight', runtime, configuration: runtime.currentPlan })),
        ],
        sensors: this.luminance.watched(),
        credential: this.credentials.getStatus(),
      }),
      setInterval: (fn, ms) => this.homey.setInterval(fn, ms),
      clearInterval: timer => this.homey.clearInterval(timer),
      log: (...args) => this.log(...args),
    });
    await this.evidence.init();
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
    this.catalog = new DeviceCatalog(this.api, this.homey.manifest.id);
    this.cards = new FlowCardCatalogue(this.api);
    this.discovery = new SourceDiscoveryService(this.api, this.cards);
    this.bridge = new FlowBridgeManager(
      this.api, this.homey.manifest.id, (...args) => this.log(...args), this.cards, this.homey.settings,
    );
    this.health = new HealthMonitor(
      this.catalog,
      this.discovery,
      () => this.credentials.getStatus().valid,
      /**
       * Every remote a LIVE controller is already listening to.
       *
       * Read lazily through a closure rather than passed as a set, because
       * `this.controllers` does not exist yet at this point and the answer
       * changes every time a device is added or removed. Wired here for the
       * same reason the write sink is: this is the only place that can see the
       * registry and the monitor at once.
       *
       * See `sourcesInUse` in `health-monitor.ts` for what it prevents — a
       * household with two identical remotes being offered a one-tap re-attach
       * onto the one that is still driving another controller.
       */
      () => new Set(this.controllers.all().map(runtime => runtime.currentProfile.source.deviceId)),
    );
    // One shared sink, so a write from any runtime lands in one time-ordered
    // log. Wired here because this is the only place that can see all three.
    const onWriteResult = (entry: WriteRecord) => {
      this.recentWrites.add(entry);
      this.evidence.record('write_result', entry);
    };

    this.luminance = new LuminanceSource({
      onEvidence: this.evidence.sink,
      api: this.api,
      catalog: this.catalog,
      log: (...args) => this.log(...args),
    });

    this.daylight = new DaylightEvaluator({
      location: () => this.location(),
      luminance: this.luminance,
    });

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
      cards: this.cards,
      // See `timezoneOf`: read per call, never cached, and `undefined` rather
      // than a guess when the Homey cannot say.
      timezone: () => timezoneOf(this.homey.clock),
      log: (...args) => this.log(...args),
    });

    this.curves = new CircadianRuntimeManager({
      onEvidence: this.evidence.sink,
      api: this.api,
      onWriteResult,
      catalog: this.catalog,
      // Where the Homey is, for the boundaries a circadian light anchors to the
      // sun. Read per call so a corrected location needs no restart.
      location: () => this.location(),
      timezone: () => timezoneOf(this.homey.clock),
      // The SDK's disposal-safe aliases: cleaned up with the Homey instance, so a
      // reloaded app cannot leave a timer behind writing to somebody's lights.
      // One interval for every circadian device — see the manager for why a curve
      // may use a timer where a schedule may not (platform §9).
      setInterval: (fn, ms) => this.homey.setInterval(fn, ms),
      clearInterval: handle => this.homey.clearInterval(handle as any),
      log: (...args) => this.log(...args),
    });

    this.daylights = new DaylightRuntimeManager({
      onEvidence: this.evidence.sink,
      api: this.api,
      onWriteResult,
      catalog: this.catalog,
      daylight: this.daylight,
      luminance: this.luminance,
      // The SDK's disposal-safe aliases, as above. The second of the two DEVICE
      // intervals in this app, and deliberately not shared with the curve one:
      // see the manager's header for why these are two registries rather than
      // one.
      setInterval: (fn, ms) => this.homey.setInterval(fn, ms),
      clearInterval: handle => this.homey.clearInterval(handle as any),
      log: (...args) => this.log(...args),
    });

    this.lights = new FlowLightWriter({
      api: this.api,
      catalog: this.catalog,
      onWriteResult,
      log: (...args) => this.log(...args),
    });

    this.registerBridgeCard('bridge_event');
    this.registerBridgeCard('bridge_numeric_event', args => Number(args.value));
    this.registerBridgeCard('bridge_token_event', args => Number(args.droptoken));
    this.registerSetLightsCard();
    this.registerDarknessCondition();

    // Zones and devices change under us; targets must follow. Every registry is
    // notified: watch() takes a single consumer, so the fan-out lives here.
    await this.catalog.watch(() => {
      const l = (...args: unknown[]) => this.log(...args);
      fireAndForget(this.controllers.onCatalogChange(), l, 'Controller catalogue change');
      fireAndForget(this.schedules.onCatalogChange(), l, 'Schedule catalogue change');
      fireAndForget(this.curves.onCatalogChange(), l, 'Circadian and curve catalogue change');
      fireAndForget(this.daylights.onCatalogChange(), l, 'Daylight catalogue change');
      // The sensor service too, and it is NOT covered by the line above. A
      // sensor's availability arrives on these device events rather than over a
      // capability subscription, so without this a sensor whose battery died
      // went on being averaged with its last reading for as long as the app ran.
      fireAndForget(this.luminance.onCatalogChange(), l, 'Luminance catalogue change');
    });

    // A stored key must be re-checked after every restart, or pairing asks for
    // a key the user has already given. Deliberately not awaited: a slow or
    // unreachable Homey must not delay app start.
    fireAndForget(this.revalidateCredential(), (...args) => this.log(...args), 'Stored-key revalidation');

    /**
     * The THIRD interval in this app, and the only one that is not about a
     * device.
     *
     * `heapReport()` answers "how much memory is this app using" and cannot
     * answer "is that number going anywhere", which is the only form of the
     * question worth asking — a single reading cannot tell steady state from a
     * slow climb. Answering it used to need two `/diagnostics` pulls hours apart,
     * by hand, on a real Homey, which is a thing nobody remembers to do.
     *
     * Half an hour, and a 48-entry ring, so `/diagnostics` always carries a
     * day of slope. It is NOT hung off the curve or daylight interval, which
     * were the two candidates that would have cost no timer: both stop when the
     * last device of their kind is removed, and an app with no devices at all is
     * exactly the baseline a climb has to be measured against (platform §15's
     * control-app method is the same argument). It costs one
     * `v8.getHeapStatistics()` call per half hour, which does not read `/proc`.
     *
     * `homey.setInterval`, like the other two: disposal-safe, so a reloaded app
     * cannot leave it behind.
     */
    this.homey.setInterval(() => sampleHeap(), HEAP_SAMPLE_MS);
    sampleHeap();

    this.evidence.startTimer();
    markPhase('onInit-end');
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
   * Register one bridge action card. The SHELL only.
   *
   * Every rule — the coercion, the fail-closed refusal, the magnitude, and which
   * registry a key belongs to — is `intakeBridgeEvent` in
   * `lib/bridge/bridge-event-intake.ts`, because this class `extends Homey.App`
   * and no test can import it (platform §13). "Bridge arguments are untrusted"
   * is one of CLAUDE.md's stated safety properties and it had no test at all
   * while it lived here.
   */
  /**
   * The `set_lights` card. The SHELL only, exactly like the bridge cards above.
   *
   * Every decision is in `lib/flow/` — what the three pickers offer
   * (`flow-arguments.ts`), what a chosen pair of devices asks for
   * (`set-lights.ts`), and how it reaches the lamps (`light-writer.ts`) — for
   * the same reason: this class `extends Homey.App` and no test can import it
   * (platform §13).
   */
  private registerSetLightsCard(): void {
    const card = this.homey.flow.getActionCard('set_lights');
    const labels = () => ({
      leaveAlone: this.homey.__('flow.leaveAlone'),
      leaveAloneHint: this.homey.__('flow.leaveAloneHint'),
    });

    card.registerArgumentAutocompleteListener('lights', async (query: string) =>
      matching(await lightChoices(this.catalog, { room: this.homey.__('flow.room') }), query));

    card.registerArgumentAutocompleteListener('colour', async (query: string) =>
      matching(sourceChoices(this.namedRuntimes(this.curves.all()), labels()), query));

    card.registerArgumentAutocompleteListener('brightness', async (query: string) =>
      matching(sourceChoices(this.namedRuntimes([
        ...this.daylights.all(), ...this.curves.all(), ...this.schedules.all(),
      ]), labels()), query));

    card.registerRunListener(async (args: any) => {
      const spec = parseTargetChoice(args?.lights?.id);
      if (!spec) {
        this.log('Ignoring set_lights: the chosen lights are not a target this app can read');
        return false;
      }

      // An unreadable dropdown falls to the cautious half, not the one that can
      // switch a household's lights on.
      const power = isPowerChoice(args?.power) ? args.power : 'only_on';

      const missing: string[] = [];
      const colour = this.colourSourceFor(args?.colour?.id, missing);
      const brightness = this.brightnessSourceFor(args?.brightness?.id, missing);

      const result = await this.lights.apply(
        spec, planSetLights({ colour, brightness, missing }, power), power,
      );
      if (result.refused) {
        this.log(`Ignoring set_lights: ${result.refused}`);
        return false;
      }
      this.log(`set_lights: ${result.writes} write(s), ${result.skipped} skipped`);
      return true;
    });
  }

  /** A Room-sensing Light's own reading, offered to anybody else's Flow. */
  private registerDarknessCondition(): void {
    const card = this.homey.flow.getConditionCard('daylight_is_dark');

    card.registerRunListener(async (args: any) => {
      const deviceId = args?.device?.getData?.()?.id;
      const runtime = typeof deviceId === 'string' ? this.daylights.get(deviceId) : undefined;
      // Fail closed, for the reason `isDarkEnough` gives: a device that is not
      // running cannot say it is dark, and "not true" leaves the lights alone.
      if (!runtime) return false;
      return isDarkEnough(runtime.publishedValues(), args?.level);
    });
  }

  private namedRuntimes(
    runtimes: readonly { controllerId: string; deviceName: string }[],
  ): { id: string; name: string }[] {
    return runtimes.map(runtime => ({ id: runtime.controllerId, name: runtime.deviceName }));
  }

  /**
   * The curve-driven runtime a chosen id names, or null.
   *
   * A chosen id that no live runtime answers to is pushed onto `missing` rather
   * than quietly treated as "leave alone": half a set of settings written to a
   * room, because the device holding the other half was deleted, is the outcome
   * `planSetLights` refuses outright.
   */
  private colourSourceFor(id: unknown, missing: string[]): ColourSource | null {
    if (typeof id !== 'string' || id === LEAVE_ALONE) return null;
    const runtime = this.curves.get(id);
    if (!runtime) { missing.push(id); return null; }
    return runtime;
  }

  private brightnessSourceFor(id: unknown, missing: string[]): ValueSource | null {
    if (typeof id !== 'string' || id === LEAVE_ALONE) return null;
    const runtime = this.daylights.get(id) ?? this.curves.get(id) ?? this.schedules.get(id);
    if (!runtime) { missing.push(id); return null; }
    return runtime;
  }

  private registerBridgeCard(cardId: string, magnitudeOf?: MagnitudeReader) {
    const card = this.homey.flow.getActionCard(cardId);

    card.registerRunListener(async (args: any) => {
      const { accepted, reason, record } = intakeBridgeEvent(cardId, args, magnitudeOf, {
        schedule: (id, key) => this.schedules.dispatchWithReason(id, key),
        controller: (id, key, options) => this.controllers.dispatchWithReason(id, key, options),
      });

      this.recentEvents.add({ at: Date.now(), ...record });
      this.evidence.record('bridge_event', record);

      if (!accepted) {
        // A flow left behind by a deleted controller, an emptied argument, or an
        // edited event key.
        this.log(`Ignoring ${cardId}: ${reason}`);
        return false;
      }

      return true;
    });
  }

  private evidenceContext() {
    // Through `timezoneOf` like everything else: an unguarded `getTimezone()`
    // has been seen to throw, and this one is called from `onInit` — so a
    // Homey that had not resolved its own location would have failed app start
    // for the sake of one diagnostic field.
    return { appVersion: this.homey.manifest.version, nodeVersion: process.version,
      timezone: timezoneOf(this.homey.clock), uptimeSeconds: process.uptime() };
  }

  /**
   * The Homey's own position, or nothing — and the try/catch is the whole reason
   * this is a method rather than a value.
   *
   * `getLatitude()` is synchronous and THROWS when the permission is missing, so
   * the boundary belongs here: `lib/` has no access to `this.homey` and must not
   * have to know that reading a number can fail (platform §16). What arrives at a
   * consumer is a position or nothing, and nothing is a verdict both of them know
   * how to report — the evaluator falls back to the sensors, and a circadian
   * light falls back to fixed hours.
   *
   * Read per call rather than cached, for the same reason `timezone` is: a
   * household that corrects its Homey's location must not have to restart the
   * app. Two consumers now — the daylight evaluator and the circadian runtimes'
   * sun-anchored boundaries — which is what turned a closure into this.
   */
  private location(): unknown {
    try {
      return {
        latitude: this.homey.geolocation?.getLatitude(),
        longitude: this.homey.geolocation?.getLongitude(),
      };
    } catch (error) {
      this.log('Could not read the Homey location:', messageOf(error));
      return null;
    }
  }

  override async onUninit() {
    this.evidence.stopTimer();

    /**
     * FIRST, not last — and even so, best-effort.
     *
     * This used to be the final line of `onUninit`, behind four `destroyAll()`
     * calls and two `destroy()`s. Measured on Homey Pro 2023, firmware 13.5.0
     * (platform §17):
     * across two app restarts, an archive that recorded 353 records and two
     * `app_boot`s contained NO `app_shutdown` at all. Whether `onUninit` is
     * skipped entirely on a restart or simply runs out of grace before an
     * awaited `fsync` completes, the answer is the same — the further down the
     * teardown this sits, the less chance it has.
     *
     * So it goes to the front, where the only thing ahead of it is clearing its
     * own timer. Nothing later in this method produces evidence, so nothing is
     * lost by recording the shutdown before the runtimes are stopped rather
     * than after.
     *
     * It is still NOT relied on. What actually establishes a boot boundary in
     * the archive is `app_boot` plus a fresh `bootId` under the same `runId`,
     * written on the way UP where there is no grace window to run out of — and
     * that is what `docs/hardware-test-plan.md`'s T99 checks.
     */
    await this.evidence?.close();

    // Never leave a light mid-ramp, a timer running or a listener attached.
    // The SDK's setTimeout is disposal-safe, but a pending fan-out would still
    // reconcile against registries that are being torn down.
    if (this.credentialFanOutTimer !== null) {
      this.homey.clearTimeout(this.credentialFanOutTimer);
      this.credentialFanOutTimer = null;
    }
    await this.controllers?.destroyAll();
    await this.schedules?.destroyAll();
    await this.curves?.destroyAll();
    await this.daylights?.destroyAll();
    // After the runtimes, so their own release() calls have already run and this
    // is only the backstop for anything a pairing session left behind.
    await this.lights?.destroy();
    await this.luminance?.destroy();
    await this.api?.destroy();
    // Whatever the catalogue is still holding from the last read. Small by
    // design (platform §15), but there is no reason for it to outlive the app.
    this.cards?.clear();
  }

};

/**
 * The class, and the proof it still satisfies what `api.ts` and the device layer
 * are typed against.
 *
 * `module.exports = <class>` is required — a Homey entry point using
 * `export default` is not loaded at all (platform §13) — so there is no exported class
 * type for a consumer to import. `LightkeeperApp` in `lib/app-contract.ts` is
 * that type written down by hand, and the assignment below is what keeps the two
 * honest: removing or renaming a member the contract promises fails HERE, at
 * compile time, rather than as `undefined` inside a settings-page handler.
 *
 * The class expression keeps its own name so the Homey's logs and stack traces
 * still say `LightkeeperApp`.
 */
const contractCheck: new (...args: any[]) => LightkeeperApp = LightkeeperAppImpl;

module.exports = contractCheck;
