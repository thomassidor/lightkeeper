import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LightTargetAdapter } from '../../lib/outputs/light-target-adapter';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { assessTargets } from '../../lib/runtime/target-health';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService, Unsubscribe } from '../../lib/homey-api-service';
import { ownsNothing, zoneLights } from '../support/fake-catalog';

/**
 * A lamp that stops taking writes, and how long it takes anybody to notice.
 *
 * Measured on hardware (probe run, 3 September 2026): a Hue bulb reported
 * `available: true` for eighteen minutes while 93 of 113 writes to it failed
 * with "The device could not be reached. Is it powered on?" — and the twenty
 * that succeeded were ALL `light_mode`, which the Hue app satisfies locally
 * without reaching the bulb. Nothing in the app turned any of that into a state
 * a person could see: the failures were logged, and only a log.
 *
 * The two halves are tested apart because they fail differently. The adapter
 * decides WHEN a lamp counts as gone — where the whole risk of false positives
 * lives — and `assessTargets()` decides what that means for a device's tile.
 */

const UNREACHABLE = 'The device could not be reached. Is it powered on?';

function rig(options: { failing?: () => boolean } = {}) {
  const failing = options.failing ?? (() => true);
  const attempts: string[] = [];

  const device = {
    capabilities: ['onoff', 'dim', 'light_mode', 'light_temperature'],
    capabilitiesObj: {},
    async setCapabilityValue({ capabilityId }: { capabilityId: string }) {
      attempts.push(capabilityId);
      // `light_mode` lands even on an unreachable bulb — the Hue app satisfies
      // it without going to the bridge. That is the whole reason it cannot be
      // allowed to clear a streak.
      if (capabilityId !== 'light_mode' && failing()) throw new Error(UNREACHABLE);
    },
    makeCapabilityInstance: () => ({ destroy: () => { /* noop */ } }),
  };

  const api = {
    async read() { return { devices: { getDevice: async () => device } }; },
    track: (unsubscribe: Unsubscribe) => unsubscribe,
  } as unknown as HomeyApiService;

  const logs: string[] = [];
  const adapter = new LightTargetAdapter(
    api, new TargetStateCache(), (...args) => logs.push(args.join(' ')),
  );
  return { adapter, attempts, logs };
}

/** Swallowed: `write()` rethrows, and every caller of it already catches. */
async function attempt(
  adapter: LightTargetAdapter,
  capability: 'onoff' | 'dim' | 'light_mode' | 'light_temperature',
  value: boolean | number | string,
  options: { preStage?: boolean } = {},
): Promise<void> {
  await adapter.write('lamp', capability, value, options).catch(() => { /* expected */ });
}

const FIVE_MINUTES = 5 * 60_000;

describe('when a target counts as not responding', () => {
  test('three failures are not enough on their own', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);

    // The count is met and the clock is not. A ramp is ten seconds at five
    // writes a second, so a count-only threshold would fire right here — on a
    // lamp somebody was merely holding a dim button at.
    assert.deepEqual([...adapter.unwritableTargets()], []);
  });

  test('a whole ramp of failures inside ten seconds never trips it', async () => {
    const { adapter } = rig();
    // HARD_STOP_MS over minWriteIntervalMs is fifty writes, all failing.
    for (let i = 0; i < 50; i += 1) await attempt(adapter, 'dim', 0.5);

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + 10_000)], []);
  });

  test('five minutes of failures does trip it', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp']);
  });

  test('two failures five minutes apart are still not enough', async () => {
    const { adapter } = rig();
    await attempt(adapter, 'dim', 0.5);
    await attempt(adapter, 'dim', 0.5);

    // A twice-a-day schedule missing two windows says nothing about the lamp.
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);
  });

  test('a light_mode success does NOT clear the streak', async () => {
    const { adapter, attempts } = rig();
    for (let i = 0; i < 3; i += 1) {
      // Exactly what the scheduler sends for a temperature: the enabler, then
      // the value it enables. On the reference lamp the first landed and the
      // second did not, twenty times over.
      await attempt(adapter, 'light_mode', 'temperature');
      await attempt(adapter, 'light_temperature', 0.5);
    }

    assert.ok(attempts.includes('light_mode'), 'the mode write really was attempted');
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp'],
      'a lamp that only ever acks light_mode is not a working lamp');
  });

  test('one real success clears it, with no separate healing path', async () => {
    let broken = true;
    const { adapter } = rig({ failing: () => broken });
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp']);

    broken = false;
    await attempt(adapter, 'dim', 0.5);

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);
  });

  test('crossing the threshold is not announced before it is crossed', async () => {
    const { adapter, logs } = rig();
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);

    // Every individual failure is already logged by the scheduler's onError.
    // The line this adds says "it has now been failing long enough to count",
    // and saying that at second three would be the false positive in words.
    assert.equal(logs.filter(l => l.includes('not responding')).length, 0);
  });

  /**
   * A colour written to a lamp that is OFF, refused by the integration.
   *
   * Measured 4 September 2026: 4 of 13 Hue bulbs behind one bridge answer
   * `is "soft off", command (.color_temperature.mirek) may not have effect`
   * to every colour write while they are off; 9 on the same bridge take it and
   * stay off. A curve retries a failed write every tick by design, so before
   * this the household's healthy lamps reported themselves as not responding
   * for as long as anybody had them switched off.
   */
  test('a colour refused by a lamp that is off is evidence of nothing', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) {
      await attempt(adapter, 'light_temperature', 0.5, { preStage: true });
    }

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);
  });

  test('but the same write to a lit lamp still counts', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'light_temperature', 0.5);

    // The exclusion is the caller's flag and nothing else. Widen it to "a
    // colour axis" or "the lamp is off" and this is the test that fails.
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp']);
  });

  test('a pre-stage SUCCESS still clears a standing streak', async () => {
    let broken = true;
    const { adapter } = rig({ failing: () => broken });
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp']);

    // One-directional, unlike light_mode: that ack never left the phone, while
    // this one reached the bridge and the bridge did not refuse it. Excluding
    // successes too would leave a lamp that failed three lit writes at nine
    // "not responding" all night, with nothing able to clear it.
    broken = false;
    await attempt(adapter, 'light_temperature', 0.5, { preStage: true });

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);
  });

  test('an off lamp that refuses everything is still found once anything real is written', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) {
      await attempt(adapter, 'light_temperature', 0.5, { preStage: true });
    }
    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);

    // The bounded cost of the exclusion, stated as a test: a dead lamp spoken
    // to only speculatively builds no streak, and accounting resumes in full
    // the moment anything real is written to it.
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], ['lamp']);
  });

  test('a device that stops being a target takes its streak with it', async () => {
    const { adapter } = rig();
    for (let i = 0; i < 3; i += 1) await attempt(adapter, 'dim', 0.5);
    await adapter.unsubscribe('lamp');

    assert.deepEqual([...adapter.unwritableTargets(Date.now() + FIVE_MINUTES)], []);
  });
});

