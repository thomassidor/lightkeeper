import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeHomey, makeDriver, translate, localised, FakePairSession, type FakeHomey } from '../support/fake-homey';
import { fakeApiClient, lamp, type RawDeviceFixture } from '../support/fake-homey-api';
import { driverApp, stubSource, type DriverAppOptions } from '../support/fake-lightkeeper-app';
import type { SelectableInput } from '../../lib/inputs/selectable-input';
import { LEAVE_ALONE } from '../../lib/outputs/lightkeeper-settings';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';

const ControllerDriver = require('../../drivers/controller/driver');

/**
 * The controller driver's pair and repair sessions, executed.
 *
 * Until `test/support/fake-homey.ts` this file could not exist: the driver
 * `extends Homey.Driver`, and `require('homey')` only resolves on a Homey
 * (platform §13). Every rule it calls into was tested in `lib/`; what was not
 * tested anywhere was the WIRING — that changing the remote wipes the buttons,
 * that a narrowed light selection re-aims them, that the hero card names the
 * same device the press reads, that the Test control runs without a single
 * Flow. Those are what this file is about.
 *
 * The catalogue is the real `DeviceCatalog` over a fake `homey-api` client, and
 * the Test control is the real `ControllerRuntimeManager.ephemeral` — so a lamp
 * that "answers" here answered a real runtime's write.
 */

const REMOTE = 'remote-1';
const OTHER_REMOTE = 'remote-2';

function remote(id: string, name: string): RawDeviceFixture {
  return {
    id, name, zone: 'z-living', class: 'remote', capabilities: { measure_battery: 80 },
    ownerUri: 'homey:app:com.ikea.tradfri', driverId: 'homey:app:com.ikea.tradfri:remote',
  };
}

function input(key: string, controlId: string, label: string, over: Partial<SelectableInput> = {}): SelectableInput {
  return {
    key, controlId, label, action: 'press', carriesMagnitude: false,
    binding: { kind: 'flow_fixed', cardId: `${controlId}_pressed`, cardOwnerUri: `homey:device:${REMOTE}`, fixedArgs: {} },
    ...over,
  };
}

const ON = input('on|press', 'on', 'On — Press');
const OFF = input('off|press', 'off', 'Off — Press');
/** Twenty detents: past the twelve-variant ceiling, so the preflight declines it. */
const DIAL = input('dial|rotate', 'dial', 'Dial — Turn', {
  action: 'rotate_delta', carriesMagnitude: true,
  binding: {
    kind: 'flow_range', cardId: 'dial_turned', cardOwnerUri: `homey:device:${REMOTE}`, fixedArgs: {},
    argument: 'steps', values: Array.from({ length: 20 }, (_, i) => i + 1),
  },
});

const SURFACES: DriverAppOptions['surfaces'] = {
  [REMOTE]: { inputs: [ON, OFF, DIAL], fingerprint: 'fp-1', fingerprintV2: 'fp2-1', rejected: [] },
  [OTHER_REMOTE]: { inputs: [ON, OFF], fingerprint: 'fp-2', rejected: [] },
};

/** One of this app's own devices: never a remote, never a light. */
const OWN_CURVE: RawDeviceFixture = {
  id: 'uuid-curve', name: 'Evening curve', zone: 'z-hall', class: 'light',
  capabilities: { onoff: true }, ownerUri: 'homey:app:com.thomassidor.lightkeeper',
  driverId: 'homey:app:com.thomassidor.lightkeeper:curve', data: { id: 'lk-curv-1' },
};

function rig(options: DriverAppOptions & { devices?: RawDeviceFixture[] } = {}) {
  const client = fakeApiClient(options.devices ?? [
    remote(REMOTE, 'Kitchen STYRBAR'),
    remote(OTHER_REMOTE, 'Spare STYRBAR'),
    lamp('l1', 'Sofa lamp', 'z-living', { onoff: false }),
    lamp('l2', 'Floor lamp', 'z-living', { onoff: false }),
    lamp('l3', 'Hall spot', 'z-hall', { onoff: false }),
    OWN_CURVE,
  ]);
  const built = driverApp(client, { surfaces: SURFACES, ...options });
  const homey: FakeHomey = fakeHomey({ app: built.app });
  const driver = makeDriver(ControllerDriver, homey);
  return { ...built, client, homey, driver };
}

