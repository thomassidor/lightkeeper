import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LuminanceSource } from '../../lib/daylight/luminance-source';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * One subscription per sensor, however many devices asked for it.
 *
 * Five Lightkeeper devices may every one of them name the sensor in the hall,
 * and each holding its own listener on somebody's battery-powered motion sensor
 * is five teardowns to get right and five chances to leak one. So the ref count
 * is the thing under test here, in both directions: retaining twice must not
 * subscribe twice, and releasing one owner must not take the other's
 * subscription with it.
 *
 * The other half is what USABLE means. A sensor that is gone, that Homey reports
 * unavailable, or that has never reported a finite number must be left out of
 * the mean rather than averaged in as a zero - because a zero is "pitch dark",
 * and a flat battery reading as pitch dark drives a whole room to the wrong end
 * of its response. What is deliberately NOT unusable is an OLD reading: many
 * Zigbee sensors report only on change, so a quiet sensor in a stable room is
 * telling the truth (platform §16).
 */

interface FakeSensor {
  id: string;
  name?: string;
  capabilities?: string[];
  available?: boolean;
  lux?: number | null;
}

function harness(sensors: FakeSensor[] = [{ id: 's1', lux: 100 }]) {
  /** deviceId -> the listener Homey would call. Absent means destroyed. */
  const listeners = new Map<string, (value: unknown) => void>();
  const subscribeCalls: string[] = [];
  const destroyCalls: string[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  let present = [...sensors];
  let failSubscribe: string | null = null;

  const catalogEntry = (sensor: FakeSensor) => ({
    id: sensor.id,
    name: sensor.name ?? sensor.id,
    available: sensor.available ?? true,
    capabilities: sensor.capabilities ?? ['measure_luminance'],
    capabilitiesObj: sensor.lux === null || sensor.lux === undefined
      ? {}
      : { measure_luminance: { value: sensor.lux, decimals: 2, units: 'lx' } },
  });

  const api = {
    async read() {
      return {
        devices: {
          getDevice: async ({ id }: { id: string }) => {
            if (failSubscribe === id) throw new Error('device is not reachable');
            return {
              makeCapabilityInstance(capability: string, listener: (value: unknown) => void) {
                assert.equal(capability, 'measure_luminance', 'only the lux axis is subscribed');
                subscribeCalls.push(id);
                listeners.set(id, listener);
                return {
                  destroy: () => {
                    destroyCalls.push(id);
                    listeners.delete(id);
                  },
                };
              },
            };
          },
        },
      };
    },
    // The real one hands back a wrapper that also removes itself from the
    // service's teardown set; for these tests passing it through is enough.
    track: (unsubscribe: unknown) => unsubscribe,
  } as unknown as HomeyApiService;

  const catalog = {
    async device(id: string) {
      const found = present.find(s => s.id === id);
      return found === undefined ? undefined : catalogEntry(found);
    },
  } as unknown as DeviceCatalog;

  const source = new LuminanceSource({ api, catalog, now: () => now, log: (...a) => logs.push(a.join(' ')) });

  return {
    source,
    listeners,
    subscribeCalls,
    destroyCalls,
    logs,
    /** Fire a reading the way Homey's own event dispatch would. */
    report(id: string, value: unknown) { listeners.get(id)!(value); },
    advance(ms: number) { now += ms; },
    at() { return now; },
    remove(id: string) { present = present.filter(s => s.id !== id); },
    setAvailable(id: string, available: boolean) {
      present = present.map(s => (s.id === id ? { ...s, available } : s));
    },
    failNextSubscribe(id: string) { failSubscribe = id; },
  };
}

describe('LuminanceSource - one subscription per sensor', () => {
  test('a single retain subscribes once and seeds from the catalog', async () => {
    const h = harness([{ id: 's1', lux: 120 }]);
    await h.source.retain(['s1'], 'dev-a');

    assert.deepEqual(h.subscribeCalls, ['s1']);
    // Seeded, because a battery sensor may not report for many minutes and a
    // device that has to wait for that reports needs_repair on every restart.
    assert.deepEqual(h.source.read(['s1']), { lux: 120, deviceIds: ['s1'] });
  });

  test('five devices naming one sensor cost one subscription', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    for (const owner of ['a', 'b', 'c', 'd', 'e']) await h.source.retain(['s1'], owner);

    assert.deepEqual(h.subscribeCalls, ['s1'], 'subscribed once for five owners');
  });

  test('releasing one owner leaves the others subscribed', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    await h.source.retain(['s1'], 'b');

    await h.source.release('a');
    assert.deepEqual(h.destroyCalls, [], 'still wanted by b');
    assert.notEqual(h.source.read(['s1']), null);

    await h.source.release('b');
    assert.deepEqual(h.destroyCalls, ['s1'], 'the last owner released it');
    assert.equal(h.source.read(['s1']), null);
  });

  test('retain is TOTAL for its owner, so a dropped sensor is released', async () => {
    // The intended use: a runtime passes its whole sensor list on every plan
    // change, and does not have to work out the difference itself.
    const h = harness([{ id: 's1', lux: 100 }, { id: 's2', lux: 200 }]);
    await h.source.retain(['s1', 's2'], 'a');
    assert.deepEqual(h.subscribeCalls.sort(), ['s1', 's2']);

    await h.source.retain(['s2'], 'a');
    assert.deepEqual(h.destroyCalls, ['s1']);
    assert.deepEqual(h.source.read(['s2']), { lux: 200, deviceIds: ['s2'] });
  });

  test('one owner dropping a sensor another still holds keeps it', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    await h.source.retain(['s1'], 'b');

    await h.source.retain([], 'a');
    assert.deepEqual(h.destroyCalls, []);
    assert.notEqual(h.source.read(['s1']), null);
  });

  test('destroy drops everything, whoever was holding it', async () => {
    const h = harness([{ id: 's1', lux: 1 }, { id: 's2', lux: 2 }]);
    await h.source.retain(['s1'], 'a');
    await h.source.retain(['s2'], 'b');

    await h.source.destroy();
    assert.deepEqual(h.destroyCalls.sort(), ['s1', 's2']);
    assert.deepEqual(h.source.watched(), []);
  });

  test('two overlapping retains for one sensor do not build two subscriptions', async () => {
    // The KeyedMutex is what holds this: the map insert lands after two awaits,
    // so without serialising, both callers see "nothing subscribed", both build
    // a listener, and the second insert orphans the first with nothing left
    // holding a handle to destroy it.
    const h = harness([{ id: 's1', lux: 100 }]);
    await Promise.all([
      h.source.retain(['s1'], 'a'),
      h.source.retain(['s1'], 'b'),
    ]);

    assert.deepEqual(h.subscribeCalls, ['s1']);
  });
});

