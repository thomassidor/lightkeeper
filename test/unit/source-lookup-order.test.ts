import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  brightnessSourceIn, colourSourceIn, resolveSources, sourceRegistryOver,
  type ById, type ColourSource, type ValueSource,
} from '../../lib/outputs/lightkeeper-settings';

/**
 * Which registry answers "which device is this id", in ONE place.
 *
 * The brightness order — Room-sensing Light, then curve, then schedule — was
 * written out twice: in `app.ts`'s `sourceRegistry()`, which the press and the
 * `set_lights` card read, and in the controller driver's `sourceNames()`, which
 * names the device on the job tile. Two copies of a lookup order are two
 * answers waiting to disagree about the same id, and neither copy could be
 * tested because both lived in files that extend the SDK (platform §13).
 */

function byId<T extends { id: string }>(items: T[]): ById<T> {
  return { get: (id: string) => items.find(item => item.id === id) };
}

const managers = {
  curves: byId([{ id: 'shared', kind: 'curve' }, { id: 'c', kind: 'curve' }]),
  daylights: byId([{ id: 'shared', kind: 'daylight' }, { id: 'd', kind: 'daylight' }]),
  schedules: byId([{ id: 'shared', kind: 'schedule' }, { id: 's', kind: 'schedule' }]),
};
const nothing = byId<{ id: string; kind: string }>([]);

describe('the brightness order', () => {
  test('a Room-sensing Light first, then a curve, then a schedule', () => {
    assert.equal(brightnessSourceIn(managers, 'shared')?.kind, 'daylight');
    assert.equal(brightnessSourceIn({ ...managers, daylights: nothing }, 'shared')?.kind, 'curve');
    assert.equal(brightnessSourceIn({ ...managers, daylights: nothing, curves: nothing }, 'shared')?.kind, 'schedule');
    assert.equal(brightnessSourceIn(managers, 'd')?.kind, 'daylight');
    assert.equal(brightnessSourceIn(managers, 's')?.kind, 'schedule');
    assert.equal(brightnessSourceIn(managers, 'nobody'), undefined);
  });

  test('a colour comes from a curve and from nothing else', () => {
    assert.equal(colourSourceIn(managers, 'shared')?.kind, 'curve');
    assert.equal(colourSourceIn(managers, 'd'), undefined, 'a Room-sensing Light has no colour');
    assert.equal(colourSourceIn(managers, 's'), undefined, 'nor does a schedule');
  });
});

describe('the registry over it', () => {
  type Curve = ColourSource & { id: string };
  type Value = ValueSource & { id: string };

  test('reads the managers at CALL time, so it can be built before they exist', () => {
    const late: { curves: ById<Curve>; daylights: ById<Value>; schedules: ById<Value> } = {
      curves: byId<Curve>([]), daylights: byId<Value>([]), schedules: byId<Value>([]),
    };
    const registry = sourceRegistryOver(late);
    assert.equal(registry.colour('c'), undefined);

    const curve: Curve = { id: 'c', publishedValues: () => ({}), currentValue: () => null };
    late.curves = byId([curve]);
    assert.equal(registry.colour('c'), curve);
    assert.equal(registry.brightness('c'), curve);
  });

  test('resolveSources over it names what no runtime answers to', () => {
    const value: Value = { id: 'd', publishedValues: () => ({}) };
    const registry = sourceRegistryOver({ curves: byId<Curve>([]), daylights: byId([value]), schedules: byId<Value>([]) });
    const resolved = resolveSources(registry, 'lk-curv-gone', 'd');
    assert.equal(resolved.brightness, value);
    assert.equal(resolved.colour, null);
    assert.deepEqual(resolved.missing, ['lk-curv-gone']);
  });
});