async function paired(options: DriverAppOptions & { devices?: RawDeviceFixture[] } = {}) {
  const r = rig(options);
  const session = new FakePairSession();
  await r.driver.onPair(session);
  return { ...r, session };
}

/** A session that has chosen the remote and two lamps — the start of step 3. */
async function readyForButtons(options: DriverAppOptions = {}) {
  const r = await paired(options);
  await r.session.call('selectSource', REMOTE);
  await r.session.call('selectTargets', { kind: 'devices', deviceIds: ['l1', 'l2'] });
  return r;
}

describe('the two shared screens', () => {
  test('the intro is this driver\'s, resolved through the locale file', async () => {
    const { session } = await paired();
    const intro = await session.call('getIntro');

    assert.equal(intro.title, translate('intro.controllerTitle'));
    assert.equal(intro.hero, 'remote');
    assert.equal(intro.decisions.length, 4);
    assert.equal(intro.decisions[0].what, translate('intro.theRemote'));
    // The key screen comes straight after the intro, and that is argued in the
    // driver: somebody who reaches a four-step review without a key loses it all.
    assert.equal(intro.nextView, 'credential');
  });

  test('the review reads back the remote, the lights and the buttons', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'toggle' });

    const review = await session.call('getReview');
    assert.deepEqual([review.stepIndex, review.stepCount], [4, 4]);
    assert.deepEqual(review.rows.map((row: { view?: string }) => row.view), ['remote', 'lights', 'buttons']);
    assert.equal(review.rows[0].value, 'Kitchen STYRBAR');
    assert.equal(review.rows[1].value, localised('review.someLights', { count: 2 }));
    // One of three gestures has a job — both numbers, so a half-done remote shows.
    assert.equal(review.rows[2].value, '1 / 3');
    assert.equal('control' in review, false, 'a remote has no "how Lightkeeper controls" choice');
  });

  test('the review names a missing remote rather than printing nothing', async () => {
    const { session } = await paired();
    await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    const review = await session.call('getReview');
    assert.equal(review.rows[0].value, translate('review.missingRemote'));
  });
});

describe('the API key', () => {
  test('the status names the remote picker as what comes next', async () => {
    const { session } = await paired({ credentialValid: true });
    const status = await session.call('getCredentialStatus');
    assert.equal(status.valid, true);
    assert.equal(status.nextView, 'remote');
  });

  test('a pasted key goes to the credential service, validated by a write probe', async () => {
    const { session, record } = await paired();
    const status = await session.call('setCredential', 'good-key');
    assert.deepEqual(record.credentials, ['good-key']);
    assert.equal(status.valid, true);
  });
});

describe('choosing the remote', () => {
  test('Lightkeeper\'s own devices are never offered as a remote', async () => {
    const { session } = await paired();
    const list = await session.call('listSources');
    const ids = [...list.rooms, ...list.others].flatMap((room: { sources: Array<{ id: string }> }) =>
      room.sources.map(source => source.id));

    assert.ok(ids.includes(REMOTE));
    assert.ok(!ids.includes('uuid-curve'), 'a curve is not a remote');
    assert.equal(list.current, null);
  });

  test('a remote that has gone says so, in words from the locale file', async () => {
    const { session } = await paired();
    await assert.rejects(session.call('selectSource', 'gone'), { message: translate('errors.deviceGone') });
  });

  test('a chosen remote reports its gestures grouped by control', async () => {
    const { session } = await paired();
    const chosen = await session.call('selectSource', REMOTE);

    assert.equal(chosen.deviceName, 'Kitchen STYRBAR');
    assert.equal(chosen.eventCount, 3);
    assert.equal(chosen.usable, true);
    assert.deepEqual(chosen.controls.map((control: { controlId: string }) => control.controlId), ['on', 'off', 'dial']);
  });

  test('changing the remote WIPES the buttons, and re-choosing the same one does not', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'toggle' });

    await session.call('selectSource', REMOTE);
    assert.equal((await session.call('getButtons')).jobs[ON.key].label, translate('functions.toggle'),
      'the same remote again keeps its buttons');

    await session.call('selectSource', OTHER_REMOTE);
    assert.deepEqual((await session.call('getButtons')).jobs, {},
      'a different remote\'s events are not this one\'s, so no binding survives');
  });
});

