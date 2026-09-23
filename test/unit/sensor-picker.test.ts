import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeApiClient, lamp, luxSensor, realCatalog, ZONES, type RawDeviceFixture } from '../support/fake-homey-api';
import { listSensorsPayload } from '../../lib/pairing/sensor-picker';

/**
 * The Room-sensing Light's sensor list, over the REAL catalogue.
 *
 * It had no test of its own: the daylight driver is its only caller, and that
 * driver could not be imported (platform §13). The two rules worth pinning are
 * the ones a user would see go wrong — a flat battery must read as "no
 * reading", never as a pitch-dark room, and every room must be on the list,
 * because "this room has no sensor" is the interesting row.
 */

const DEFAULT_DEVICES: RawDeviceFixture[] = [
  luxSensor('s1', 'Window sensor', 'z-living', 340),
  luxSensor('s2', 'Attic sensor', 'z-living', '12'),
  luxSensor('s3', 'Hall sensor', 'z-hall', null),
  lamp('l1', 'Sofa lamp', 'z-living'),
  luxSensor('s4', 'Loose sensor', 'z-nowhere', 7),
];

function catalog(devices: RawDeviceFixture[] = DEFAULT_DEVICES) {
  return realCatalog(fakeApiClient(devices, ZONES));
}

interface Payload {
  rooms: Array<{
    zoneId: string; zoneName: string; unzoned: boolean;
    sensors: Array<{ id: string; lux: number | null; selected: boolean; available: boolean; zoneName: string }>;
  }>;
  selected: string[];
}

describe('the sensor list', () => {
  test('every room, alphabetically, with the roomless bucket last', async () => {
    const payload = await listSensorsPayload(catalog(), []) as unknown as Payload;
    assert.deepEqual(payload.rooms.map(room => room.zoneName), ['Hall', 'Home', 'Living room', '']);
    assert.equal(payload.rooms.at(-1)!.unzoned, true);
    assert.equal(payload.rooms.at(-1)!.zoneId, 'z-nowhere', 'by id, so two rooms of one name never open together');
  });

  test('only luminance devices, sorted by name within a room — a lamp is never a sensor', async () => {
    const payload = await listSensorsPayload(catalog(), []) as unknown as Payload;
    const living = payload.rooms.find(room => room.zoneName === 'Living room')!;
    assert.deepEqual(living.sensors.map(sensor => sensor.id), ['s2', 's1']);
    assert.deepEqual(payload.rooms.find(room => room.zoneName === 'Home')!.sensors, [], 'a room with none is still listed');
  });

  test('a reading is a number, a numeric string, or NOTHING — null is not 0 lux', async () => {
    const payload = await listSensorsPayload(catalog([
      luxSensor('a', 'A', 'z-living', null),
      luxSensor('b', 'B', 'z-living', ''),
      luxSensor('c', 'C', 'z-living', '  '),
      luxSensor('d', 'D', 'z-living', '45'),
      luxSensor('e', 'E', 'z-living', -3),
      luxSensor('f', 'F', 'z-living', true),
      luxSensor('g', 'G', 'z-living', 0),
      luxSensor('h', 'H', 'z-living', Number.NaN),
    ]), []) as unknown as Payload;
    const lux = Object.fromEntries(payload.rooms.flatMap(room => room.sensors).map(sensor => [sensor.id, sensor.lux]));
    assert.deepEqual(lux, { a: null, b: null, c: null, d: 45, e: null, f: null, g: 0, h: null });
  });

  test('the selection is marked per row and echoed back, even for a sensor that has gone', async () => {
    const payload = await listSensorsPayload(catalog(), ['s3', 'gone']) as unknown as Payload;
    const rows = payload.rooms.flatMap(room => room.sensors);
    assert.deepEqual(rows.filter(row => row.selected).map(row => row.id), ['s3']);
    assert.deepEqual(payload.selected, ['s3', 'gone']);
    assert.equal(rows.find(row => row.id === 's3')!.zoneName, 'Hall');
    assert.equal(rows.find(row => row.id === 's3')!.available, true);
  });
});