describe('LuminanceSource - what a reading is', () => {
  test('a live report replaces the seeded value and is timestamped', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    h.advance(60_000);
    h.report('s1', 640);

    assert.deepEqual(h.source.read(['s1']), { lux: 640, deviceIds: ['s1'] });
    assert.equal(h.source.watched()[0].at, h.at());
  });

  test('the mean is over the usable sensors, not all of them', async () => {
    const h = harness([{ id: 's1', lux: 100 }, { id: 's2', lux: 300 }]);
    await h.source.retain(['s1', 's2'], 'a');

    assert.deepEqual(h.source.read(['s1', 's2']), { lux: 200, deviceIds: ['s1', 's2'] });
  });

  test('a mean rather than the brightest, because the selection IS the weighting', async () => {
    // Taking the maximum would let one window-facing sensor speak for a whole
    // flat. Somebody who does not want a sensor's opinion does not select it.
    const h = harness([{ id: 's1', lux: 10 }, { id: 's2', lux: 1000 }]);
    await h.source.retain(['s1', 's2'], 'a');

    assert.equal(h.source.read(['s1', 's2'])!.lux, 505);
  });

  test('a sensor that has never reported is left out of the mean, not counted as dark', async () => {
    // Averaged in as a zero, a sensor with a flat battery drives a whole room to
    // the wrong end of its response.
    const h = harness([{ id: 's1', lux: 400 }, { id: 's2', lux: null }]);
    await h.source.retain(['s1', 's2'], 'a');

    assert.deepEqual(h.source.read(['s1', 's2']), { lux: 400, deviceIds: ['s1'] });
  });

  test('a sensor Homey reports unavailable is left out', async () => {
    const h = harness([{ id: 's1', lux: 400 }, { id: 's2', available: false, lux: 20 }]);
    await h.source.retain(['s1', 's2'], 'a');

    assert.deepEqual(h.source.read(['s1', 's2']), { lux: 400, deviceIds: ['s1'] });
  });

  test('a device that no longer has the capability is left out too', async () => {
    // A plan can name a sensor that was replaced by something else at the same
    // id, and offline is no worse than "not that kind of device any more".
    const h = harness([{ id: 's1', lux: 400 }, { id: 's2', capabilities: ['onoff'], lux: 20 }]);
    await h.source.retain(['s1', 's2'], 'a');

    assert.deepEqual(h.source.read(['s1', 's2']), { lux: 400, deviceIds: ['s1'] });
  });

  test('no usable sensor at all is NOTHING, not a zero', async () => {
    // resolveLevel falls back to the sky on a null and to the dark end on a
    // zero, and those are different rooms.
    const h = harness([{ id: 's1', lux: null }]);
    await h.source.retain(['s1'], 'a');

    assert.equal(h.source.read(['s1']), null);
  });

  test('an unretained sensor id contributes nothing', async () => {
    const h = harness([{ id: 's1', lux: 400 }]);
    await h.source.retain(['s1'], 'a');

    assert.deepEqual(h.source.read(['s1', 'never-heard-of-it']), { lux: 400, deviceIds: ['s1'] });
    assert.equal(h.source.read(['never-heard-of-it']), null);
  });

  test('an OLD reading is still a reading', async () => {
    // Not an oversight. A sensor that reports only on change is quiet in a
    // stable room, and a staleness timeout would fall back to the sky exactly
    // when the sensor was telling the truth.
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    h.report('s1', 42);
    h.advance(6 * 60 * 60_000);

    assert.deepEqual(h.source.read(['s1']), { lux: 42, deviceIds: ['s1'] });
  });

  test('a non-finite or negative report is ignored and the last good one stands', async () => {
    // The sensor is still there, and the last thing it said is still the best
    // answer available - the opposite of what treating this as 0 would do.
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    h.report('s1', 250);

    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -5, 'bright', null, undefined, {}]) {
      h.report('s1', junk);
      assert.deepEqual(h.source.read(['s1']), { lux: 250, deviceIds: ['s1'] }, `junk: ${String(junk)}`);
    }
    assert.ok(h.logs.some(line => line.includes('unusable luminance report')));
  });

  test('zero lux IS a reading, because a dark room is an answer', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    h.report('s1', 0);

    assert.deepEqual(h.source.read(['s1']), { lux: 0, deviceIds: ['s1'] });
  });
});

