import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CredentialService, redactKeyMaterial, sanitizedWriteError,
} from '../../lib/credential-service';
import { HomeyApiService } from '../../lib/homey-api-service';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';

/**
 * The diagnostics export is offered to users with an explicit
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
      app: { id: 'com.thomassidor.lightkeeper', version: '0.1.0' },
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

describe('redactKeyMaterial', () => {
  test('removes a whole key from surrounding text', () => {
    const out = redactKeyMaterial(`PUT /api/flow failed for token ${REAL_KEY} at 12:04`);

    assert.equal(out.includes(SECRET), false);
    assert.equal(out.includes(REAL_KEY), false);
    assert.match(out, /PUT \/api\/flow failed for token <redacted> at 12:04/);
  });

  test('removes the secret segment on its own', () => {
    assert.equal(redactKeyMaterial(`bearer ${SECRET}`).includes(SECRET), false);
  });

  test('leaves ordinary error text alone', () => {
    const message = '404 Not Found: FlowCardAction with ID com.thomassidor.lightkeeper:bridge_event';
    assert.equal(redactKeyMaterial(message), message);
  });

  test('does not eat Homey ids out of a diagnosable message', () => {
    // Homey ids are UUIDs: the longest unbroken hex run is 12 characters, so the
    // 20+ rule cannot reach them. A redaction that swallowed device ids would
    // make every failure log useless.
    const message = 'Flow 4f8c1a2b-33de-4c0f-9a71-2b6d0e9f1c44 could not be deleted';
    assert.equal(redactKeyMaterial(message), message);
  });
});

describe('sanitizedWriteError', () => {
  test('a classified credential failure becomes its own actionable sentence', () => {
    const error = sanitizedWriteError(
      new Error(`Session Not Found (token ${REAL_KEY})`),
    ) as Error & { credentialFailure: string };

    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.credentialFailure, 'session_expired');
    assert.match(error.message, /no longer valid/);
  });

  test('an unclassified platform error keeps its meaning, redacted', () => {
    // This is the error CLAUDE.md §3 says costs hours to recognise. Replacing it
    // with "could not reach Homey" would send the next reader somewhere else.
    const error = sanitizedWriteError(
      new Error(`404 Not Found: FlowCardAction with ID x (auth ${REAL_KEY})`),
    );

    assert.equal(error.message.includes(SECRET), false);
    assert.match(error.message, /FlowCardAction with ID x/);
  });

  test('never returns the original error object', () => {
    const original = new Error(`Missing Scopes for ${REAL_KEY}`);
    const sanitized = sanitizedWriteError(original);

    assert.notEqual(sanitized, original);
    assert.equal(JSON.stringify(sanitized.message).includes(SECRET), false);
  });

  test('carries the status code through for classification', () => {
    const error = sanitizedWriteError(
      Object.assign(new Error('nope'), { statusCode: 403 }),
    ) as Error & { statusCode?: number; credentialFailure: string };

    assert.equal(error.statusCode, 403);
    assert.equal(error.credentialFailure, 'insufficient_scope');
  });
});

describe('write failures never carry the key out of the write path', () => {
  /**
   * A whole flow write, with the real CredentialService and HomeyApiService in
   * place: only the client that talks to Homey is faked, and it fails the way an
   * API can — by quoting the request back, token and all.
   */
  function writePath() {
    const logged: string[] = [];
    const store = new Map<string, unknown>([['flowWriteApiKey', REAL_KEY]]);

    const credentials = new CredentialService({
      settings: {
        get: k => store.get(k),
        set: (k, v) => { store.set(k, v); },
        unset: k => { store.delete(k); },
      },
      createWriteClient: async () => ({
        flow: {
          createFlow: async () => { throw new Error(`403 Forbidden: PUT /api/manager/flow?token=${REAL_KEY}`); },
          deleteFlow: async () => { throw new Error(`Session Not Found; token was ${REAL_KEY}`); },
          createFlowFolder: async () => { throw new Error(`Missing Scopes for ${REAL_KEY}`); },
        },
      }),
      getLocalAddress: async () => 'http://127.0.0.1:80',
      log: (...args) => { logged.push(args.map(String).join(' ')); },
    });

    const api = new HomeyApiService({ api: {} }, credentials);
    return { api, credentials, logged };
  }

  const leaks = (text: string) => text.includes(SECRET) || text.includes(REAL_KEY);

  test('createFlow: the thrown error is classified, not echoed', async () => {
    const { api } = writePath();

    await assert.rejects(
      api.withWriteClient(async client => client.flow.createFlow()),
      (error: Error) => {
        assert.equal(leaks(error.message), false, 'the thrown message leaked the key');
        assert.equal(leaks(String(error.stack ?? '')), false, 'the stack leaked the key');
        return true;
      },
    );
  });

  test('deleteFlow through the bridge logs nothing sensitive and does not throw', async () => {
    const { api, logged } = writePath();
    const bridge = new FlowBridgeManager(api, 'com.thomassidor.lightkeeper', (...args) => {
      logged.push(args.map(String).join(' '));
    });

    const deleted = await bridge.removeAll([{
      flowId: 'flow-1', bindingKey: 'k', variantKey: 'fixed',
      fingerprint: 'fp', managedVersion: 1, createdAt: 1,
    }]);

    assert.equal(deleted, 0, 'a failed delete is reported, not thrown');
    assert.equal(logged.length > 0, true, 'the failure must still be diagnosable');
    for (const line of logged) {
      assert.equal(leaks(line), false, `a log line leaked the key: ${line}`);
    }
  });

  test('createFlowFolder: the folder path leaks nothing either', async () => {
    const { api, logged } = writePath();

    await assert.rejects(
      api.withWriteClient(async client => client.flow.createFlowFolder({ flowfolder: { name: 'x' } })),
      (error: Error) => {
        assert.equal(leaks(error.message), false);
        return true;
      },
    );

    for (const line of logged) {
      assert.equal(leaks(line), false, `a log line leaked the key: ${line}`);
    }
  });

  test('the credential status after all three failures is still clean', async () => {
    const { api, credentials } = writePath();

    await api.withWriteClient(async c => c.flow.createFlow()).catch(() => { /* expected */ });
    await api.withWriteClient(async c => c.flow.deleteFlow()).catch(() => { /* expected */ });

    const serialised = JSON.stringify(credentials.getStatus());
    assert.equal(leaks(serialised), false);
    assert.equal(credentials.getStatus().valid, false);
  });
});
