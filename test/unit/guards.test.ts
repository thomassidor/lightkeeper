import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationError, isRecord, optionalNumber, requireArray, requireBoolean, requireNumber,
  requireOneOf, requireRecord, requireString, requireUnitInterval,
} from '../../lib/validation/guards';

/**
 * The checks every plan validator is built from, tested on their own.
 *
 * They were covered only through the validators that call them, so a validator
 * that stopped reaching one branch silently took that branch's coverage with it.
 * Each failure must carry its PATH: the message lands in a log line beside a
 * device that has gone unavailable.
 */

function failsAt(path: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof ValidationError && error.path === path
    && error.message.startsWith(path));
}

describe('guards', () => {
  test('isRecord and requireRecord accept a plain object only', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord(null), false);
    assert.deepEqual(requireRecord({ a: 1 }, 'plan'), { a: 1 });
    failsAt('plan', () => requireRecord([], 'plan'));
  });

  test('requireString refuses an empty string and a non-string', () => {
    assert.equal(requireString('x', 'name'), 'x');
    failsAt('name', () => requireString('', 'name'));
    failsAt('name', () => requireString(1, 'name'));
  });

  test('requireBoolean refuses a truthy non-boolean', () => {
    assert.equal(requireBoolean(false, 'enabled'), false);
    failsAt('enabled', () => requireBoolean(1, 'enabled'));
  });

  test('requireNumber refuses NaN, Infinity, a fraction where an integer is wanted, and the range', () => {
    assert.equal(requireNumber(3, 'n', { min: 0, max: 5, integer: true }), 3);
    failsAt('n', () => requireNumber(Number.NaN, 'n'));
    failsAt('n', () => requireNumber(Infinity, 'n'));
    failsAt('n', () => requireNumber('3', 'n'));
    failsAt('n', () => requireNumber(1.5, 'n', { integer: true }));
    failsAt('n', () => requireNumber(-1, 'n', { min: 0 }));
    failsAt('n', () => requireNumber(6, 'n', { max: 5 }));
  });

  test('optionalNumber passes undefined through and checks anything else', () => {
    assert.equal(optionalNumber(undefined, 'n'), undefined);
    assert.equal(optionalNumber(2, 'n', { max: 2 }), 2);
    failsAt('n', () => optionalNumber(null, 'n'));
    failsAt('n', () => optionalNumber(3, 'n', { max: 2 }));
  });

  test('requireArray refuses a non-list and a list over its cap', () => {
    assert.deepEqual(requireArray([1, 2], 'lights', 2), [1, 2]);
    failsAt('lights', () => requireArray({ length: 1 }, 'lights', 2));
    failsAt('lights', () => requireArray([1, 2, 3], 'lights', 2));
  });

  test('requireOneOf names the allowed set', () => {
    assert.equal(requireOneOf('zone', 'kind', ['zone', 'devices'] as const), 'zone');
    failsAt('kind', () => requireOneOf('room', 'kind', ['zone', 'devices'] as const));
    failsAt('kind', () => requireOneOf(0, 'kind', ['zone'] as const));
  });

  test('requireUnitInterval is 0 to 1 inclusive', () => {
    assert.equal(requireUnitInterval(0, 'dim'), 0);
    assert.equal(requireUnitInterval(1, 'dim'), 1);
    failsAt('dim', () => requireUnitInterval(1.01, 'dim'));
  });

  test('an empty path still produces a readable message', () => {
    assert.throws(() => requireString(1, ''), { message: 'value is not a non-empty string' });
  });
});
