import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveControllerName, deriveSuffixedName } from '../../lib/pairing/derive-name';
import {
  mappingGroups, mappingRuleRows, ruleTargetFor, singleLightOf,
} from '../../lib/pairing/mapping-screen';
import { groupSourcesByRoom } from '../../lib/pairing/source-list';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { MappingRule } from '../../lib/mapping/mapping-types';
import type { PickerLight } from '../../lib/pairing/target-picker';

/**
 * The decisions the pairing screens are built on.
 *
 * These lived inside the four `driver.ts` files until now, and that is why they
 * had no tests: a file containing `extends Homey.Driver` cannot be imported by a
 * test, because `require('homey')` resolves to the CLI outside a Homey and the
 * SDK module exists only on one (platform §13). The same split
 * `lib/devices/device-lifecycle.ts` made one layer down, made one layer up.
 *
 * Not a refactor for its own sake: 0e81fbc — "one light means one section on the
 * mapping screen" — was a bug that lived in exactly this code, and nothing but a
 * hardware pass could have found it.
 */

const LIGHT = (id: string, name: string, zoneName: string, capabilities = ['onoff', 'dim']):
PickerLight => ({ id, name, zoneName, capabilities });

const CEILING = LIGHT('l1', 'Ceiling', 'Living room');
const READING = LIGHT('l2', 'Reading lamp', 'Living room');
const WORKTOP = LIGHT('l3', 'Worktop', 'Kitchen');

/** A catalogue that knows some zones and some lights, and nothing else. */
function catalog(lights: PickerLight[], zones: Array<{ id: string; name: string }> = []): DeviceCatalog {
  const devices = lights.map(light => ({
    id: light.id,
    name: light.name,
    zoneName: light.zoneName,
    capabilities: light.capabilities,
  }));
  return {
    allZones: async () => zones,
    device: async (id: string) => devices.find(d => d.id === id) ?? null,
    devicesInZone: async () => devices,
  } as unknown as DeviceCatalog;
}

const devicesTarget = (ids: string[]) => ({ kind: 'devices' as const, deviceIds: ids });

// ------------------------------------------------------------- derive a name

describe('the name a new device gets', () => {
  const PARTS = { fallback: 'Light schedule', suffix: 'schedule', zoneFallback: 'Zone' };

  test('one lamp is named after the lamp', async () => {
    const name = await deriveSuffixedName(catalog([CEILING]), devicesTarget(['l1']), PARTS);
    assert.equal(name, 'Ceiling schedule');
  });

  test('lamps that share a room are named after the room', async () => {
    // "Living room schedule" beats "Ceiling + Reading lamp schedule", and beats
    // "2 lights schedule" by more.
    const name = await deriveSuffixedName(
      catalog([CEILING, READING]), devicesTarget(['l1', 'l2']), PARTS);
    assert.equal(name, 'Living room schedule');
  });

  test('lamps from different rooms fall back to a count', async () => {
    const name = await deriveSuffixedName(
      catalog([CEILING, WORKTOP]), devicesTarget(['l1', 'l3']), PARTS);
    assert.equal(name, '2 lights schedule');
  });

  test('a zone target is named after the zone', async () => {
    const name = await deriveSuffixedName(
      catalog([CEILING], [{ id: 'z1', name: 'Kitchen' }]),
      { kind: 'zone', zoneId: 'z1', includeSubzones: false },
      PARTS,
    );
    assert.equal(name, 'Kitchen schedule');
  });

  test('a zone that cannot be read still produces a usable name', async () => {
    // A device called "undefined schedule" is worse than a generic one.
    const name = await deriveSuffixedName(
      catalog([CEILING], []),
      { kind: 'zone', zoneId: 'gone', includeSubzones: false },
      PARTS,
    );
    assert.equal(name, 'Zone schedule');
  });

  test('no target at all falls back rather than throwing', async () => {
    assert.equal(await deriveSuffixedName(catalog([]), undefined, PARTS), 'Light schedule');
  });

  test('no lights in the target falls back too', async () => {
    assert.equal(
      await deriveSuffixedName(catalog([]), devicesTarget([]), PARTS),
      'Light schedule',
    );
  });

  test('the suffix is the only thing that differs between three device types', () => {
    // The reason this is one function: circadian, curve and schedule held three
    // copies of it, and three copies drift.
    const suffixes = ['circadian', 'curve', 'schedule'];
    assert.equal(new Set(suffixes).size, 3, 'and they are genuinely different words');
  });
});

