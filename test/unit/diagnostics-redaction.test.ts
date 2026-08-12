import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CredentialService } from '../../lib/credential-service';

/**
 * §12 / §9.5 — the diagnostics export is offered to users with an explicit
 * invitation to attach it to a bug report. It must therefore never carry API
 * key material.
 *
 * This is proved by test rather than by code review, and asserts on SERIALISED
 * output: a getter that looks safe can still be walked by JSON.stringify, and
 * that is what actually leaves the app.
 */

/**
 * NOT A REAL KEY, despite the name — it stands in for one so the assertions
 * below can prove it never appears in serialised output. Synthetic and obvious:
 * repeated hex nibbles and a counting secret.
 */
const REAL_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:11111111-2222-3333-4444-555555555555:'
  + '0123456789abcdef0123456789abcdef01234567';

/** The secret third segment — the part that would matter if it leaked. */
const SECRET = '0123456789abcdef0123456789abcdef01234567';

function serviceHoldingRealKey() {
  const store = new Map<string, unknown>([['flowWriteApiKey', REAL_KEY]]);
  return new CredentialService({
    settings: {
      get: k => store.get(k),
      set: (k, v) => { store.set(k, v); },
      unset: k => { store.delete(k); },
    },
    createWriteClient: async () => ({}),
    getLocalAddress: async () => 'http://127.0.0.1:80',
    log: () => { /* quiet */ },
  });
}

describe('credential redaction', () => {
  test('getStatus never serialises the key', () => {
    const service = serviceHoldingRealKey();
    const serialised = JSON.stringify(service.getStatus());

    assert.equal(serialised.includes(SECRET), false, 'the secret segment leaked');
    assert.equal(serialised.includes(REAL_KEY), false, 'the whole key leaked');
  });

  test('getStatus after a failure still carries no key', () => {
    const service = serviceHoldingRealKey();
    service.reportFailure({ message: 'Session Not Found', statusCode: 401 });

    const status = service.getStatus();
    const serialised = JSON.stringify(status);

    assert.equal(status.valid, false);
    assert.equal(status.failure, 'session_expired');
    assert.equal(serialised.includes(SECRET), false);
  });

  test('a whole diagnostics payload containing the status stays clean', () => {
    const service = serviceHoldingRealKey();

    // The shape api.ts getDiagnostics builds, with the credential status
    // embedded exactly as it is there.
    const payload = {
      generatedAt: 1,
      app: { id: 'com.thomassidor.lightlink', version: '0.1.0' },
      credential: service.getStatus(),
      recentEvents: [
        { at: 1, cardId: 'bridge_event', controller: 'c1', eventKey: 'k', accepted: true },
      ],
      controllers: [{ controllerId: 'c1', credential: service.getStatus() }],
    };

    const serialised = JSON.stringify(payload);
    assert.equal(serialised.includes(SECRET), false);
    assert.equal(serialised.includes(REAL_KEY), false);
  });

  test('the service reports it holds a key without revealing it', () => {
    const service = serviceHoldingRealKey();

    assert.equal(service.hasCredential(), true);
    assert.equal(service.getStatus().present, true);
    assert.equal(JSON.stringify(service.getStatus()).includes(SECRET), false);
  });

  test('an error echoing the token is not stored on the status', async () => {
    const service = serviceHoldingRealKey();

    // Some API errors quote the offending request back, token and all. The
    // classifier must reduce that to a code, never carry the text through.
    await service.revalidate(async () => {
      throw new Error(`Session Not Found for token ${REAL_KEY}`);
    });

    const serialised = JSON.stringify(service.getStatus());
    assert.equal(serialised.includes(SECRET), false, 'an error message leaked the key');
    assert.equal(service.getStatus().failure, 'session_expired');
  });
});
