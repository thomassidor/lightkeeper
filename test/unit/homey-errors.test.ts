import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNotFound, isTransportFailure, redactKeyMaterial, messageOf, redactedMessage,
} from '../../lib/support/homey-errors';

/**
 * The three predicates the whole write path's error handling rests on, and
 * they were the ONE thing in `lib/support/` with no test of its own — each of
 * their docblocks claimed otherwise.
 *
 * Both of the first two are "deliberately NARROW", in opposite directions, and
 * the cost of getting either wrong is specific:
 *
 *   isNotFound too wide         a delete is treated as already done, the
 *                               reference is dropped, and the Flow goes on
 *                               firing under a controller id that is still
 *                               live — so the orphan sweep cannot see it either
 *   isNotFound too narrow       a genuinely absent Flow is retried for ever
 *   isTransportFailure too wide a working client is thrown away and rebuilt on
 *                               every application error the Homey reports
 *   too narrow                  a dead socket is never noticed
 */

describe('isNotFound', () => {
  test('a 404 in any of the three status fields', () => {
    assert.equal(isNotFound({ statusCode: 404 }), true);
    assert.equal(isNotFound({ status: 404 }), true);
    assert.equal(isNotFound({ code: 404 }), true);
    assert.equal(isNotFound({ code: '404' }), true, 'code is a string on some paths');
  });

  test('the platform message shape, when there is no status at all', () => {
    assert.equal(isNotFound({ message: '404 Not Found: FlowCardAction with ID x' }), true);
    assert.equal(isNotFound({ message: 'Not Found' }), true);
    assert.equal(isNotFound({ message: 'not_found' }), true);
    assert.equal(isNotFound({ message: '  404 Not Found  ' }), true, 'surrounding space');
  });

  test('A STATUS THAT IS NOT 404 IS THE ANSWER, whatever the message says', () => {
    // The finding. Homey echoes device and flow ids back inside error
    // messages, and a hex id carrying `404` between two non-digits is roughly
    // one UUID in three hundred. The old code tested the message regardless of
    // the status, so these all read as "already gone".
    for (const status of [409, 423, 500, 401, 403, 502]) {
      assert.equal(
        isNotFound({ statusCode: status, message: `Conflict on flow a404b-cdef-0123` }),
        false,
        `status ${status} with a 404-shaped id read as not-found`,
      );
    }
  });

  test('and an id containing 404 is not a status even without one', () => {
    // Anchored, so the number has to BE the status rather than appear in a
    // sentence. Every one of these used to match.
    for (const message of [
      'Conflict: flow a404b-cdef-0123-4567-89abcdef0123 is locked',
      'Device 404abc is busy',
      'Rate limited after 404 requests',
      'x404x',
      'error 1404',
    ]) {
      assert.equal(isNotFound({ message }), false, `matched: ${message}`);
    }
  });

  test('"we could not tell" is never "it is gone"', () => {
    // The docblock's own promise: 401, 403 and every connectivity error stay
    // failures, because dropping a reference on one loses a live Flow.
    assert.equal(isNotFound({ statusCode: 401, message: 'Unauthorized' }), false);
    assert.equal(isNotFound({ statusCode: 403, message: 'Missing Scopes' }), false);
    assert.equal(isNotFound({ code: 'ECONNRESET' }), false);
    assert.equal(isNotFound({ message: 'socket hang up' }), false);
    assert.equal(isNotFound(undefined), false);
    assert.equal(isNotFound(null), false);
    assert.equal(isNotFound({}), false);
    assert.equal(isNotFound(new Error('')), false);
  });
});

describe('isTransportFailure', () => {
  test('any status at all means the transport worked', () => {
    for (const status of [200, 400, 401, 403, 404, 409, 500, 502]) {
      assert.equal(
        isTransportFailure({ statusCode: status, message: 'connection reset' }),
        false,
        `status ${status} with a transport-shaped message`,
      );
    }
  });

  test('Node connection codes, with no status', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
      'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']) {
      assert.equal(isTransportFailure({ code }), true, code);
    }
    assert.equal(isTransportFailure({ code: 'ENOENT' }), false, 'a missing file is not a socket');
    assert.equal(isTransportFailure({ code: 'EACCES' }), false);
  });

  test('messages that name a connection problem', () => {
    for (const message of ['socket hang up', 'connection reset by peer',
      'connection refused', 'connection closed', 'connection lost',
      'not connected', 'disconnected', 'request timed out', 'timeout',
      'network error', 'network unreachable']) {
      assert.equal(isTransportFailure({ message }), true, message);
    }
  });

  test('and "network" as part of a WORD is not a network failure', () => {
    // A statusless TypeError from our own code, which used to drop a healthy
    // client: the old alternative was the bare word `network`.
    for (const message of [
      "Cannot read properties of undefined (reading 'networkName')",
      'networkName is not defined',
      'zone "Network cupboard" has no lights',
    ]) {
      assert.equal(isTransportFailure({ message }), false, `matched: ${message}`);
    }
  });

  test('nothing at all is not a transport failure', () => {
    assert.equal(isTransportFailure(null), false);
    assert.equal(isTransportFailure(undefined), false);
    assert.equal(isTransportFailure({}), false);
    assert.equal(isTransportFailure({ message: '' }), false);
    assert.equal(isTransportFailure('a string'), false);
  });
});

describe('redactKeyMaterial', () => {
  test('a whole key collapses to one marker, not three', () => {
    const key = '01234567-89ab-cdef-0123-456789abcdef:'
      + 'fedcba98-7654-3210-fedc-ba9876543210:'
      + '0123456789abcdef0123456789abcdef01234567';
    const out = redactKeyMaterial(`401 for ${key}`);

    assert.ok(!out.includes('0123456789abcdef'), 'the secret segment survived');
    assert.equal(out.match(/<redacted>/g)?.length, 1, `collapsed to: ${out}`);
  });

  test('a UUID is left alone, because it is what makes a log line useful', () => {
    // The reason the threshold is 20 CONTIGUOUS hex characters: a UUID's
    // longest unbroken run is its 12-character final group.
    const message = '404 Not Found: FlowCardAction 01234567-89ab-cdef-0123-456789abcdef';
    assert.equal(redactKeyMaterial(message), message);
  });

  test('a bare secret segment anywhere in a sentence', () => {
    const out = redactKeyMaterial('token 0123456789abcdef0123456789abcdef failed');
    assert.equal(out, 'token <redacted> failed');
  });

  test('and it never throws on an empty string', () => {
    assert.equal(redactKeyMaterial(''), '');
  });
});

describe('messageOf and redactedMessage', () => {
  test('an Error keeps its own words, which is the point', () => {
    // `404 Not Found: FlowCardAction with ID x` is the message that costs
    // hours; replacing it with "could not reach Homey" sends the next reader
    // somewhere else entirely.
    assert.equal(
      messageOf(new Error('404 Not Found: FlowCardAction')),
      '404 Not Found: FlowCardAction',
    );
  });

  test('and a non-Error still produces something a log can carry', () => {
    for (const value of [undefined, null, 42, 'plain string', {}, []]) {
      assert.equal(typeof messageOf(value), 'string', JSON.stringify(value));
    }
  });

  test('redactedMessage is messageOf with the key scrubbed', () => {
    const out = redactedMessage(new Error('401 for 0123456789abcdef0123456789abcdef'));
    assert.ok(out.includes('401'), 'lost the status, which is the diagnosable part');
    assert.ok(!out.includes('0123456789abcdef'), 'kept the key');
  });
});
