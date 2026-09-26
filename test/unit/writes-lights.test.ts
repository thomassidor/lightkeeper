import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  keepsLightsUpdated, writesLightsField, writesLightsFrom,
} from '../../lib/runtime/writes-lights';
import {
  validateCircadianPlan, validateDaylightPlan, validateSimpleCircadianPlan,
} from '../../lib/validation/plans';
import { DEFAULT_POINTS } from '../../lib/circadian/circadian-types';
import { DEFAULT_ZONES, expandSimplePlan, foldBackSimplePlan } from '../../lib/circadian/simple-curve';
import { DEFAULT_RESPONSE } from '../../lib/daylight/daylight-types';
import { groupMembersOf } from '../../lib/device-catalog';
import { sharedLightCount, sourceRows, type SourceDevice } from '../../lib/pairing/source-picker';

/**
 * "Keep these lights up to date" — whether an engine device writes to its lamps
 * or only publishes what it wants them to be.
 *
 * The property everything here protects is the one that is easy to get backwards:
 * the flag is opt-OUT. Every circadian, curve and Room-sensing device paired
 * before it existed has no key, and must go on writing exactly as it did. The
 * `preStage` field beside it is opt-IN and read `=== true`; copying that line
 * would have silently stopped every one of those devices on update.
 */

const circadian = () => ({
  schemaVersion: 2,
  enabled: true,
  target: { kind: 'devices', deviceIds: ['l1'] },
  points: DEFAULT_POINTS.map(p => ({ ...p })),
  adjustBrightness: false,
  transition: 'balanced' as const,
  preStage: false,
});

const simple = () => ({
  schemaVersion: 2,
  enabled: true,
  target: { kind: 'devices' as const, deviceIds: ['l1'] },
  zones: DEFAULT_ZONES,
  adjustBrightness: false,
  transition: 'balanced' as const,
  preStage: false,
});

const daylight = () => ({
  schemaVersion: 2,
  enabled: true,
  target: { kind: 'devices', deviceIds: ['l1'] },
  response: { ...DEFAULT_RESPONSE },
});

describe('the flag is opt-out', () => {
  test('an absent key means the device writes', () => {
    assert.equal(keepsLightsUpdated({}), true);
  });

  test('only a real false turns it off', () => {
    assert.equal(keepsLightsUpdated({ writesLights: false }), false);
    assert.equal(keepsLightsUpdated({ writesLights: true }), true);
  });

  test('it is stored only when it says no', () => {
    assert.deepEqual(writesLightsField(true), {});
    assert.deepEqual(writesLightsField(false), { writesLights: false });
  });

  test('a screen that leaves it out, or sends junk, keeps what the session held', () => {
    assert.equal(writesLightsFrom({}, true), true);
    assert.equal(writesLightsFrom({}, false), false);
    assert.equal(writesLightsFrom({ writesLights: 'no' }, true), true);
    assert.equal(writesLightsFrom(null, true), true);
    assert.equal(writesLightsFrom({ writesLights: false }, true), false);
    assert.equal(writesLightsFrom({ writesLights: true }, false), true);
  });
});

describe('every store carries it, and a store that never had it is untouched', () => {
  for (const [name, validate, make] of [
    ['a Colour Curve Light', validateCircadianPlan, circadian],
    ['a circadian light', validateSimpleCircadianPlan, simple],
    ['a Room-sensing Light', validateDaylightPlan, daylight],
  ] as const) {
    test(`${name}: a plan paired before the flag round-trips to exactly itself`, () => {
      const stored = validate(make() as never);
      assert.deepEqual(stored, make());
      assert.equal(keepsLightsUpdated(stored), true);
    });

    test(`${name}: false survives validation`, () => {
      const stored = validate({ ...make(), writesLights: false } as never);
      assert.equal(stored.writesLights, false);
    });

    test(`${name}: true, or anything else, is stored as nothing — which reads as on`, () => {
      for (const value of [true, 'false', 0, null]) {
        const stored = validate({ ...make(), writesLights: value } as never);
        assert.equal('writesLights' in stored, false, `stored ${JSON.stringify(value)}`);
      }
    });
  }
});