describe('choosing the lights', () => {
  test('narrowing the lights re-aims a button that named one that went', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'toggle', lights: ['l2'] });

    await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await session.call('editGesture', ON.key);
    const gesture = await session.call('getGesture');
    // The job was the decision and the lamp a refinement of it, so the
    // refinement is what goes: "all of them", never a rule aimed at nothing.
    assert.equal(gesture.chosen, 'toggle');
    assert.equal(gesture.chosenLights, null);
  });

  test('a button aimed at a lamp that stays keeps its subset', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'toggle', lights: ['l2'] });

    await session.call('selectTargets', { kind: 'devices', deviceIds: ['l2', 'l3'] });
    const gesture = await session.call('getGesture');
    assert.deepEqual(gesture.chosenLights, ['l2']);
  });
});

describe('the buttons screen', () => {
  test('refuses before any lights are chosen, in a translated sentence', async () => {
    const { session } = await paired();
    await assert.rejects(session.call('getButtons'), { message: translate('errors.chooseLightsFirst') });
    await assert.rejects(session.call('getMapping'), { message: translate('errors.chooseLightsFirst') });
    await assert.rejects(session.call('setRules', []), { message: translate('errors.chooseLightsFirst') });
    await assert.rejects(session.call('test', { func: 'on', deviceIds: null }),
      { message: translate('errors.chooseLightsFirst') });
  });

  test('one row per gesture, and a job reads with the lights it drives', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', OFF.key);
    await session.call('setGesture', { job: 'off', lights: ['l1'] });

    const buttons = await session.call('getButtons');
    assert.deepEqual(buttons.gestures.map((g: { label: string }) => g.label), ['On · Press', 'Off · Press', 'Dial · Turn']);
    assert.equal(buttons.jobs[OFF.key].detail,
      translate('buttons.detail', { job: translate('functions.off'), lights: 'Sofa lamp' }));
  });

  test('a job aimed at every light says "all 2", not the names', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'on' });
    const buttons = await session.call('getButtons');
    assert.equal(buttons.jobs[ON.key].detail, translate('buttons.detail', {
      job: translate('functions.on'), lights: localised('targets.allCount', { count: 2 }),
    }));
  });

  test('an event the remote does not expose cannot be edited', async () => {
    const { session } = await readyForButtons();
    await assert.rejects(session.call('editGesture', 'made-up|press'),
      { message: translate('errors.notThisRemotesButton') });
    await assert.rejects(session.call('editGesture', 42), { message: translate('errors.notThisRemotesButton') });
  });

  test('the job editor refuses to open on nothing', async () => {
    const { session } = await readyForButtons();
    await assert.rejects(session.call('getGesture'), { message: translate('errors.noButtonEditing') });
    await assert.rejects(session.call('setGesture', { job: 'on' }), { message: translate('errors.noButtonEditing') });
    await assert.rejects(session.call('editSource', 'colour'), { message: translate('errors.noButtonEditing') });
  });
});

