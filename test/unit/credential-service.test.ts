import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CredentialService,
  classifyCredentialError,
  looksLikeApiKey,
} from '../../lib/credential-service';

/**
 * NOT A REAL KEY. Synthetic, and shaped only to satisfy KEY_SHAPE — note the
 * all-`a` secret segment. A Homey API key is `<userId>:<sessionId>:<secret>`,
 * and the shape check is the first thing that rejects a truncated paste.
 */
const VALID_KEY = '2d36cd94-0d54-4e5b-abb6-51b70b58ae07:4b0dd18f-0cb6-446c-9e56-a7fced78d31e:'
  + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function harness() {
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const service = new CredentialService({
    settings: {
      get: k => store.get(k),
      set: (k, v) => { store.set(k, v); },
      unset: k => { store.delete(k); },
    },
    createWriteClient: async (_address, token) => ({ token }),
    getLocalAddress: async () => 'http://127.0.0.1:80',
    log: (...args) => logs.push(args.join(' ')),
  });
  return { service, store, logs };
}

describe('API key shape', () => {
  test('accepts the real <userId>:<sessionId>:<secret> form', () => {
    assert.equal(looksLikeApiKey(VALID_KEY), true);
  });

  test('rejects placeholder text and truncated pastes', () => {
    assert.equal(looksLikeApiKey('PASTE_YOUR_KEY_HERE'), false);
    assert.equal(looksLikeApiKey('abc123'), false);
    assert.equal(looksLikeApiKey(''), false);
  });
});

describe('failure classification — three lookalikes, three fixes', () => {
  test('missing session id means a bad paste', () => {
    assert.equal(
      classifyCredentialError({ message: 'Missing Session ID in Token', statusCode: 401 }),
      'malformed',
    );
  });

  test('session not found means re-mint the key', () => {
    assert.equal(
      classifyCredentialError({ message: 'Session Not Found', statusCode: 401 }),
      'session_expired',
    );
  });

  test('missing scopes means the key lacks Flow permission', () => {
    assert.equal(
      classifyCredentialError({ message: 'Missing Scopes', statusCode: 403 }),
      'insufficient_scope',
    );
  });

  test('an unrecognised error is not guessed at', () => {
    assert.equal(classifyCredentialError({ message: 'kaboom' }), 'unknown');
  });
});

describe('credential service', () => {
  test('a key is only stored once a WRITE has succeeded', async () => {
    const { service, store } = harness();

    const status = await service.setCredential(VALID_KEY, async () => {
      throw Object.assign(new Error('Missing Scopes'), { statusCode: 403 });
    });

    assert.equal(status.valid, false);
    assert.equal(status.failure, 'insufficient_scope');
    assert.equal(store.size, 0, 'a key that cannot write must not be stored');
  });

  test('a working key is stored and reported valid', async () => {
    const { service, store } = harness();

    const status = await service.setCredential(VALID_KEY, async () => { /* write ok */ });

    assert.equal(status.valid, true);
    assert.equal(store.size, 1);
    assert.equal(service.hasCredential(), true);
  });

  test('malformed input is rejected before any network call', async () => {
    const { service } = harness();
    let called = false;

    const status = await service.setCredential('nope', async () => { called = true; });

    assert.equal(status.failure, 'malformed');
    assert.equal(called, false);
  });

  test('the key never appears in log output', async () => {
    const { service, logs } = harness();

    await service.setCredential(VALID_KEY, async () => {
      throw Object.assign(new Error(`request failed for ${VALID_KEY}`), { statusCode: 401 });
    });

    assert.equal(logs.some(line => line.includes(VALID_KEY)), false,
      'credentials must never reach the log');
  });

  test('a mid-flight failure invalidates the cached client so a re-mint takes effect', async () => {
    const { service } = harness();
    await service.setCredential(VALID_KEY, async () => { /* ok */ });

    const first = await service.getWriteClient();
    service.reportFailure({ message: 'Session Not Found', statusCode: 401 });
    const second = await service.getWriteClient();

    assert.notEqual(first, second, 'the client must be rebuilt after a session failure');
    assert.equal(service.getStatus().failure, 'session_expired');
  });

  test('asking for a client without a key gives an actionable error', async () => {
    const { service } = harness();
    await assert.rejects(() => service.getWriteClient(), /cannot create its Flows/);
  });

  test('clearing removes the key entirely', async () => {
    const { service, store } = harness();
    await service.setCredential(VALID_KEY, async () => { /* ok */ });

    service.clearCredential();

    assert.equal(store.size, 0);
    assert.equal(service.hasCredential(), false);
  });
});

/**
 * A key appears to hold a single live session: a second createLocalAPI handshake
 * claims or replaces it, invalidating the first holder (CLAUDE.md §2). At boot
 * the app's own revalidation races every controller's first reconcile, so an
 * unguarded build here means two handshakes on one key — which presents as a key
 * that "randomly" stops working minutes after it was accepted.
 */
describe('one handshake per key', () => {
  /** As harness(), but counting how many clients were actually built. */
  function counting() {
    const store = new Map<string, unknown>([['flowWriteApiKey', VALID_KEY]]);
    let built = 0;
    let fail = false;

    const service = new CredentialService({
      settings: {
        get: k => store.get(k),
        set: (k, v) => { store.set(k, v); },
        unset: k => { store.delete(k); },
      },
      createWriteClient: async () => {
        built += 1;
        // Yield, so a second caller arriving mid-handshake is a real race rather
        // than one the microtask ordering hides.
        await new Promise(resolve => setImmediate(resolve));
        if (fail) throw new Error('Homey is still starting up');
        return { id: built };
      },
      getLocalAddress: async () => 'http://127.0.0.1:80',
      log: () => { /* quiet */ },
    });

    return { service, store, built: () => built, failNext: () => { fail = true; }, succeedNext: () => { fail = false; } };
  }

  test('concurrent callers share one handshake', async () => {
    const h = counting();

    const [a, b, c] = await Promise.all([
      h.service.getWriteClient(),
      h.service.getWriteClient(),
      h.service.getWriteClient(),
    ]);

    assert.equal(h.built(), 1, 'a second handshake would invalidate the first session');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('a failed handshake is not cached', async () => {
    const h = counting();
    h.failNext();

    await assert.rejects(h.service.getWriteClient(), /still starting up/);

    h.succeedNext();
    const client = await h.service.getWriteClient();

    assert.notEqual(client, undefined);
    assert.equal(h.built(), 2, 'the retry must make a fresh attempt');
  });

  test('a handshake in flight cannot resurrect a cleared key', async () => {
    const h = counting();

    const pending = h.service.getWriteClient();
    h.service.clearCredential();

    await assert.rejects(pending, /changed while connecting/);
    // And the cleared state stands: no client was cached behind our back.
    await assert.rejects(() => h.service.getWriteClient(), /cannot create its Flows/);
  });
});