describe('a circadian light carries it into the runtime and back', () => {
  test('expandSimplePlan copies it by name', () => {
    assert.equal(expandSimplePlan({ ...simple(), writesLights: false }).writesLights, false);
    assert.equal('writesLights' in expandSimplePlan(simple()), false);
  });

  test('the fold-back keeps it, because the runtime never changes it', () => {
    const folded = foldBackSimplePlan({ ...simple(), writesLights: false }, { enabled: true, preStage: false });
    assert.equal(folded.writesLights, false);
  });
});

describe('a Homey device group is the lamps inside it', () => {
  const group = (settings: unknown) => ({ driverId: 'homey:virtualdrivergroup:driver', settings });

  test('its members come from settings.deviceIds', () => {
    assert.deepEqual(groupMembersOf(group({ deviceIds: ['a', 'b'] })), { groupMembers: ['a', 'b'] });
  });

  test('anything else is no membership rather than a guess', () => {
    assert.deepEqual(groupMembersOf(group({ deviceIds: 'a' })), {});
    assert.deepEqual(groupMembersOf(group(null)), {});
    assert.deepEqual(groupMembersOf(group({ deviceIds: [] })), {});
    assert.deepEqual(groupMembersOf(group({ deviceIds: [1, '', 'a'] })), { groupMembers: ['a'] });
  });

  test("another driver's deviceIds setting is not a group", () => {
    assert.deepEqual(groupMembersOf({ driverId: 'homey:app:x:y', settings: { deviceIds: ['a'] } }), {});
  });
});

describe('how many of a button\'s lamps another device drives', () => {
  const none = () => undefined;

  test('plain ids intersect', () => {
    assert.equal(sharedLightCount(['a', 'b', 'c'], ['b', 'c', 'd'], none), 2);
    assert.equal(sharedLightCount(['a'], ['b'], none), 0);
  });

  test('the case it was written for: the remote holds a group, the curve its members', () => {
    // "Cieling Lamp" on the reference Homey: a group of three spots, driven by
    // the remote as one lamp and by a Colour Curve Light as three.
    const members = (id: string) => (id === 'ceiling' ? ['spotC', 'spotL', 'spotR'] : undefined);
    assert.equal(
      sharedLightCount(['ceiling', 'music', 'desk'], ['spotC', 'spotL', 'spotR', 'music', 'desk'], members),
      5,
    );
  });

  test('a group on the SOURCE side is expanded too', () => {
    const members = (id: string) => (id === 'g' ? ['a', 'b'] : undefined);
    assert.equal(sharedLightCount(['a', 'x'], ['g'], members), 1);
  });
});

describe('the source picker warns about a device that drives its own lights', () => {
  const device = (over: Partial<SourceDevice>): SourceDevice => ({
    id: 'lk-1', name: 'Studio curve', subtitle: '', values: {}, ...over,
  });
  const leaveAlone = { name: 'Leave it alone', subtitle: '' };

  test('a device that keeps its lights up to date carries the warning, with the overlap', () => {
    const [, row] = sourceRows('brightness', [device({ keepsLightsUpdated: true, sharedLights: 3 })], leaveAlone);
    assert.deepEqual(row.warn, { sharedLights: 3 });
  });

  test('one that only publishes does not, and nor does one that never said', () => {
    const rows = sourceRows('brightness', [
      device({ id: 'a', keepsLightsUpdated: false, sharedLights: 3 }),
      device({ id: 'b' }),
    ], leaveAlone);
    assert.equal(rows.some(row => 'warn' in row), false);
  });

  test('"leave it alone" never warns', () => {
    const [first] = sourceRows('colour', [device({ keepsLightsUpdated: true })], leaveAlone);
    assert.equal('warn' in first, false);
  });
});