describe('one gesture\'s job', () => {
  test('set, changed and cleared — and only that gesture\'s', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', OFF.key);
    await session.call('setGesture', { job: 'off' });
    await session.call('editGesture', ON.key);
    assert.deepEqual(await session.call('setGesture', { job: 'on' }), { set: true });
    await session.call('setGesture', { job: 'toggle' });

    let jobs = (await session.call('getButtons')).jobs;
    assert.equal(jobs[ON.key].label, translate('functions.toggle'), 'replaced, not duplicated');
    assert.equal(jobs[OFF.key].label, translate('functions.off'), 'the other row untouched');

    assert.deepEqual(await session.call('setGesture', { job: null }), { cleared: true });
    jobs = (await session.call('getButtons')).jobs;
    assert.equal(ON.key in jobs, false);
    assert.equal(OFF.key in jobs, true);
  });

  test('a value job keeps its preset, and a job the lamps cannot do is refused with the reason', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'brightness_set', preset: { brightness: 0.4 } });
    const gesture = await session.call('getGesture');
    assert.equal(gesture.chosen, 'brightness_set');
    assert.deepEqual(gesture.preset, { brightness: 0.4 });
    assert.equal(gesture.presetKind, 'brightness');

    await assert.rejects(session.call('setGesture', { job: 'fly_to_the_moon' }), /The chosen lights cannot do that/);
    await assert.rejects(session.call('setGesture', { job: 'toggle', lights: ['l3'] }), /names a light this remote does not control/);
  });

  test('"On – with Lightkeeper" is offered only when there is something to take from', async () => {
    const without = await readyForButtons();
    await without.session.call('editGesture', ON.key);
    const none = await without.session.call('getGesture');
    assert.equal(none.jobs.some((job: { id: string }) => job.id === 'lightkeeper_on'), false);

    const withCurve = await readyForButtons({ curves: [stubSource('lk-curv-1', 'Evening curve')] });
    await withCurve.session.call('editGesture', ON.key);
    const some = await withCurve.session.call('getGesture');
    assert.equal(some.jobs.some((job: { id: string }) => job.id === 'lightkeeper_on'), true);
    assert.equal(some.allLabel, localised('job.allLights', { count: 2 }));
    assert.deepEqual(some.lights, [{ id: 'l1', name: 'Sofa lamp' }, { id: 'l2', name: 'Floor lamp' }]);
  });
});

describe('the two source pickers', () => {
  const sources: DriverAppOptions = {
    curves: [stubSource('lk-curv-1', 'Evening curve', { lights: ['l1'] })],
    daylights: [stubSource('lk-dayl-1', 'Room sensing', { values: { [VALUE_CAPABILITIES.brightness]: 0.3 } })],
    schedules: [stubSource('lk-sched-1', 'Night schedule')],
  };

  test('a kind the button does not take is refused before any screen opens', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);
    await assert.rejects(session.call('editSource', 'volume'), { message: translate('errors.notASourceKind') });
    await assert.rejects(session.call('getSource'), { message: translate('errors.noSourceChoosing') });
    await assert.rejects(session.call('setSource', { id: 'lk-curv-1' }), { message: translate('errors.noSourceChoosing') });
  });

  test('colour offers curves only; brightness offers all three kinds', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);

    await session.call('editSource', 'colour');
    const colour = await session.call('getSource');
    assert.equal(colour.title, translate('job.takeColourTitle'));
    assert.equal(colour.chosen, LEAVE_ALONE);
    const colourIds = colour.sources.map((row: { id: string }) => row.id);
    assert.ok(colourIds.includes('lk-curv-1'));
    assert.ok(!colourIds.includes('lk-dayl-1'), 'a Room-sensing Light has no colour to give');

    await session.call('editSource', 'brightness');
    const brightness = await session.call('getSource');
    const brightnessIds = brightness.sources.map((row: { id: string }) => row.id);
    for (const id of ['lk-curv-1', 'lk-dayl-1', 'lk-sched-1']) assert.ok(brightnessIds.includes(id), id);
  });

  test('choosing a source makes the job, and the hero card names it by the SAME lookup the press uses', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);
    await session.call('editSource', 'brightness');
    assert.deepEqual(await session.call('setSource', { id: 'lk-dayl-1' }), { chosen: 'lk-dayl-1' });

    const gesture = await session.call('getGesture');
    assert.equal(gesture.chosen, 'lightkeeper_on');
    assert.deepEqual(gesture.preset, { colourSource: LEAVE_ALONE, brightnessSource: 'lk-dayl-1', pressAgainOff: true });
    assert.deepEqual(gesture.sourceNames, { colour: translate('flow.leaveAlone'), brightness: 'Room sensing' });

    await session.call('editSource', 'colour');
    await session.call('setSource', { id: 'lk-curv-1' });
    const both = await session.call('getGesture');
    assert.deepEqual(both.sourceNames, { colour: 'Evening curve', brightness: 'Room sensing' });
    // The curve drives l1, which this button drives too: the tile says so.
    assert.deepEqual(both.sourceWarnings.colour, { name: 'Evening curve', sharedLights: 1 });
    assert.equal(both.sourceWarnings.brightness?.sharedLights, 0);
    assert.equal((await session.call('getSource')).chosen, 'lk-curv-1');
  });

  test('a source no live runtime answers to reads as "leave it alone", not as an id', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);
    await session.call('editSource', 'brightness');
    await session.call('setSource', { id: 'lk-sched-1' });
    await session.call('editSource', 'colour');
    await session.call('setSource', { id: 'lk-curv-gone' });
    const gesture = await session.call('getGesture');
    assert.deepEqual(gesture.sourceNames, { colour: translate('flow.leaveAlone'), brightness: 'Night schedule' });
  });

  test('clearing the last source is refused in a sentence, not the validator\'s', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);
    await session.call('editSource', 'colour');
    await assert.rejects(session.call('setSource', { id: LEAVE_ALONE }), { message: translate('job.needASource') });
    await assert.rejects(session.call('setSource', {}), { message: translate('job.needASource') });
  });

  test('a source keeps the button\'s own lights subset', async () => {
    const { session } = await readyForButtons(sources);
    await session.call('editGesture', ON.key);
    await session.call('setGesture', { job: 'toggle', lights: ['l2'] });
    await session.call('editSource', 'colour');
    await session.call('setSource', { id: 'lk-curv-1' });
    assert.deepEqual((await session.call('getGesture')).chosenLights, ['l2']);
  });
});