describe('LuminanceSource - the catalog, and failures', () => {
  test('a sensor going unavailable stops being averaged, on the catalog event', async () => {
    // Availability arrives on the catalog's device events, not over a capability
    // subscription - so without onCatalogChange a sensor whose battery died went
    // on being averaged with its last reading for as long as the app ran.
    const h = harness([{ id: 's1', lux: 100 }, { id: 's2', lux: 300 }]);
    await h.source.retain(['s1', 's2'], 'a');
    assert.equal(h.source.read(['s1', 's2'])!.lux, 200);

    h.setAvailable('s2', false);
    await h.source.onCatalogChange();

    assert.deepEqual(h.source.read(['s1', 's2']), { lux: 100, deviceIds: ['s1'] });
  });

  test('and coming back available is averaged again', async () => {
    const h = harness([{ id: 's1', lux: 100 }, { id: 's2', available: false, lux: 300 }]);
    await h.source.retain(['s1', 's2'], 'a');
    assert.equal(h.source.read(['s1', 's2'])!.lux, 100);

    h.setAvailable('s2', true);
    await h.source.onCatalogChange();

    assert.equal(h.source.read(['s1', 's2'])!.lux, 200);
  });

  test('a sensor deleted from the Homey is unavailable, not forgotten', async () => {
    // The owners still name it, a re-paired sensor should come back on its own,
    // and a sensor a user can see in a plan should show on the settings page as
    // missing rather than vanish from it.
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    h.remove('s1');
    await h.source.onCatalogChange();

    assert.equal(h.source.read(['s1']), null);
    assert.equal(h.source.watched().length, 1);
    assert.equal(h.source.watched()[0].available, false);
  });

  test('a subscription that cannot be made leaves a watched, unusable sensor', async () => {
    // Not a throw. The device reports why it has no reading and the sky answers
    // instead, which is a device that starts rather than one that fails to.
    const h = harness([{ id: 's1', lux: 100 }, { id: 's2', lux: 300 }]);
    h.failNextSubscribe('s2');
    await h.source.retain(['s1', 's2'], 'a');

    assert.deepEqual(h.subscribeCalls, ['s1']);
    assert.equal(h.source.watched().length, 2);
    assert.ok(h.logs.some(line => line.includes('Could not subscribe to luminance on s2')));
    // The catalog seed still stands, because getDevice failing is about the
    // subscription and not about what the sensor last read.
    assert.deepEqual(h.source.read(['s1', 's2'])!.deviceIds, ['s1', 's2']);
  });

  test('releasing an owner that holds nothing is a no-op', async () => {
    const h = harness([{ id: 's1', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    await h.source.release('nobody');

    assert.deepEqual(h.destroyCalls, []);
  });

  test('watched() reports the name, the reading and its age for a human', async () => {
    const h = harness([{ id: 's1', name: 'Hall motion', lux: 100 }]);
    await h.source.retain(['s1'], 'a');
    const seededAt = h.at();
    h.advance(120_000);
    h.report('s1', 55);

    assert.deepEqual(h.source.watched(), [{
      deviceId: 's1', name: 'Hall motion', lux: 55, at: seededAt + 120_000, available: true,
    }]);
  });
});
