import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HomeyApiService } from '../../lib/homey-api-service';
import type { CredentialService } from '../../lib/credential-service';

/**
 * The read client is the single choke point for every device read, zone read
 * and capability subscription in the app. These tests cover its caching and,
 * more importantly, its RECOVERY: the in-flight promise must be cleared on
 * failure as well as success, or one transient failure at boot leaves a
 * rejected promise cached forever and no read works again without a restart.
 */

/** A stand-in for HomeyAPI's client, with the four managers the service connects. */
function fakeApi() {
  const connected: string[] = [];
  const manager = (name: string) => ({
    connect: async () => { connected.push(name); },
  });
  return {
    connected,
    devices: manager('devices'),
    zones: manager('zones'),
    flow: manager('flow'),
    flowtoken: manager('flowtoken'),
  };
}

/**
 * Subclass to override the one call into `homey-api` — the module is a
 * CommonJS require with no injection point.
 */
class TestApiService extends HomeyApiService {
  attempts = 0;
  constructor(private readonly behaviour: () => Promise<any>) {
    super({ app: { error: () => { /* silence */ } } }, {} as CredentialService);
  }

  protected override async createAppApi(): Promise<any> {
    this.attempts += 1;
    return this.behaviour();
  }
}

describe('read client caching', () => {
  test('connects once and reuses the client', async () => {
    const api = fakeApi();
    const service = new TestApiService(async () => api);

    const first = await service.read();
    const second = await service.read();

    assert.equal(first, api);
    assert.equal(second, api);
    assert.equal(service.attempts, 1, 'a cached client must not reconnect');
  });

  test('connects each manager individually', async () => {
    const api = fakeApi();
    const service = new TestApiService(async () => api);

    await service.read();

    assert.deepEqual(api.connected, ['devices', 'zones', 'flow', 'flowtoken']);
  });

  test('concurrent callers share one connection attempt', async () => {
    const api = fakeApi();
    const service = new TestApiService(async () => api);

    const [a, b] = await Promise.all([service.read(), service.read()]);

    assert.equal(a, api);
    assert.equal(b, api);
    assert.equal(service.attempts, 1);
  });

  test('a manager that will not connect is degraded, not fatal', async () => {
    const api = fakeApi();
    api.flow.connect = async () => { throw new Error('flow manager unavailable'); };
    const service = new TestApiService(async () => api);

    const client = await service.read();

    assert.equal(client, api, 'the client is still usable for everything else');
  });
});

describe('read client recovery', () => {
  test('a failed connect does not poison every later read', async () => {
    const api = fakeApi();
    let shouldFail = true;
    const service = new TestApiService(async () => {
      if (shouldFail) throw new Error('Homey is still starting up');
      return api;
    });

    await assert.rejects(service.read(), /still starting up/);

    // The whole point: the next call must try again rather than replay the
    // cached rejection.
    shouldFail = false;
    const client = await service.read();

    assert.equal(client, api);
    assert.equal(service.attempts, 2, 'the second read must make a fresh attempt');
  });

  test('recovers after repeated failures', async () => {
    const api = fakeApi();
    let failuresLeft = 3;
    const service = new TestApiService(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('unreachable');
      }
      return api;
    });

    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(service.read(), /unreachable/);
    }

    assert.equal(await service.read(), api);
    assert.equal(service.attempts, 4);
  });

  test('concurrent callers all see the failure, then one retry succeeds', async () => {
    const api = fakeApi();
    let shouldFail = true;
    const service = new TestApiService(async () => {
      if (shouldFail) throw new Error('boom');
      return api;
    });

    const results = await Promise.allSettled([service.read(), service.read()]);
    assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
    assert.equal(service.attempts, 1, 'the failure is shared, not duplicated');

    shouldFail = false;
    assert.equal(await service.read(), api);
    assert.equal(service.attempts, 2);
  });
});

describe('subscription teardown', () => {
  test('track returns an unsubscribe that also deregisters itself', async () => {
    const service = new TestApiService(async () => fakeApi());
    let destroyed = 0;

    const off = service.track(() => { destroyed += 1; });
    await off();
    assert.equal(destroyed, 1);

    // destroy() must not call it a second time — that is what makes it safe for
    // LightTargetAdapter to tear down its own subscriptions early.
    await service.destroy();
    assert.equal(destroyed, 1);
  });

  test('destroy runs every outstanding teardown', async () => {
    const service = new TestApiService(async () => fakeApi());
    const destroyed: string[] = [];

    service.track(() => { destroyed.push('a'); });
    service.track(() => { destroyed.push('b'); });
    await service.destroy();

    assert.deepEqual(destroyed.sort(), ['a', 'b']);
  });

  test('one failing teardown does not block the rest', async () => {
    const service = new TestApiService(async () => fakeApi());
    const destroyed: string[] = [];

    service.track(() => { throw new Error('already gone'); });
    service.track(() => { destroyed.push('b'); });
    await service.destroy();

    assert.deepEqual(destroyed, ['b']);
  });
});