describe('the mapping grid and setRules', () => {
  test('getMapping offers what the lamps can do and the remote\'s controls', async () => {
    const { session } = await readyForButtons();
    const mapping = await session.call('getMapping');
    const functions = mapping.functions.map((row: { function: string }) => row.function);
    assert.ok(functions.includes('toggle'));
    assert.deepEqual(mapping.controls.map((control: { controlId: string }) => control.controlId), ['on', 'off', 'dial']);
    assert.equal(mapping.controls[0].inputs[0].controlLabel, 'On');
    assert.equal(mapping.controls[0].inputs[0].actionLabel, 'Press');
  });

  test('drops rows it cannot honour, keeps one rule per gesture, and keeps the PRESET', async () => {
    const { session } = await readyForButtons();
    const result = await session.call('setRules', [
      { id: 'a', function: 'brightness_set', inputKey: ON.key, lights: null, preset: { brightness: 0.3 } },
      { id: 'b', function: 'toggle', inputKey: ON.key, lights: null },
      { id: 'c', function: 'toggle', inputKey: 'not-on-this-remote', lights: null },
      { id: 'd', function: 'off', inputKey: OFF.key, lights: ['l3'] },
    ]);

    assert.equal(result.count, 1, 'the duplicate, the stranger event and the stranger lamp all dropped');
    await session.call('editGesture', ON.key);
    const gesture = await session.call('getGesture');
    assert.equal(gesture.chosen, 'brightness_set');
    assert.deepEqual(gesture.preset, { brightness: 0.3 },
      'setRules used to rebuild the rule by hand and drop this — the one shape the profile validator quarantines');
  });
});