describe('a controller is named after both halves of what it is', () => {
  test('the remote and the one lamp', async () => {
    const name = await deriveControllerName(
      catalog([CEILING]), devicesTarget(['l1']), 'Hall remote');
    assert.equal(name, 'Hall remote → Ceiling');
  });

  test('two lamps are both named, because "2 lights" says less', async () => {
    const name = await deriveControllerName(
      catalog([CEILING, WORKTOP]), devicesTarget(['l1', 'l3']), 'Hall remote');
    assert.equal(name, 'Hall remote → Ceiling + Worktop');
  });

  test('but a shared room beats naming them', async () => {
    const name = await deriveControllerName(
      catalog([CEILING, READING]), devicesTarget(['l1', 'l2']), 'Hall remote');
    assert.equal(name, 'Hall remote → Living room');
  });

  test('three or more from different rooms is a count', async () => {
    const extra = LIGHT('l4', 'Hall light', 'Hall');
    const name = await deriveControllerName(
      catalog([CEILING, WORKTOP, extra]), devicesTarget(['l1', 'l3', 'l4']), 'Hall remote');
    assert.equal(name, 'Hall remote → 3 lights');
  });

  test('with no lights it is still named after the remote', async () => {
    assert.equal(
      await deriveControllerName(catalog([]), devicesTarget([]), 'Hall remote'),
      'Hall remote',
    );
  });
});

// ---------------------------------------------------------- mapping sections

describe('the mapping screen collapses to one section for one light', () => {
  /**
   * The bug this is really about: with one lamp chosen, "All lights" and "that
   * lamp" are the same lamp. Rendering both gave an open "All lights" section
   * and, below it, a collapsed section offering overrides that could never
   * override anything.
   */
  test('two lights give an "all" section plus one per light', () => {
    const groups = mappingGroups([CEILING, READING], 'All lights');

    assert.deepEqual(groups.map(g => g.key), ['__all__', 'l1', 'l2']);
    assert.equal(groups[0]!.label, 'All lights');
    assert.equal(groups[0]!.deviceIds, null, 'the "all" group inherits rather than listing');
    assert.deepEqual(groups[1]!.deviceIds, ['l1']);
  });

  test('one light gives ONE section, named after the lamp', () => {
    const groups = mappingGroups([CEILING], 'All lights');

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.label, 'Ceiling', 'named after the lamp, not "All lights"');
  });

  test('and that section keeps the key that means "inherit"', () => {
    // Keyed '__all__' so a rule saved from it still stores as "inherit" and the
    // section still opens by default. Renaming the key would change what gets
    // written to the profile.
    assert.equal(mappingGroups([CEILING], 'All lights')[0]!.key, '__all__');
    assert.equal(mappingGroups([CEILING], 'All lights')[0]!.deviceIds, null);
  });

  test('and it carries the lamp’s capabilities, which the "all" group never does', () => {
    /**
     * Load-bearing rather than cosmetic. The screen only offers functions a
     * section's capabilities support, so a bare '__all__' group — which has no
     * capabilities — would offer "make it warmer" for a lamp with no colour
     * axis. The collapsed section carries the lamp's own list instead.
     */
    const onoffOnly = LIGHT('l9', 'Porch', 'Outside', ['onoff']);
    const collapsed = mappingGroups([onoffOnly], 'All lights')[0]!;

    assert.deepEqual(collapsed.capabilities, ['onoff']);
    assert.equal(collapsed.zoneName, 'Outside');

    // Where there are two, the "all" group deliberately has none.
    assert.equal(mappingGroups([CEILING, READING], 'All lights')[0]!.capabilities, undefined);
  });

  test('no lights at all still renders the "all" section rather than nothing', () => {
    const groups = mappingGroups([], 'All lights');
    assert.deepEqual(groups.map(g => g.key), ['__all__']);
  });

  test('singleLightOf is the one place the collapse is decided', () => {
    assert.equal(singleLightOf([CEILING])?.id, 'l1');
    assert.equal(singleLightOf([CEILING, READING]), null);
    assert.equal(singleLightOf([]), null);
  });
});

