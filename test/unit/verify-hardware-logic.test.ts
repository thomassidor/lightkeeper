import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  clamp, round, mb, minutesOf, messageOf, runtimeId, markName, isMarked, MARKER,
  lampOverlaps, controllersWithASleepingRemote, lampsDrivenByTheirOwnDevices,
  pssBytesIn, verdictFor, MEMORY_CEILING_MB, MEMORY_GUIDELINE_MB,
  lampDrift, restoreSequence, withManifest, dtoFrom, chooseLamps, testScope,
  expectedPublished, publishedMismatches, conditionResult, darknessCases, flowLamps,
  lightsArgument, sourceExpectations, pickerProblems, levelProblems, ROUND_TRIPS,
  settingsGaps, orphanPreviewProblems, orphanRefusalVerdict, checkoutVersion,
  READ_ONLY, DESTRUCTIVE, FULL, results,
} from '../../scripts/verify-hardware.mjs';
import { parseArgs } from '../../scripts/verify/args.mjs';
import { createUndoStack, installInterruptHandlers } from '../../scripts/verify/undo.mjs';
import { summarise, jsonReport, buildShapeFrom } from '../../scripts/verify/outcome.mjs';
import { targetChoiceId } from '../../lib/flow/flow-arguments';

/**
 * The hardware script's own decisions, RUN rather than read.
 *
 * `verify-hardware-safety.test.ts` reads the script as text, because what it
 * holds up — no key printed, no unmarked device deleted — is a property of the
 * source. This file is the other half: the script is imported (its `main()` is
 * guarded on being the entry point, so importing runs nothing) and its pure
 * decisions are exercised against fakes. Every one of them decides what the
 * pass does to a household's Homey — which lamp it picks, what a restore writes,
 * what an interrupt puts back — and none of them could be tested while the
 * script ran itself on import.
 *
 * Nothing here reaches a network. The fakes are the smallest shape each helper
 * reads.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Run `fn` with the script's own console output swallowed. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

describe('the small helpers', () => {
  test('numbers, names and ids', () => {
    assert.equal(clamp(1.4, 0, 1), 1);
    assert.equal(clamp(-0.2, 0, 1), 0);
    assert.equal(round(0.12345), '0.123');
    assert.equal(round('warm'), 'warm');
    // Under 4096 is already megabytes; anything bigger is bytes.
    assert.equal(mb(30.64), 30.6);
    assert.equal(mb(48 * 1024 * 1024), 48);
    assert.equal(minutesOf('20:30'), 1230);
    assert.equal(minutesOf('24:00'), 0);
    // The two spellings of one identity, controllerId first.
    assert.equal(runtimeId({ controllerId: 'a', id: 'b' }), 'a');
    assert.equal(runtimeId({ id: 'b' }), 'b');
    assert.equal(runtimeId(null), '');
    assert.equal(markName('Desk'), `${MARKER} Desk`);
    assert.ok(isMarked(`  ${MARKER} Desk`));
    assert.ok(!isMarked('Desk [verify]'), 'the mark is a PREFIX, so a rename suffix cannot fake it');
  });

  test('an Express 404 page becomes one sentence naming the stale install', () => {
    const page = '<!DOCTYPE html><html><body><pre>Cannot GET /api/app/x/evidence</pre></body></html>';
    const message = messageOf(new Error(page));
    assert.match(message, /has no GET \/api\/app\/x\/evidence/);
    assert.match(message, /npx homey app install/);
    assert.doesNotMatch(message, /DOCTYPE/);
    assert.equal(messageOf(new Error('plain')), 'plain');
  });
});

describe('which lamps the pass may touch', () => {
  const devices = {
    g: { id: 'g', driverId: 'homey:virtualdrivergroup:light', settings: { deviceIds: ['m1', 'm2'] } },
    m1: { id: 'm1', driverId: 'homey:app:hue:bulb' },
    m2: { id: 'm2', driverId: 'homey:app:hue:bulb' },
    p: { id: 'p', driverId: 'homey:app:ikea:bulb' },
  };
  const api = { devices: { getDevices: async () => devices } };

  test('lampOverlaps reads group membership both ways, and a lone lamp overlaps itself', async () => {
    const overlaps = await lampOverlaps(api);
    assert.deepEqual([...overlaps.get('g')!].sort(), ['g', 'm1', 'm2']);
    assert.deepEqual([...overlaps.get('m1')!].sort(), ['g', 'm1']);
    assert.deepEqual([...overlaps.get('p')!], ['p']);
  });

  test("lamps the user's own devices drive are expanded through groups, and [verify] devices are not counted", async () => {
    const overlaps = await lampOverlaps(api);
    const app = {
      get: async () => ({
        circadian: [
          { name: 'Studio curve', targetIds: ['m1'] },
          { name: markName('left over'), targetIds: ['p'] },
        ],
      }),
    };
    const busy = await lampsDrivenByTheirOwnDevices(app, overlaps);
    assert.deepEqual([...busy].sort(), ['g', 'm1'], 'the group holding m1 is busy too; p is only ours');
  });

  test('chooseLamps: warm first, free first, and never two picks that share a bulb', async () => {
    const overlaps = await lampOverlaps(api);
    const rooms = [
      {
        zoneName: 'Studio',
        lights: [
          { id: 'g', name: 'Group', capabilities: ['onoff', 'light_temperature'] },
          { id: 'm1', name: 'Spot 1', capabilities: ['onoff', 'light_temperature'] },
          { id: 'm2', name: 'Spot 2', capabilities: ['onoff', 'light_temperature'] },
          { id: 'p', name: 'Plug lamp', capabilities: ['onoff', 'dim'] },
          { id: 'x', name: 'Dead', capabilities: ['onoff'], available: false },
        ],
      },
      { zoneName: 'Hall', lights: [{ id: 'h', name: 'Hall', capabilities: ['onoff'] }] },
    ];

    const free = chooseLamps(rooms, 'Studio', new Set(), overlaps);
    assert.ok(!('error' in free));
    if ('error' in free) return;
    assert.deepEqual(free.picks.map(l => l.id), ['g', 'p'], 'the group takes both of its members');
    assert.equal(free.chosen.circadian.id, 'g');
    assert.equal(free.chosen.curve.id, 'p');
    // Fewer than five distinct lamps: the rest clamp to the last, and say so.
    assert.equal(free.chosen.daylight.id, 'p');
    assert.ok(!free.all.some(l => l.id === 'x'), 'an unavailable lamp is never offered');
    assert.ok(!free.all.some(l => l.id === 'h'), 'another room is never offered');

    const busy = chooseLamps(rooms, 'Studio', new Set(['g']), overlaps);
    if ('error' in busy) throw new Error(busy.error);
    assert.deepEqual(busy.picks.map(l => l.id), ['m1', 'p'],
      'a lamp nobody drives comes before the group the user drives');

    const nowhere = chooseLamps(rooms, 'Attic', new Set(), overlaps);
    assert.ok('error' in nowhere && /no room called "Attic"/.test(nowhere.error));
  });

  test('flowLamps refuses a lamp the user drives, prefers one nothing drives, and never shares a bulb', async () => {
    const overlaps = await lampOverlaps(api);
    const lamps = [{ id: 'g' }, { id: 'm1' }, { id: 'm2' }, { id: 'p' }];
    // The user drives m2 — and through the group, g.
    const busy = new Set(['m2', 'g']);
    const ours = new Set(['m1']);
    assert.deepEqual(flowLamps(lamps, busy, ours, overlaps, 2).map(l => l.id), ['p', 'm1']);
    assert.deepEqual(flowLamps(lamps, new Set(['g', 'm1', 'm2', 'p']), ours, overlaps), []);
  });

  test("the set_lights lights argument is the app's own encoding", () => {
    assert.equal(lightsArgument(['a', 'b']), targetChoiceId({ kind: 'devices', deviceIds: ['a', 'b'] }));
  });

  test('"Test my lights" stays in the room unless --house is typed, and refuses with neither', () => {
    assert.deepEqual(testScope({ room: 'Studio', house: false }), { room: 'Studio' });
    assert.deepEqual(testScope({ room: 'Studio', house: true }), { room: '' });
    const refused = testScope({ room: '', house: false });
    assert.ok('skip' in refused && /--house/.test(refused.skip) && /HOMEY_TEST_ROOM/.test(refused.skip));
  });

  test('a sleeping remote is excused only while the remote still EXISTS', async () => {
    const app = {
      get: async () => ({
        controllers: [
          { controllerId: 'c1', source: { deviceId: 'r1', name: 'BILRESA' } },
          { controllerId: 'c2', source: { deviceId: 'gone', name: 'Deleted' } },
          { controllerId: 'c3', source: { deviceId: 'r3', name: 'Awake' } },
        ],
      }),
    };
    const live: Record<string, unknown> = { r1: { available: false }, r3: { available: true } };
    const fake = {
      devices: {
        getDevice: async ({ id }: { id: string }) => {
          if (!(id in live)) throw new Error('Not Found');
          return live[id];
        },
      },
    };
    const asleep = await controllersWithASleepingRemote(fake, app);
    assert.deepEqual([...asleep], [['c1', 'BILRESA']]);
  });
});

describe('what a lamp is judged by, and what putting it back writes', () => {
  test('lampDrift: an off lamp is judged on onoff alone; hue wraps; the tolerance has an epsilon', () => {
    const lamp = (values: Record<string, unknown>) => ({ values });
    assert.deepEqual(lampDrift(lamp({ onoff: false, dim: 0.2 }), lamp({ onoff: false, dim: 0.9 })), []);
    assert.equal(lampDrift(lamp({ onoff: true }), lamp({ onoff: false })).length, 1);
    assert.deepEqual(lampDrift(lamp({ onoff: true, light_hue: 0.99 }), lamp({ onoff: true, light_hue: 0.01 })), []);
    // 0.53 - 0.50 is 0.030000000000000027 in floating point: still inside 0.03.
    assert.deepEqual(lampDrift(lamp({ onoff: true, dim: 0.5 }), lamp({ onoff: true, dim: 0.53 })), []);
    assert.equal(lampDrift(lamp({ onoff: true, dim: 0.5 }), lamp({ onoff: true, dim: 0.54 })).length, 1);
  });

  test('restoreSequence writes the axis of the mode the lamp was in, mode first and dim last', () => {
    const base = { light_temperature: 0.7, light_hue: 0.3, light_saturation: 0.8, dim: 0.4 };
    assert.deepEqual(restoreSequence({ ...base, light_mode: 'temperature' }).map(([c]) => c),
      ['light_mode', 'light_temperature', 'dim'],
      'a warm-white lamp must not be left on its stale hue');
    assert.deepEqual(restoreSequence({ ...base, light_mode: 'color' }).map(([c]) => c),
      ['light_mode', 'light_hue', 'light_saturation', 'dim']);
    assert.deepEqual(restoreSequence(base).map(([c]) => c),
      ['light_temperature', 'light_hue', 'light_saturation', 'dim'], 'no mode known: everything, as before');
    assert.deepEqual(restoreSequence({ dim: 0.1 }), [['dim', 0.1]]);
  });
});

describe('memory', () => {
  test('pssBytesIn prefers an exact pss, searches nested shapes, and survives a cycle', () => {
    assert.deepEqual(pssBytesIn({ memory: 5, pss: 10 }), { bytes: 10, field: 'pss' });
    assert.deepEqual(pssBytesIn({ a: { b: { rss: 100 } } }), { bytes: 100, field: 'rss' });
    assert.equal(pssBytesIn({ pss: 0 }), null, 'a zero is no reading, never a pass');
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    assert.equal(pssBytesIn(cyclic), null);
    assert.equal(pssBytesIn(null), null);
  });

  test('verdictFor is three-way: inside the guideline, over it, past the ceiling', () => {
    assert.equal(verdictFor(MEMORY_GUIDELINE_MB - 1, 'x')[0], 'OK');
    assert.equal(verdictFor(MEMORY_GUIDELINE_MB + 1, 'x')[0], 'INFO');
    assert.equal(verdictFor(MEMORY_CEILING_MB + 1, 'x')[0], 'FAILED');
  });
});

describe('the device DTO', () => {
  test('withManifest sends what driver.compose.json declares, and leaves an unknown driver alone', async () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'drivers', 'daylight', 'driver.compose.json'), 'utf8'));
    const dto = { name: 'x', data: { id: 'd1' } };
    const sent = await quiet(() => withManifest(dto, 'daylight'));
    assert.deepEqual(sent.capabilities, manifest.capabilities);
    assert.equal(sent.class, manifest.class);
    assert.equal(sent.data.id, 'd1');
    assert.deepEqual(await quiet(() => withManifest(dto, 'no-such-driver')), dto);
  });

  test('dtoFrom marks the derived name, refuses a save with no device, and ignores a repair', async () => {
    const before = results.length;
    const built = await quiet(() => dtoFrom({ created: true, device: { name: 'Desk curve', data: { id: 'c1' } } }));
    assert.equal(built.name, markName('Desk curve'));
    assert.equal(await quiet(() => dtoFrom({ updated: true })), null);
    assert.equal(await quiet(() => dtoFrom({ created: true })), null);
    assert.equal(results.slice(before).filter(r => r.status === 'FAILED').length, 1);
    results.splice(before);
  });
});

describe('flowcards: the published rows and the two cards', () => {
  test("expectedPublished is each runtime's own arithmetic", () => {
    const curve = expectedPublished('curve', { now: { warmth: 0.6, brightness: 0.5 }, adjustBrightness: false });
    assert.deepEqual(curve, { lightkeeper_temperature: 0.6, lightkeeper_brightness: null });
    const lit = expectedPublished('curve', { now: { warmth: 0.6, brightness: 0.5 }, adjustBrightness: true });
    assert.ok(Math.abs(Number(lit.lightkeeper_brightness) - Math.pow(0.5, 2.2)) < 1e-12);

    const sky = expectedPublished('daylight', { now: { brightness: 0.5, level: 0.3, source: 'sky' } });
    assert.equal(sky.lightkeeper_daylight, 0.3);
    const blind = expectedPublished('daylight', { now: { brightness: 0.5, level: 0.3, source: 'none' } });
    assert.equal(blind.lightkeeper_daylight, null, 'a device that cannot tell publishes no level');
  });

  test('publishedMismatches: a missing row, a wrong number, and a row that should be empty', () => {
    assert.deepEqual(publishedMismatches({ a: 0.5 }, { a: 0.51 }), []);
    assert.match(publishedMismatches({ a: 0.5 }, {})[0]!, /no a row at all/);
    assert.match(publishedMismatches({ a: 0.5 }, { a: 0.6 })[0]!, /holds 0\.600/);
    assert.match(publishedMismatches({ a: null }, { a: 0.2 })[0]!, /expected empty/);
    assert.deepEqual(publishedMismatches({ a: null }, { a: null }), []);
  });

  test('conditionResult never reads an unknown shape as false', () => {
    assert.equal(conditionResult(true), true);
    assert.equal(conditionResult({ result: false }), false);
    assert.equal(conditionResult({}), null);
    assert.equal(conditionResult(undefined), null);
  });

  test('darknessCases asks either side of the level, inside 0..1, and only "false" when it cannot tell', () => {
    assert.deepEqual(darknessCases(0.5), [{ threshold: 0.65, expect: true }, { threshold: 0.35, expect: false }]);
    assert.deepEqual(darknessCases(0.9), [{ threshold: 0.75, expect: false }]);
    assert.deepEqual(darknessCases(0.1), [{ threshold: 0.25, expect: true }]);
    assert.deepEqual(darknessCases(null), [{ threshold: 1, expect: false }]);
  });
});

describe('jobs: the two source pickers', () => {
  const diagnostics = {
    circadian: [{ controllerId: 'curve1', name: 'Curve' }],
    daylight: [{ controllerId: 'day1', name: 'Room', now: { brightness: 0.55 } }],
    schedules: [{ controllerId: 'sch1', name: 'Evening' }],
  };
  const leave = { id: 'none', name: 'Leave it alone' };

  test("colour only from curve-driven devices; brightness from those, Room-sensing Lights and schedules", () => {
    const expected = sourceExpectations(diagnostics);
    assert.deepEqual(expected.colour, ['curve1']);
    assert.deepEqual(expected.brightness.sort(), ['curve1', 'day1', 'sch1']);

    const colour = [leave, { id: 'curve1', swatch: '#fff' }];
    const brightness = [leave, { id: 'curve1', level: 0.3 }, { id: 'day1', level: 0.55 }, { id: 'sch1', level: null }];
    assert.deepEqual(pickerProblems(expected, colour, brightness), []);

    const wrong = pickerProblems(expected, [...colour, { id: 'day1', swatch: null }], brightness.slice(0, 2));
    assert.ok(wrong.some(p => /offers day1, which publishes no colour/.test(p)));
    assert.ok(wrong.some(p => /brightness picker is missing day1/.test(p)));
  });

  test('a brightness row must be the PERCEPTUAL level, and saying so when it is the sent one', () => {
    assert.deepEqual(levelProblems(diagnostics, [{ id: 'day1', level: 0.55 }]),
      { checked: 1, problems: [] });
    const sent = levelProblems(diagnostics, [{ id: 'day1', level: Math.pow(0.55, 2.2) }]);
    assert.equal(sent.checked, 1);
    assert.match(sent.problems[0]!, /value SENT to a lamp/);
    assert.equal(levelProblems(diagnostics, []).checked, 0);
  });
});

describe('repairsave: one harmless edit per device type', () => {
  test('a schedule is edited SHORTER, so a restart can only ever do less', () => {
    const plan = ROUND_TRIPS.schedule!;
    const reply = { entries: [{ id: 'a', onAt: 1200, end: { kind: 'duration', minutes: 120 } }], days: null };
    assert.equal(plan.value(reply), 120);
    assert.equal(plan.nudge!(120), 115);
    const [event, payload] = plan.write(reply, 115) as [string, any];
    assert.equal(event, 'setSchedules');
    assert.equal(payload.entries[0].end.minutes, 115);
    assert.equal(reply.entries[0]!.end.minutes, 120, 'the reply it was built from is not mutated');
    assert.equal(plan.value({ entries: [{ end: { kind: 'time', at: 1320 } }] }), null,
      'a clock-time end is not edited');
  });

  test('circadian, curve and daylight edits stay in range and keep everything else', () => {
    const day = { zones: { morning: { temperature: 0.3 }, midday: { temperature: 0.1 },
      evening: { temperature: 0.8 }, morningEnd: 0, eveningStart: -30 }, adjustBrightness: false };
    const circadian = ROUND_TRIPS.circadian!;
    assert.equal(circadian.nudge!(0.8), 0.75);
    assert.equal(circadian.nudge!(0.2), 0.25);
    const [, dayPayload] = circadian.write(day, 0.75) as [string, any];
    assert.equal(dayPayload.evening.temperature, 0.75);
    assert.equal(dayPayload.eveningStart, -30, 'the boundaries are sent back as they were');

    const curve = ROUND_TRIPS.curve!;
    const [, curvePayload] = curve.write({ points: [{ id: 'p', warmth: 0.3 }, { id: 'q', warmth: 0.9 }] }, 0.35) as [string, any];
    assert.deepEqual(curvePayload.points.map((p: any) => p.warmth), [0.35, 0.9]);

    const daylight = ROUND_TRIPS.daylight!;
    const [, dlPayload] = daylight.write({ response: { darkLux: 5, brightLux: 500 } }, daylight.nudge!(5)) as [string, any];
    assert.deepEqual(dlPayload.response, { darkLux: 6, brightLux: 500 });

    assert.equal(ROUND_TRIPS.controller!.nudge, null, "a Light Remote is saved unchanged: its rules own Flows");
  });
});

describe('settings and the orphan sweep', () => {
  test('settingsGaps names a running device the page cannot show', () => {
    const status = {
      credential: { present: true },
      controllers: [{ id: 'c1', state: 'ready' }], schedules: [], circadian: [], daylight: [],
    };
    assert.deepEqual(settingsGaps(status, { controllers: [{ controllerId: 'c1' }] }), []);
    const gaps = settingsGaps(status, { circadian: [{ controllerId: 'k1', name: 'Kitchen' }] });
    assert.equal(gaps.length, 1);
    assert.match(gaps[0]!, /"Kitchen" runs but cannot describe itself/);
    assert.ok(settingsGaps({ credential: { present: true } }, {}).some(g => /no "daylight" list/.test(g)));
  });

  test('orphanPreviewProblems wants a count, a matching list and a token', () => {
    assert.deepEqual(orphanPreviewProblems({ total: 3, orphans: 1, flowIds: ['f'], token: 't' }), []);
    assert.ok(orphanPreviewProblems({ total: 3, orphans: 2, flowIds: ['f'], token: 't' })
      .some(p => /1 flow id\(s\) for 2 orphan/.test(p)));
    assert.deepEqual(orphanPreviewProblems(null), ['it answered with nothing']);
  });

  test('T180 is asserted only when nothing Flow-owning is left, and is never provoked', () => {
    assert.equal(orphanRefusalVerdict({ flowOwningDevices: 2, preview: {} })[0], 'SKIPPED');
    assert.equal(orphanRefusalVerdict({ flowOwningDevices: 0, preview: { total: 0, orphans: 0 } })[0], 'SKIPPED');
    assert.equal(orphanRefusalVerdict({ flowOwningDevices: 0, preview: { total: 4, orphans: 4, refused: 'no_live_controllers' } })[0], 'OK');
    const leak = orphanRefusalVerdict({ flowOwningDevices: 0, preview: { total: 4, orphans: 4 } });
    assert.equal(leak[0], 'FAILED');
    assert.match(leak[1], /WITHOUT refusing/);
  });
});

describe('the command line', () => {
  test('flags are parsed, a value-taking flag keeps its value out of the commands', () => {
    const parsed = parseArgs(['full', '--yes', '--json', 'temp/r.json', '--strict']);
    assert.deepEqual(parsed.commands, ['full']);
    assert.equal(parsed.yes, true);
    assert.equal(parsed.strict, true);
    assert.equal(parsed.house, false);
    assert.equal(parsed.json, 'temp/r.json');
    assert.deepEqual(parsed.errors, []);
    assert.equal(parseArgs(['--json=out.json']).json, 'out.json');
    assert.equal(parseArgs(['control', '--house']).house, true);
  });

  test('a forgotten path, an unknown flag and a switch given a value are refusals', () => {
    assert.equal(parseArgs(['--json']).errors.length, 1);
    assert.equal(parseArgs(['--json', '--yes']).errors.length, 1, '--yes is not a file name');
    assert.match(parseArgs(['--force']).errors[0]!, /unknown flag --force/);
    assert.match(parseArgs(['--yes=no']).errors[0]!, /takes no value/);
  });

  test('full starts with spike, ends with teardown, and runs every destructive command but pairspike', () => {
    assert.equal(FULL[0], 'spike');
    assert.equal(FULL[FULL.length - 1], 'teardown');
    for (const command of FULL) assert.ok([...READ_ONLY, ...DESTRUCTIVE].includes(command), command);
    for (const command of DESTRUCTIVE) {
      assert.equal(FULL.includes(command), command !== 'pairspike', command);
    }
    assert.ok(FULL.indexOf('repair') < FULL.indexOf('repairsave'));
    assert.ok(FULL.indexOf('credential') > FULL.indexOf('pair'));
  });

  test('checkoutVersion is the manifest source, not the generated app.json', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.homeycompose', 'app.json'), 'utf8'));
    assert.equal(checkoutVersion(), manifest.version);
  });
});

describe('the undo stack', () => {
  test('each undo runs at most once, newest first, and one failure stops none of the others', async () => {
    const stack = createUndoStack();
    const ran: string[] = [];
    const a = stack.push('a', async () => { ran.push('a'); });
    stack.push('b', async () => { ran.push('b'); throw new Error('lamp gone'); });
    const c = stack.push('c', async () => { ran.push('c'); });
    c.release();
    assert.equal(stack.size, 2);
    assert.ok(a.pending);

    const outcomes = await stack.runAll();
    assert.deepEqual(ran, ['b', 'a']);
    assert.deepEqual(outcomes.map(o => [o.label, o.ok]), [['b', false], ['a', true]]);
    assert.deepEqual(await a.run(), { ran: false }, 'already run by runAll');
    assert.equal(stack.size, 0);

    const d = stack.push('d', async () => { ran.push('d'); });
    assert.deepEqual(await d.run(), { ran: true, ok: true });
    assert.deepEqual(await d.run(), { ran: false });
  });

  /** A process with just enough of `once`/`exit` to watch the handler. */
  function fakeProcess() {
    const listeners = new Map<string, Array<() => void>>();
    const exits: number[] = [];
    let exited: (code: number) => void = () => {};
    const done = new Promise<number>(resolve => { exited = resolve; });
    return {
      exits, done,
      once(event: string, fn: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeListener(event: string, fn: () => void) {
        listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== fn));
      },
      emit(event: string) {
        const current = listeners.get(event) ?? [];
        listeners.set(event, []);
        for (const fn of current) fn();
      },
      exit(code: number) { exits.push(code); exited(code); },
    };
  }

  test('SIGINT puts everything back, then exits 130; SIGTERM exits 143', async () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const stack = createUndoStack();
      const put: string[] = [];
      stack.push('switch the lamp back off', async () => { put.push('lamp'); });
      stack.push("put the app's key back", async () => { put.push('key'); });
      const proc = fakeProcess();
      let interrupted = false;
      let beforeExit = 0;
      installInterruptHandlers(stack, {
        proc, log: () => {}, onInterrupt: () => { interrupted = true; }, beforeExit: () => { beforeExit += 1; },
      });
      proc.emit(signal);
      assert.equal(await proc.done, code);
      assert.deepEqual(put, ['key', 'lamp'], 'newest first');
      assert.ok(interrupted);
      assert.equal(beforeExit, 1);
    }
  });

  test('a second signal exits at once, and a hung undo is bounded', async () => {
    const stack = createUndoStack();
    stack.push('never answers', () => new Promise(() => {}));
    const proc = fakeProcess();
    installInterruptHandlers(stack, { proc, log: () => {} });
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    assert.equal(await proc.done, 130);

    const bounded = createUndoStack();
    bounded.push('never answers', () => new Promise(() => {}));
    const second = fakeProcess();
    const said: string[] = [];
    installInterruptHandlers(bounded, { proc: second, log: m => said.push(m), timeoutMs: 5 });
    second.emit('SIGINT');
    assert.equal(await second.done, 130);
    assert.ok(said.some(m => /did not finish within/.test(m)));
  });
});