describe('the Test control works before save, and without Flows', () => {
  test('a real ephemeral runtime reaches the real lamps, and no Flow is touched', async () => {
    const { session, client } = await readyForButtons();
    const outcome = await session.call('test', { func: 'on', deviceIds: null });

    assert.ok(outcome.writes > 0, `expected writes, got ${JSON.stringify(outcome)}`);
    const switched = client.writes.filter(write => write.capabilityId === 'onoff' && write.value === true)
      .map(write => write.deviceId).sort();
    assert.deepEqual(switched, ['l1', 'l2'], 'both chosen lamps, and not the hall spot nobody chose');
    // The rig's bridge throws on every call and its api refuses every Flow
    // write, so reaching this line at all is the "without Flows" half.
  });

  test('a subset is honoured, and an empty list means all of them', async () => {
    const { session, client } = await readyForButtons();
    await session.call('test', { func: 'on', deviceIds: ['l2'] });
    assert.deepEqual(client.writes.map(write => write.deviceId), ['l2']);

    client.writes.length = 0;
    await session.call('test', { func: 'off', deviceIds: [] });
    assert.deepEqual(client.writes.map(write => write.deviceId).sort(), ['l1', 'l2']);
  });
});

describe('save', () => {
  async function withAJob() {
    const r = await readyForButtons();
    await r.session.call('editGesture', ON.key);
    await r.session.call('setGesture', { job: 'toggle' });
    return r;
  }

  test('pairing returns a device for Homey to create, with an id the bridge will recognise', async () => {
    const { session } = await withAJob();
    const saved = await session.call('save', 'Kitchen remote');

    assert.equal(saved.created, true);
    assert.equal(saved.device.name, 'Kitchen remote');
    assert.match(saved.device.data.id, /^lk-ctrl-/);
    const profile = saved.device.store.profile;
    assert.equal(profile.source.deviceId, REMOTE);
    assert.equal(profile.source.ownerAppId, 'homey:app:com.ikea.tradfri');
    assert.equal(profile.source.eventSurfaceFingerprint, 'fp-1');
    assert.equal(profile.source.eventSurfaceFingerprintV2, 'fp2-1');
    assert.deepEqual(profile.target, { kind: 'devices', deviceIds: ['l1', 'l2'] });
    assert.deepEqual(profile.managedFlows, []);
    assert.deepEqual(profile.mappings.map((rule: { function: string }) => rule.function), ['toggle']);
  });

  /**
   * The behavioural twin of `pairing-sessions.test.ts`'s `/name \|\|/` regex:
   * that one proved the source no longer says `name || …`; this proves what a
   * name of spaces actually becomes.
   */
  test('a name of spaces is no name, and the derived one is used', async () => {
    const { session } = await withAJob();
    for (const name of ['   ', '', undefined]) {
      const saved = await session.call('save', name);
      assert.equal(saved.device.name, 'Kitchen STYRBAR → Living room', JSON.stringify(name));
    }
  });

  test('a mapping that cannot be compiled is refused ON the screen, naming the control', async () => {
    const { session } = await readyForButtons();
    await session.call('editGesture', DIAL.key);
    await session.call('setGesture', { job: 'brightness_up' });

    await assert.rejects(session.call('save', 'x'), (error: Error) => {
      assert.match(error.message, /Dial · Turn/);
      assert.ok(error.message.startsWith(translate('mapping.unsupportedControl', { controls: '' }).slice(0, 12)));
      return true;
    });
  });

  test('refuses without a remote, in the locale file\'s words', async () => {
    const { session } = await paired();
    await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await assert.rejects(session.call('save', 'x'), { message: translate('errors.chooseRemoteAndLights') });
  });
});

