import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fakeHomey, makeApp, translate, type FakeHomey } from '../support/fake-homey';
import { fakeApiClient, lamp, type FakeApiClient } from '../support/fake-homey-api';
import { stubSource } from '../support/fake-lightkeeper-app';
import { settle } from '../support/deferred';
import { HomeyApiService } from '../../lib/homey-api-service';
import { MISSING_MAGNITUDE } from '../../lib/bridge/bridge-event-intake';
import { LEAVE_ALONE } from '../../lib/outputs/lightkeeper-settings';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';

const LightkeeperApp = require('../../app');

/**
 * `app.ts`, executed: `onInit`'s wiring, every Flow-card listener it registers,
 * and `onUninit`'s teardown.
 *
 * The rules behind each card were lifted into `lib/` precisely because this
 * class `extends Homey.App` and could not be imported (platform §13) — the
 * intake in `bridge-event-intake.ts`, the card's decisions in `lib/flow/`. What
 * none of those can show is the SHELL: which reader each bridge card is given,
 * what an unreadable power dropdown falls back to, that the darkness condition
 * fails closed on a device that is not running. A mistake in any of them is a
 * mistake in the one file no test reached.
 *
 * `HomeyApiService` is the real class with its one `homey-api` call stubbed —
 * `createAppApi`, the seam it documents for exactly this — so everything above
 * it (the catalogue, the watch, the managers) is the real thing.
 */

const CONTROLLER = 'lk-ctrl-3f1c9f7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const SCHEDULE = 'lk-sched-3f1c9f7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

const original = {
  createAppApi: Object.getOwnPropertyDescriptor(HomeyApiService.prototype, 'createAppApi')!,
  createWriteClient: HomeyApiService.createWriteClient,
};

afterEach(() => {
  Object.defineProperty(HomeyApiService.prototype, 'createAppApi', original.createAppApi);
  HomeyApiService.createWriteClient = original.createWriteClient;
});

interface Booted {
  app: any;
  homey: FakeHomey;
  client: FakeApiClient;
  dispatched: Array<{ to: string; id: string; key: string; options?: unknown }>;
}