describe('the run record', () => {
  const lines = [
    { line: 'T24', status: 'OK', detail: 'held' },
    { line: 'T25', status: 'SKIPPED', detail: 'no lamp' },
    { line: '-', status: 'INFO', detail: 'note' },
  ];

  test('--strict turns a SKIPPED line into a failing exit code, and only then', () => {
    assert.equal(summarise(lines, { strict: false }).exitCode, 0);
    const strict = summarise(lines, { strict: true });
    assert.equal(strict.exitCode, 1);
    assert.deepEqual(strict.failing.map(r => r.line), ['T25']);
    assert.equal(summarise([...lines, { line: 'T1', status: 'FAILED', detail: 'x' }], { strict: false }).exitCode, 1);
  });

  test('the JSON carries results and build facts, and no address or key', () => {
    const report = jsonReport({
      results: lines, commands: ['full'], startedAt: 0, finishedAt: 1000, strict: false,
      build: { installed: '0.6.5', checkout: '0.6.5', build: 'launch', firmware: '13.5.0' },
    });
    assert.equal(report.app.versionsMatch, true);
    assert.equal(report.app.build, 'launch');
    assert.equal(report.firmware, '13.5.0');
    assert.equal(report.results.length, 3);
    assert.equal(report.summary.skipped, 1);
    const text = JSON.stringify(report);
    assert.doesNotMatch(text, /address|token|appKey|"key"/i);
    const unknown = jsonReport({
      results: [], commands: [], startedAt: 0, finishedAt: 0, strict: true,
      build: { installed: null, checkout: '0.6.5', build: 'unknown', firmware: null },
    });
    assert.equal(unknown.app.versionsMatch, false, 'an unreadable install never matches');
  });

  test('the build shape comes from whether the dev-only evidence route answers', () => {
    assert.equal(buildShapeFrom({ answered: true }), 'dev');
    assert.equal(buildShapeFrom({
      answered: false,
      message: messageOf(new Error('<!DOCTYPE html>Cannot GET /api/app/com.thomassidor.lightkeeper/evidence')),
    }), 'launch');
    assert.equal(buildShapeFrom({ answered: false, message: 'Session Not Found' }), 'unknown');
  });
});

test('the split-out modules never name a key', () => {
  // `verify-hardware-safety.test.ts` holds this for the script itself; these
  // modules are new, and the JSON writer in particular is one step from a file.
  const dir = join(ROOT, 'scripts', 'verify');
  for (const file of readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    const code = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /config\.(key|appKey)|HOMEY_(API|APP)_KEY/, `scripts/verify/${file}`);
  }
});