describe('repair', () => {
  function storedProfile() {
    return {
      schemaVersion: 1, enabled: true,
      source: {
        deviceId: REMOTE, name: 'Kitchen STYRBAR', driverId: 'homey:app:com.ikea.tradfri:remote',
        ownerAppId: 'homey:app:com.ikea.tradfri', eventSurfaceFingerprint: 'fp-1',
      },
      target: { kind: 'devices', deviceIds: ['l1'] },
      mappings: [{ id: 'r1', function: 'toggle', inputKey: ON.key, target: null }],
      behavior: { ...DEFAULT_BEHAVIOR },
      managedFlows: [{ flowId: 'f1', bindingKey: ON.key, variantKey: 'fixed', fingerprint: 'fp-1', managedVersion: 1, createdAt: 1 }],
      catalogue: [ON, OFF],
    };
  }

  function repairDevice(profile = storedProfile()) {
    const applied: unknown[] = [];
    return {
      applied,
      device: {
        getStoreValue: (key: string) => (key === 'profile' ? profile : undefined),
        getData: () => ({ id: 'lk-ctrl-1' }),
        applyPlan: async (plan: unknown) => { applied.push(plan); },
      },
    };
  }

  test('opens on the stored remote, lights and buttons', async () => {
    const r = rig();
    const session = new FakePairSession();
    const { device } = repairDevice();
    await r.driver.onRepair(session, device);

    assert.equal((await session.call('listSources')).current, REMOTE);
    assert.equal((await session.call('getButtons')).jobs[ON.key].label, translate('functions.toggle'));
    assert.equal((await session.call('getReview')).rows[0].value, 'Kitchen STYRBAR');
  });

  test('save APPLIES to the device being repaired and creates nothing', async () => {
    const r = rig();
    const session = new FakePairSession();
    const { device, applied } = repairDevice();
    await r.driver.onRepair(session, device);

    assert.deepEqual(await session.call('save', 'ignored'), { updated: true });
    assert.equal(applied.length, 1);
    assert.equal((applied[0] as { source: { deviceId: string } }).source.deviceId, REMOTE);
  });

  test('re-attach is offered only when repairing, and only when there is a candidate', async () => {
    const pairing = await paired({ reattach: { deviceId: OTHER_REMOTE, deviceName: 'Spare STYRBAR' } });
    assert.equal(await pairing.session.call('checkReattach'), null);
    await assert.rejects(pairing.session.call('applyReattach'), { message: translate('errors.reattachOnlyInRepair') });

    const none = rig();
    const noneSession = new FakePairSession();
    await none.driver.onRepair(noneSession, repairDevice().device);
    assert.equal(await noneSession.call('checkReattach'), null);
    await assert.rejects(noneSession.call('applyReattach'), { message: translate('errors.remoteGone') });
  });

  test('a one-tap re-attach adopts the new remote\'s surface and keeps every mapping', async () => {
    const r = rig({ reattach: { deviceId: OTHER_REMOTE, deviceName: 'Spare STYRBAR' } });
    const session = new FakePairSession();
    const { device, applied } = repairDevice();
    await r.driver.onRepair(session, device);

    const offer = await session.call('checkReattach');
    assert.deepEqual(offer, { deviceId: OTHER_REMOTE, deviceName: 'Spare STYRBAR', currentName: 'Kitchen STYRBAR' });

    const result = await session.call('applyReattach');
    assert.deepEqual(result, { mappings: 1, deviceName: 'Spare STYRBAR' });
    const plan = applied[0] as { source: { deviceId: string; eventSurfaceFingerprint: string }; managedFlows: unknown[] };
    assert.equal(plan.source.deviceId, OTHER_REMOTE);
    assert.equal(plan.source.eventSurfaceFingerprint, 'fp-2', 'the NEW device\'s hash, or the next health check fails');
    assert.deepEqual(plan.managedFlows, [], 'the old remote\'s Flows are not carried to the new one');
  });

  test('a candidate that vanished between the check and the tap is refused', async () => {
    const r = rig({ reattach: { deviceId: 'vanished', deviceName: 'Ghost' } });
    const session = new FakePairSession();
    await r.driver.onRepair(session, repairDevice().device);
    await assert.rejects(session.call('applyReattach'), { message: translate('errors.remoteGone') });
  });
});

describe('the handler wrapper', () => {
  test('a failing handler is logged with its name AND re-thrown', async () => {
    const { session, driver } = await paired();
    await assert.rejects(session.call('getButtons'));
    assert.ok(driver.errors.some((line: string) => line.startsWith('pair/getButtons failed:')), driver.errors.join('\n'));
    await session.call('getIntro');
    assert.ok(driver.logs.includes('pair/getIntro ok'));
  });

  test('onInit says so', async () => {
    const { driver } = rig();
    await driver.onInit();
    assert.deepEqual(driver.logs, ['Controller driver initialised']);
  });

  test('add_device is answered', async () => {
    const { session } = await paired();
    assert.equal(await session.call('add_device'), true);
  });
});
