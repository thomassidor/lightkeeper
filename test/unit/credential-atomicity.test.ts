import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CredentialService } from '../../lib/credential-service';
import { HomeyApiService } from '../../lib/homey-api-service';
import { isTransportFailure } from '../../lib/support/homey-errors';
import { deferred } from '../support/deferred';

/**
 * A key holds a single live session (platform §2), so the interesting cases are
 * all about two answers about two different keys arriving in the wrong order.
 *
 * The failures these prevent are the ones that read as "the key randomly stopped
 * working": a typo marking the working key broken, and a revalidation that
 * started before the new key was pasted publishing its verdict after.
 */

/** NOT REAL KEYS. Shaped only to satisfy KEY_SHAPE. */
const GOOD_KEY = '2d36cd94-0d54-4e5b-abb6-51b70b58ae07:4b0dd18f-0cb6-446c-9e56-a7fced78d31e:'
  + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_KEY = '11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-aaaaaaaaaaaa:'
  + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function harness(options: {
  createWriteClient?: (address: string, token: string) => Promise<unknown>;
} = {}) {
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const published: Array<{ present: boolean; valid: boolean; failure?: string }> = [];
  const service = new CredentialService({
    settings: {
      get: k => store.get(k),
      set: (k, v) => { store.set(k, v); },
      unset: k => { store.delete(k); },
    },
    createWriteClient: options.createWriteClient ?? (async (_a, token) => ({ token })),
    getLocalAddress: async () => 'http://127.0.0.1:80',
    log: (...args) => logs.push(args.join(' ')),
    onStatusChange: status => published.push({ ...status }),
  });
  return { service, store, logs, published };
}

const ok = async () => { /* the write probe succeeded */ };
const rejectAs = (message: string) => async () => { throw new Error(message); };

describe('a rejected candidate never disturbs the working key', () => {
  test('a malformed paste leaves the active status valid', async () => {
    const { service, store, published } = harness();
    await service.setCredential(GOOD_KEY, ok);
    assert.equal(service.getStatus().valid, true);
    const publishedSoFar = published.length;

    const verdict = await service.setCredential('PASTE_YOUR_KEY_HERE', ok);

    assert.equal(verdict.valid, false);
    assert.equal(verdict.failure, 'malformed');
    assert.equal(verdict.present, true, 'a key IS stored — the candidate is not it');
    assert.equal(service.getStatus().valid, true, 'the incumbent is untouched');
    assert.equal(store.get('flowWriteApiKey'), GOOD_KEY);
    assert.equal(published.length, publishedSoFar, 'nothing was published');
  });

  test('a rejected new key leaves the old client able to write', async () => {
    const { service } = harness();
    await service.setCredential(GOOD_KEY, ok);
    const client = await service.getWriteClient();

    const verdict = await service.setCredential(OTHER_KEY, rejectAs('403 Missing Scopes'));

    assert.equal(verdict.failure, 'insufficient_scope');
    assert.equal(service.getStatus().valid, true);
    assert.equal(await service.getWriteClient(), client, 'the cached client survives');
  });

  test('with no key stored, a rejected candidate reports present:false', async () => {
    const { service } = harness();
    const verdict = await service.setCredential('nope', ok);
    assert.equal(verdict.present, false);
    assert.equal(verdict.valid, false);
  });
});

describe('generation guard', () => {
  test('a revalidation of the old key publishes nothing after a new one is set', async () => {
    const { service, published } = harness();
    await service.setCredential(GOOD_KEY, ok);

    // Hold the old key's revalidation open, replace the key, then let the
    // revalidation fail as it would against a session that is gone.
    const gate = deferred();
    const revalidating = service.revalidate(async () => {
      await gate.promise;
      throw new Error('401 Session Not Found');
    });

    await service.setCredential(OTHER_KEY, ok);
    const publishedSoFar = published.length;
    gate.resolve();
    const result = await revalidating;

    assert.equal(result.valid, true, 'the answer is about the current key, not the old one');
    assert.equal(service.getStatus().valid, true);
    assert.equal(published.length, publishedSoFar, 'the stale verdict published nothing');
  });

  test('a revalidation that SUCCEEDS late also publishes nothing', async () => {
    const { service, published } = harness();
    await service.setCredential(GOOD_KEY, ok);

    const gate = deferred();
    const revalidating = service.revalidate(async () => { await gate.promise; });

    service.clearCredential();
    const publishedSoFar = published.length;
    gate.resolve();
    await revalidating;

    assert.equal(service.getStatus().present, false, 'clear-during-revalidate stands');
    assert.equal(published.length, publishedSoFar);
  });

  test('a revalidation with no interference still publishes its verdict', async () => {
    const { service } = harness();
    await service.setCredential(GOOD_KEY, ok);
    const result = await service.revalidate(rejectAs('401 Session Not Found'));
    assert.equal(result.valid, false);
    assert.equal(result.failure, 'session_expired');
    assert.equal(service.getStatus().valid, false);
  });
});