async function boot(options: { location?: FakeHomey['geolocation'] | 'throws'; settings?: Record<string, unknown> } = {}): Promise<Booted> {
  const client = fakeApiClient([lamp('l1', 'Sofa lamp'), lamp('l2', 'Hall spot', 'z-hall')]);
  Object.defineProperty(HomeyApiService.prototype, 'createAppApi', {
    configurable: true, writable: true, value: async () => client,
  });
  const homey = fakeHomey({
    ...(options.location === 'throws' ? { location: 'throws' as const } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const app = makeApp(LightkeeperApp, homey);
  await app.onInit();

  // The two registries a bridge event can reach, replaced by recorders so the
  // test can see what the SHELL handed them.
  const dispatched: Booted['dispatched'] = [];
  app.controllers = {
    ...app.controllers,
    dispatchWithReason: (id: string, key: string, options: unknown) => {
      dispatched.push({ to: 'controller', id, key, options });
      return { accepted: true };
    },
    onCatalogChange: async () => { dispatched.push({ to: 'controller-catalogue', id: '', key: '' }); },
    onCredentialChange: async () => { dispatched.push({ to: 'controller-credential', id: '', key: '' }); },
    destroyAll: async () => undefined,
    all: () => [],
  };
  app.schedules = {
    ...app.schedules,
    dispatchWithReason: (id: string, key: string) => {
      dispatched.push({ to: 'schedule', id, key });
      return { accepted: false, reason: 'no running schedule' };
    },
    onCatalogChange: async () => { dispatched.push({ to: 'schedule-catalogue', id: '', key: '' }); },
    onCredentialChange: async () => { dispatched.push({ to: 'schedule-credential', id: '', key: '' }); },
    destroyAll: async () => undefined,
    all: () => [],
    get: () => undefined,
  };
  return { app, homey, client, dispatched };
}

const card = (homey: FakeHomey, kind: 'action' | 'condition', id: string) => homey.flow.card(kind, id);

describe('onInit', () => {
  test('registers the three bridge cards, the set_lights card and the darkness condition', async () => {
    const { homey, app } = await boot();
    for (const id of ['bridge_event', 'bridge_numeric_event', 'bridge_token_event', 'set_lights']) {
      assert.ok(card(homey, 'action', id).run, `${id} has a run listener`);
    }
    assert.deepEqual([...card(homey, 'action', 'set_lights').autocomplete.keys()].sort(), ['brightness', 'colour', 'lights']);
    assert.ok(card(homey, 'condition', 'daylight_is_dark').run);
    assert.ok(app.logs.includes('Lightkeeper initialised'));
    await app.onUninit();
  });

  test('with no key stored, it says so rather than revalidating nothing', async () => {
    const { app } = await boot();
    await settle(3);
    assert.ok(app.logs.includes('No API key stored yet'), app.logs.join('\n'));
    await app.onUninit();
  });

  test('a device or zone change reaches every registry AND the sensor service', async () => {
    const { app, client, dispatched } = await boot();
    let luminance = 0;
    const onCatalogChange = app.luminance.onCatalogChange.bind(app.luminance);
    app.luminance.onCatalogChange = async () => { luminance += 1; return onCatalogChange(); };
    let curves = 0;
    let daylights = 0;
    app.curves.onCatalogChange = async () => { curves += 1; };
    app.daylights.onCatalogChange = async () => { daylights += 1; };

    client.emitDevices('device.create');
    await settle(2);

    assert.deepEqual(dispatched.map(d => d.to), ['controller-catalogue', 'schedule-catalogue']);
    assert.deepEqual([curves, daylights, luminance], [1, 1, 1],
      'the sensor service too: a sensor\'s availability arrives on these device events');
    await app.onUninit();
  });

  test('the heap is sampled on an interval that belongs to no device', async () => {
    const { app, homey } = await boot();
    assert.ok(homey.timers.pending >= 1);
    await app.onUninit();
  });

  test('the evidence sampler sees every registry\'s runtimes', async () => {
    const { app } = await boot();
    const sample = (app.evidence as any).host.sample();
    assert.deepEqual(sample.runtimes, []);
    assert.deepEqual(sample.sensors, []);
    assert.equal(sample.credential.present, false);
    const context = (app.evidence as any).host.context();
    assert.equal(context.timezone, 'Europe/Copenhagen');
    await app.onUninit();
  });
});

describe('the credential fan-out', () => {
  const KEY = '2d36cd94-0d54-4e5b-abb6-51b70b58ae07:4b0dd18f-0cb6-446c-9e56-a7fced78d31e:'
    + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  test('a status change reaches both Flow-writing registries ONCE, on a trailing edge', async () => {
    HomeyApiService.createWriteClient = async () => ({
      flow: {
        getFlowFolders: async () => ({}),
        createFlowFolder: async () => ({ id: 'probe' }),
        deleteFlowFolder: async () => undefined,
      },
    });
    const { app, homey, dispatched } = await boot();

    const status = await app.credentials.setCredential(KEY, async () => undefined);
    assert.equal(status.valid, true);
    assert.ok(app.logs.includes('Credential status: valid'));
    // A second change inside the window collapses into the first.
    (app as any).fanOutCredentialChange();

    assert.deepEqual(dispatched.filter(d => d.to.endsWith('credential')), [], 'nothing before the edge');
    homey.timers.advance(250);
    await settle(2);
    assert.deepEqual(dispatched.filter(d => d.to.endsWith('credential')).map(d => d.to),
      ['controller-credential', 'schedule-credential']);
    await app.onUninit();
  });

  test('a stored key is re-proved by a WRITE at boot', async () => {
    let probed = 0;
    HomeyApiService.createWriteClient = async () => ({
      flow: {
        getFlowFolders: async () => ({}),
        createFlowFolder: async () => { probed += 1; return { id: 'probe' }; },
        deleteFlowFolder: async () => undefined,
      },
    });
    const { app } = await boot({ settings: { flowWriteApiKey: KEY } });
    await settle(5);
    // A folder created and deleted: a READ succeeds on a key that cannot write
    // Flows (platform §1), so only a write proves anything.
    assert.equal(probed, 1, app.logs.join('\n'));
    assert.ok(app.logs.includes('Stored API key: valid'), app.logs.join('\n'));
    await app.onUninit();
  });

  test('a fan-out still pending at shutdown never fires into torn-down registries', async () => {
    const { app, homey, dispatched } = await boot();
    (app as any).fanOutCredentialChange();
    await app.onUninit();
    homey.timers.advance(1000);
    await settle(2);
    assert.deepEqual(dispatched.filter(d => d.to.endsWith('credential')), []);
  });
});

describe('the three bridge cards', () => {
  test('the plain card routes a schedule key to the schedule registry, by shape', async () => {
    const { app, homey, dispatched } = await boot();
    const key = eventKeyFor('a', 'on');
    const accepted = await card(homey, 'action', 'bridge_event').fire({ controller: SCHEDULE, event_key: key });

    assert.equal(accepted, false, 'the registry refused, so the card reports failure');
    assert.deepEqual(dispatched, [{ to: 'schedule', id: SCHEDULE, key }]);
    const [event] = app.recentEvents.entries();
    assert.equal(event.cardId, 'bridge_event');
    assert.equal(event.reason, 'no running schedule');
    assert.equal(typeof event.at, 'number');
    assert.ok(app.logs.some((line: string) => line.startsWith('Ignoring bridge_event: no running schedule')));
    await app.onUninit();
  });

  test('the plain card carries no magnitude, whatever its arguments say', async () => {
    const { app, homey, dispatched } = await boot();
    assert.equal(await card(homey, 'action', 'bridge_event').fire({ controller: CONTROLLER, event_key: 'on|press', value: 7 }), true);
    assert.deepEqual(dispatched[0]!.options, {});
    await app.onUninit();
  });

  test('the numeric card reads `value`, and a numeric string is a number', async () => {
    const { app, homey, dispatched } = await boot();
    const numeric = card(homey, 'action', 'bridge_numeric_event');
    assert.equal(await numeric.fire({ controller: CONTROLLER, event_key: 'dial|rotate', value: 3 }), true);
    assert.equal(await numeric.fire({ controller: CONTROLLER, event_key: 'dial|rotate', value: ' 4 ' }), true);
    assert.deepEqual(dispatched.map(d => d.options), [{ magnitude: 3 }, { magnitude: 4 }]);
    await app.onUninit();
  });

  /**
   * The defect: `Number(args.value)`. `Number(null)` and `Number('')` are 0 and
   * `Number(true)` is 1, all finite — so an emptied argument dispatched a
   * magnitude of 0, which the mapping engine turns into ONE NOTCH. A card that
   * exists to carry an amount and carries none now fails closed.
   */
  test('the numeric card with no usable value is REFUSED, never dispatched as 0', async () => {
    const { app, homey, dispatched } = await boot();
    const numeric = card(homey, 'action', 'bridge_numeric_event');
    for (const value of [null, '', '   ', undefined, true, 'three', [3], {}]) {
      assert.equal(await numeric.fire({ controller: CONTROLLER, event_key: 'dial|rotate', value }), false,
        JSON.stringify(value));
    }
    assert.deepEqual(dispatched, []);
    assert.equal(app.recentEvents.entries()[0].reason, MISSING_MAGNITUDE);
    await app.onUninit();
  });

  test('the token card reads the TOP-LEVEL droptoken, and fails closed without one', async () => {
    const { app, homey, dispatched } = await boot();
    const token = card(homey, 'action', 'bridge_token_event');
    assert.equal(await token.fire({ controller: CONTROLLER, event_key: 'dial|rotate', droptoken: 151 }), true);
    assert.equal(await token.fire({ controller: CONTROLLER, event_key: 'dial|rotate', droptoken: null }), false);
    assert.equal(await token.fire({ controller: CONTROLLER, event_key: 'dial|rotate', value: 5 }), false,
      'a `value` on the token card is not its amount');
    assert.deepEqual(dispatched.map(d => d.options), [{ magnitude: 151 }]);
    await app.onUninit();
  });

  test('an emptied controller argument is refused before anything is asked', async () => {
    const { app, homey, dispatched } = await boot();
    assert.equal(await card(homey, 'action', 'bridge_numeric_event').fire({ event_key: 'k', value: 1 }), false);
    assert.equal(await card(homey, 'action', 'bridge_event').fire(null), false);
    assert.deepEqual(dispatched, []);
    await app.onUninit();
  });
});

describe('the set_lights card', () => {
  async function withSources() {
    const booted = await boot();
    const { app } = booted;
    const applied: Array<{ spec: unknown; plan: any; power: string }> = [];
    app.lights = {
      apply: async (spec: unknown, plan: any, power: string) => {
        applied.push({ spec, plan, power });
        return plan.refused ? { writes: 0, skipped: 0, refused: plan.refused } : { writes: 2, skipped: 1 };
      },
      destroy: async () => undefined,
    };
    const curve = stubSource('lk-curv-1', 'Evening curve', {
      values: { [VALUE_CAPABILITIES.temperature]: 0.8, [VALUE_CAPABILITIES.brightness]: 0.3 },
    });
    const daylight = stubSource('lk-dayl-1', 'Room sensing', { values: { [VALUE_CAPABILITIES.brightness]: 0.6 } });
    app.curves = { ...app.curves, all: () => [curve], get: (id: string) => (id === curve.controllerId ? curve : undefined), destroyAll: async () => undefined };
    app.daylights = { ...app.daylights, all: () => [daylight], get: (id: string) => (id === daylight.controllerId ? daylight : undefined), destroyAll: async () => undefined };
    return { ...booted, applied };
  }

  test('an unreadable power choice falls to "only the lights that are on"', async () => {
    const { app, homey, applied } = await withSources();
    const result = await card(homey, 'action', 'set_lights').fire({
      lights: { id: 'devices:l1' }, colour: { id: 'lk-curv-1' }, brightness: { id: 'lk-dayl-1' }, power: 'blast',
    });
    assert.equal(result, true);
    assert.equal(applied[0]!.power, 'only_on', 'never the half that can switch a household\'s lights on');
    assert.deepEqual(applied[0]!.spec, { kind: 'devices', deviceIds: ['l1'] });
    assert.ok(app.logs.includes('set_lights: 2 write(s), 1 skipped'));
    await app.onUninit();
  });

  test('"on" is honoured when it is what was chosen', async () => {
    const { app, homey, applied } = await withSources();
    await card(homey, 'action', 'set_lights').fire({
      lights: { id: 'zone:z-living' }, colour: { id: LEAVE_ALONE }, brightness: { id: 'lk-dayl-1' }, power: 'on',
    });
    assert.equal(applied[0]!.power, 'on');
    assert.deepEqual(applied[0]!.spec, { kind: 'zone', zoneId: 'z-living', includeSubzones: true });
    await app.onUninit();
  });

  test('lights it cannot read are refused before anything is resolved', async () => {
    const { app, homey, applied } = await withSources();
    for (const lights of [undefined, { id: 'garage' }, { id: 'devices:' }, { id: 42 }]) {
      assert.equal(await card(homey, 'action', 'set_lights').fire({ lights, power: 'on' }), false);
    }
    assert.deepEqual(applied, []);
    assert.ok(app.logs.includes('Ignoring set_lights: the chosen lights are not a target this app can read'));
    await app.onUninit();
  });

  test('a source device that has gone refuses the WHOLE pass and says which', async () => {
    const { app, homey } = await withSources();
    const result = await card(homey, 'action', 'set_lights').fire({
      lights: { id: 'devices:l1' }, colour: { id: 'lk-curv-deleted' }, brightness: { id: 'lk-dayl-1' }, power: 'on',
    });
    assert.equal(result, false);
    assert.ok(app.logs.some((line: string) => line.startsWith('Ignoring set_lights:') && line.includes('lk-curv-deleted')),
      app.logs.join('\n'));
    await app.onUninit();
  });

  test('the three pickers: rooms and lamps; curves only; every brightness source', async () => {
    const { app, homey } = await withSources();
    const setLights = card(homey, 'action', 'set_lights');

    const lights = await setLights.complete('lights', '') as Array<{ id: string; description?: string }>;
    assert.deepEqual(lights.map(choice => choice.id), ['zone:z-hall', 'zone:z-living', 'devices:l2', 'devices:l1']);
    assert.equal(lights[0]!.description, translate('flow.room'));
    assert.deepEqual((await setLights.complete('lights', 'sofa') as Array<{ id: string }>).map(c => c.id), ['devices:l1']);

    const colour = await setLights.complete('colour', '') as Array<{ id: string; name: string }>;
    assert.deepEqual(colour.map(choice => choice.id), [LEAVE_ALONE, 'lk-curv-1']);
    assert.equal(colour[0]!.name, translate('flow.leaveAlone'));

    const brightness = await setLights.complete('brightness', '') as Array<{ id: string }>;
    assert.deepEqual(brightness.map(choice => choice.id), [LEAVE_ALONE, 'lk-curv-1', 'lk-dayl-1']);
    await app.onUninit();
  });
});

describe('the daylight_is_dark condition', () => {
  async function withDaylight(values: Record<string, unknown>) {
    const booted = await boot();
    const runtime = { publishedValues: () => values };
    booted.app.daylights = {
      ...booted.app.daylights,
      get: (id: string) => (id === 'lk-dayl-1' ? runtime : undefined),
      destroyAll: async () => undefined,
    };
    return booted;
  }
  const deviceArg = (id: unknown) => ({ getData: () => ({ id }) });

  test('true at or below the threshold the card was given', async () => {
    const { app, homey } = await withDaylight({ [VALUE_CAPABILITIES.daylight]: 0.2 });
    const condition = card(homey, 'condition', 'daylight_is_dark');
    assert.equal(await condition.fire({ device: deviceArg('lk-dayl-1'), level: 0.3 }), true);
    assert.equal(await condition.fire({ device: deviceArg('lk-dayl-1'), level: 0.2 }), true);
    assert.equal(await condition.fire({ device: deviceArg('lk-dayl-1'), level: 0.1 }), false);
    await app.onUninit();
  });

  test('FALSE — never true — for a device that is not running or cannot tell', async () => {
    const { app, homey } = await withDaylight({});
    const condition = card(homey, 'condition', 'daylight_is_dark');
    assert.equal(await condition.fire({ device: deviceArg('lk-dayl-1'), level: 1 }), false, 'no reading');
    assert.equal(await condition.fire({ device: deviceArg('lk-dayl-gone'), level: 1 }), false, 'not running');
    assert.equal(await condition.fire({ device: deviceArg(7), level: 1 }), false, 'an id that is not one');
    assert.equal(await condition.fire({ level: 1 }), false, 'no device argument at all');
    assert.equal(await condition.fire(undefined), false);
    await app.onUninit();
  });
});

describe('the one source-lookup order, as the app hands it to the controllers', () => {
  test('colour from a curve only; brightness from a Room-sensing Light first', async () => {
    const booted = await boot();
    const { app } = booted;
    const curve = stubSource('shared-id', 'Curve');
    const daylight = stubSource('shared-id', 'Daylight');
    app.curves = { ...app.curves, get: (id: string) => (id === 'shared-id' ? curve : undefined), destroyAll: async () => undefined };
    app.daylights = { ...app.daylights, get: (id: string) => (id === 'shared-id' ? daylight : undefined), destroyAll: async () => undefined };

    // Read through the registry the app built at onInit, BEFORE these were
    // swapped in — which is the laziness the ordering in onInit depends on.
    const registry = (app.controllers as any).deps?.sources ?? (app as any).sourceRegistry();
    assert.equal(registry.colour('shared-id'), curve);
    assert.equal(registry.brightness('shared-id'), daylight);
    assert.equal(registry.brightness('nobody'), undefined);
    await app.onUninit();
  });
});

describe('the location', () => {
  test('a missing geolocation permission is nothing, not a crash', async () => {
    const { app } = await boot({ location: 'throws' });
    const sky = app.daylight.sky();
    assert.equal(sky.elevation ?? null, null);
    assert.ok(app.logs.some((line: string) => line.startsWith('Could not read the Homey location:')));
    await app.onUninit();
  });

  test('a real position reaches the evaluator', async () => {
    const { app } = await boot();
    assert.equal(typeof app.daylight.sky().elevation, 'number');
    await app.onUninit();
  });
});

describe('onUninit', () => {
  test('tears every registry and service down, and survives running before onInit', async () => {
    const { app } = await boot();
    const torn: string[] = [];
    for (const name of ['controllers', 'schedules', 'curves', 'daylights']) {
      app[name] = { ...app[name], destroyAll: async () => { torn.push(name); } };
    }
    const destroy = app.api.destroy.bind(app.api);
    app.api.destroy = async () => { torn.push('api'); await destroy(); };
    await app.onUninit();
    assert.deepEqual(torn, ['controllers', 'schedules', 'curves', 'daylights', 'api']);

    const never = makeApp(LightkeeperApp, fakeHomey());
    never.evidence = { stopTimer: () => undefined, close: async () => undefined };
    await never.onUninit();
  });
});