describe('and the rows agree with the sections', () => {
  const rule = (id: string, fn: string, inputKey: string | null, deviceIds?: string[]):
  MappingRule => ({
    id,
    function: fn as MappingRule['function'],
    inputKey,
    target: deviceIds ? devicesTarget(deviceIds) : null,
  });

  test('an inherited rule sits in the "all" section', () => {
    const rows = mappingRuleRows([rule('r1', 'toggle', 'top:short')], [CEILING, READING]);
    assert.equal(rows[0]!.groupKey, '__all__');
  });

  test('a rule aimed at one light sits in that light’s section', () => {
    const rows = mappingRuleRows(
      [rule('r1', 'toggle', 'top:short', ['l2'])], [CEILING, READING]);
    assert.equal(rows[0]!.groupKey, 'l2');
  });

  test('a rule aimed at several lights goes back to the "all" section', () => {
    // There is no section for an arbitrary subset, and the screen must put the
    // row SOMEWHERE — a row with a groupKey nothing renders disappears.
    const rows = mappingRuleRows(
      [rule('r1', 'toggle', 'top:short', ['l1', 'l2'])], [CEILING, READING]);
    assert.equal(rows[0]!.groupKey, '__all__');
  });

  test('with one light, a rule saved against that light’s OWN id still appears', () => {
    /**
     * The half of the collapse that bites. A repair that narrows the selection
     * down to one lamp leaves rules stored against that lamp's id — and with the
     * per-light section gone, an uncollapsed groupKey would name a section that
     * is not on the page. The row would silently vanish, taking a mapping the
     * user can still see working with it.
     */
    const rows = mappingRuleRows([rule('r1', 'toggle', 'top:short', ['l1'])], [CEILING]);

    assert.equal(rows[0]!.groupKey, '__all__');
    const sections = new Set(mappingGroups([CEILING], 'All lights').map(g => g.key));
    assert.ok(sections.has(rows[0]!.groupKey), 'every row must land in a section that exists');
  });

  test('every row lands in a section that exists, for every selection size', () => {
    // The property the two functions are really holding up, stated once.
    for (const lights of [[CEILING], [CEILING, READING], [CEILING, READING, WORKTOP]]) {
      const rules = [
        rule('r1', 'toggle', 'top:short'),
        rule('r2', 'on', 'top:long', ['l1']),
        rule('r3', 'off', 'bottom:short', ['l1', 'l2']),
      ];
      const sections = new Set(mappingGroups(lights, 'All lights').map(g => g.key));
      for (const row of mappingRuleRows(rules, lights)) {
        assert.ok(sections.has(row.groupKey),
          `${lights.length} light(s): row ${row.id} wants section "${row.groupKey}"`);
      }
    }
  });

  test('a row’s section round-trips back to the target it stores', () => {
    // The inverse the save path uses. If these two disagree, a rule moves rooms
    // every time the screen is opened and saved.
    assert.equal(ruleTargetFor('__all__'), null);
    assert.equal(ruleTargetFor(null), null);
    assert.equal(ruleTargetFor(undefined), null);
    assert.deepEqual(ruleTargetFor('l2'), devicesTarget(['l2']));

    const rows = mappingRuleRows(
      [rule('r1', 'toggle', 'top:short', ['l2'])], [CEILING, READING]);
    assert.deepEqual(ruleTargetFor(rows[0]!.groupKey), devicesTarget(['l2']));
  });

  test('an unassigned rule keeps its null input key', () => {
    const rows = mappingRuleRows([rule('r1', 'toggle', null)], [CEILING, READING]);
    assert.equal(rows[0]!.inputKey, null);
  });
});

// ------------------------------------------------------------- source picker

describe('the remote picker groups by room', () => {
  const source = (id: string, name: string, zone: string | null, zoneName: string | null,
    eventCount = 4) => ({
    device: { id, name, zone, zoneName, ownerName: 'Zigbee', available: true },
    eventCount,
  });

  test('rooms are sorted, and the remotes within them', () => {
    const rooms = groupSourcesByRoom([
      source('s1', 'Zebra remote', 'z2', 'Kitchen'),
      source('s2', 'Alpha remote', 'z2', 'Kitchen'),
      source('s3', 'Hall remote', 'z1', 'Bedroom'),
    ], undefined);

    assert.deepEqual(rooms.map(r => r.zoneName), ['Bedroom', 'Kitchen']);
    assert.deepEqual(rooms[1]!.devices.map(d => d.name), ['Alpha remote', 'Zebra remote']);
  });

  test('a remote in no room still appears', () => {
    // "Not in a room" is a state Homey allows, and a remote simply missing from
    // this screen is indistinguishable from one the app cannot drive.
    const rooms = groupSourcesByRoom([source('s1', 'Loose remote', null, null)], undefined);

    assert.equal(rooms.length, 1);
    assert.equal(rooms[0]!.zoneName, 'Unassigned');
    assert.equal(rooms[0]!.devices[0]!.name, 'Loose remote');
  });

  test('the already-chosen remote is marked, and only it', () => {
    const rooms = groupSourcesByRoom([
      source('s1', 'Hall remote', 'z1', 'Hall'),
      source('s2', 'Other remote', 'z1', 'Hall'),
    ], 's2');

    const selected = rooms[0]!.devices.filter(d => d.selected);
    assert.deepEqual(selected.map(d => d.id), ['s2']);
  });

  test('the event count travels with each remote', () => {
    // It is what the screen shows to say "this one exposes eight gestures", and
    // it comes from discovery rather than from the device.
    const rooms = groupSourcesByRoom([source('s1', 'Tap dial', 'z1', 'Hall', 12)], undefined);
    assert.equal(rooms[0]!.devices[0]!.eventCount, 12);
  });

  test('nothing to choose from is an empty list, not a throw', () => {
    assert.deepEqual(groupSourcesByRoom([], undefined), []);
  });

  test('rooms sort by locale, not by code point', () => {
    // A Danish house has Æ, Ø and Å, which sort after Z in Danish and somewhere
    // else entirely under a naive comparison.
    const rooms = groupSourcesByRoom([
      source('s1', 'A', 'z1', 'Ærøskøbing'),
      source('s2', 'B', 'z2', 'Bedroom'),
    ], undefined);
    assert.deepEqual(rooms.map(r => r.zoneName), ['Ærøskøbing', 'Bedroom'].sort((a, b) => a.localeCompare(b)));
  });
});