describe('acquisition is inside the redaction boundary', () => {
  class WriteFailingService extends HomeyApiService {
    constructor(credentials: CredentialService) {
      super({ app: { error: () => { /* silence */ } } }, credentials);
    }
  }

  test('a handshake error quoting the key is redacted and classified', async () => {
    // The handshake is the one place the token is actually handed to homey-api,
    // so it is the likeliest error to quote it back.
    const { service: credentials, store } = harness({
      createWriteClient: async (_address, token) => {
        throw new Error(`connect failed for token ${token}`);
      },
    });
    // A key already on disk from a previous run, so getWriteClient reaches the
    // handshake rather than refusing for want of a key.
    store.set('flowWriteApiKey', GOOD_KEY);

    const api = new WriteFailingService(credentials);

    await assert.rejects(
      api.withWriteClient(async () => 'never reached'),
      (error: any) => {
        assert.ok(!error.message.includes(GOOD_KEY), 'the key must not survive');
        assert.match(error.message, /<redacted>/);
        assert.equal(typeof error.credentialFailure, 'string');
        return true;
      },
    );
  });

  test('a missing key is still an actionable failure, not a crash', async () => {
    const { service: credentials } = harness();
    const api = new WriteFailingService(credentials);
    await assert.rejects(api.withWriteClient(async () => 1), /API key/i);
  });
});

describe('transport failures invalidate the read client; application errors do not', () => {
  class CountingService extends HomeyApiService {
    attempts = 0;
    constructor() {
      super({ app: { error: () => { /* silence */ }, log: () => { /* silence */ } } }, {} as CredentialService);
    }

    protected override async createAppApi(): Promise<any> {
      this.attempts += 1;
      return { devices: {}, zones: {}, flow: {}, flowtoken: {} };
    }
  }

  test('a socket hang up drops the cached client', async () => {
    const service = new CountingService();
    await service.read();
    assert.equal(service.attempts, 1);

    assert.equal(service.reportReadFailure(new Error('socket hang up')), true);
    await service.read();
    assert.equal(service.attempts, 2, 'the next read rebuilds');
  });

  test('a 404 keeps it', async () => {
    const service = new CountingService();
    await service.read();

    assert.equal(service.reportReadFailure({ statusCode: 404, message: '404 Not Found: Device' }), false);
    await service.read();
    assert.equal(service.attempts, 1, 'an application error is not a dead socket');
  });

  test('a 401 keeps it too — the Homey answered', async () => {
    const service = new CountingService();
    await service.read();
    assert.equal(service.reportReadFailure({ statusCode: 401, message: 'Unauthorized' }), false);
    assert.equal(service.attempts, 1);
  });

  test('reporting on a cold cache is a no-op', async () => {
    const service = new CountingService();
    assert.equal(service.reportReadFailure(new Error('ECONNRESET')), false);
  });

  test('the classifier itself', () => {
    for (const transport of [
      new Error('socket hang up'),
      { code: 'ECONNRESET', message: 'read ECONNRESET' },
      { code: 'ECONNREFUSED' },
      new Error('connection closed'),
      new Error('Request timed out'),
      new Error('not connected'),
    ]) {
      assert.equal(isTransportFailure(transport), true, JSON.stringify(transport));
    }

    for (const application of [
      { statusCode: 404, message: 'connection closed' },
      { statusCode: 403, message: 'Missing Scopes' },
      { code: 'ENOENT', message: 'no such file' },
      new Error('Flow is broken'),
      null,
      undefined,
    ]) {
      assert.equal(isTransportFailure(application), false, JSON.stringify(application));
    }
  });
});

describe('the device catalogue fetches once for a burst of questions', () => {
  test('two concurrent reads on a cold cache perform one fetch', async () => {
    const { DeviceCatalog } = await import('../../lib/device-catalog');
    let fetches = 0;
    const api: any = {
      read: async () => ({
        devices: {
          getDevices: async () => {
            fetches += 1;
            return { d1: { id: 'd1', name: 'Lamp', class: 'light', zone: 'z1', capabilities: ['onoff'] } };
          },
        },
        zones: { getZones: async () => ({ z1: { id: 'z1', name: 'Hall' } }) },
        apps: { getApps: async () => ({}) },
      }),
      reportReadFailure: () => false,
    };
    const catalog = new DeviceCatalog(api);

    const [devices, zones] = await Promise.all([catalog.allDevices(), catalog.allZones()]);

    assert.equal(fetches, 1, 'the second caller shares the first fetch');
    assert.equal(devices.length, 1);
    assert.equal(zones.length, 1);
  });

  test('a failed refresh is not cached, and reports the transport failure', async () => {
    const { DeviceCatalog } = await import('../../lib/device-catalog');
    let attempts = 0;
    const reported: unknown[] = [];
    const api: any = {
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket hang up');
        return {
          devices: { getDevices: async () => ({}) },
          zones: { getZones: async () => ({}) },
          apps: { getApps: async () => ({}) },
        };
      },
      reportReadFailure: (error: unknown) => { reported.push(error); return true; },
    };
    const catalog = new DeviceCatalog(api);

    await assert.rejects(catalog.allDevices(), /socket hang up/);
    assert.equal(reported.length, 1, 'the dead client was reported');

    assert.deepEqual(await catalog.allDevices(), [], 'the retry is not poisoned by the first failure');
    assert.equal(attempts, 2);
  });
});