function catalogue(devices: Array<{ id: string; available?: boolean }>): DeviceCatalog {
  const full = devices.map(d => ({
    id: d.id, name: d.id, class: 'light', virtualClass: null, zone: 'z', zoneName: 'Kitchen',
    driverId: null, ownerUri: null, ownerName: '', capabilities: ['onoff', 'dim'],
    capabilitiesObj: {}, available: d.available !== false,
  }));
  return {
    device: async (id: string) => full.find(d => d.id === id),
    devicesInZone: async () => full,
    lightsInZone: zoneLights(async () => full),
    isOwnDevice: ownsNothing,
  } as unknown as DeviceCatalog;
}

const target = (ids: string[]) => ({ kind: 'devices' as const, deviceIds: ids });

describe('what not responding does to the verdict', () => {
  test('nothing at all when nobody asks — the pairing rigs', async () => {
    const verdict = await assessTargets(catalogue([{ id: 'a' }]), target(['a']));
    assert.equal(verdict.state, 'ready');
    assert.equal(verdict.count.unwritable, 0);
  });

  test('some of them not responding is partial, and says how many', async () => {
    const verdict = await assessTargets(
      catalogue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      target(['a', 'b', 'c']),
      new Set(['b']),
    );
    assert.equal(verdict.state, 'partial');
    assert.equal(verdict.detail?.key, 'state.someTargetsNotResponding');
    assert.deepEqual(verdict.detail?.tokens, { count: 1, total: 3 });
  });

  test('all of them not responding is needs_repair', async () => {
    const verdict = await assessTargets(
      catalogue([{ id: 'a' }, { id: 'b' }]), target(['a', 'b']), new Set(['a', 'b']),
    );
    assert.equal(verdict.state, 'needs_repair');
    assert.equal(verdict.detail?.key, 'state.noTargetsResponding');
  });

  test('"not responding" outranks "unavailable" when both are true', async () => {
    /**
     * Two of four have gone away and the other two stopped answering. "2 lights
     * are not responding" sends somebody to a wall switch; "2 of 4 lights
     * unavailable" sends them looking for a light that is sitting right there.
     */
    const verdict = await assessTargets(
      catalogue([
        { id: 'a' }, { id: 'b' },
        { id: 'c', available: false }, { id: 'd', available: false },
      ]),
      target(['a', 'b', 'c', 'd']),
      new Set(['a', 'b']),
    );
    assert.equal(verdict.state, 'needs_repair');
    assert.equal(verdict.detail?.key, 'state.noTargetsResponding');
  });

  test('a light Homey already calls unavailable is not counted twice', async () => {
    // It cannot be both gone and refusing: `unwritable` is counted only among
    // the ones still reported available, or one lamp switched off at the wall
    // turns up in two different sentences about two different problems.
    const verdict = await assessTargets(
      catalogue([{ id: 'a' }, { id: 'b', available: false }]),
      target(['a', 'b']),
      new Set(['b']),
    );
    assert.equal(verdict.count.unwritable, 0);
    assert.equal(verdict.detail?.key, 'state.someTargets');
  });

  test('an id nobody here is failing leaves an ordinary verdict alone', async () => {
    const verdict = await assessTargets(
      catalogue([{ id: 'a' }]), target(['a']), new Set(['somebody-elses-lamp']),
    );
    assert.equal(verdict.state, 'ready');
  });
});
