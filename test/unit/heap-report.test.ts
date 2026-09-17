import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { heapReport, markPhase, sampleHeap } from '../../lib/support/heap-report';

/**
 * What the app can see of its own memory, and the two ways that report can be
 * wrong: by throwing, and by being a single point.
 *
 * Platform §17 is the first. `process.memoryUsage()` throws in the app sandbox,
 * and the last time a memory call went bare into an object literal it took a
 * whole health sample with it once a minute for a week — so every reading is
 * individually guarded, and `markPhase`/`sampleHeap` must be unable to fail a
 * boot or a tick.
 *
 * The second is what `trend` is for. A single `heapUsed` cannot tell steady
 * state from a slow climb, which is the only form of the question worth asking:
 * measured on the reference Homey, 17 September 2026, 27.5 MB against a 70 MB
 * limit, 22.7 h after an `onInit-end` of 12.8 MB — a number nobody could
 * interpret from one capture.
 */
describe('heap report', () => {
  test('it answers something, and says what it could not answer', () => {
    const report = heapReport();
    assert.equal(typeof report.heapUsed, 'number', 'v8 stats work everywhere this runs');
    assert.ok(Array.isArray(report.unavailable));
    // On a developer machine /proc/self/statm is missing on Windows and present
    // on Linux. Either is fine; a THROW that escaped would not be.
    assert.ok(report.rss === null || typeof report.rss === 'number');
  });

  test('a trend sample lands, oldest first', () => {
    const before = heapReport().trend.length;
    sampleHeap();
    sampleHeap();
    const trend = heapReport().trend;
    assert.equal(trend.length, before + 2);
    assert.ok(trend[trend.length - 1]!.atMs >= trend[0]!.atMs,
      'read as a slope, so the oldest reading comes first');
    assert.equal(typeof trend[0]!.heapUsed, 'number');
  });

  test('boot marks are bounded, and keep their order', () => {
    // The array this replaced had an uncapped `push` bounded only by there
    // being three call sites, under a comment saying anything per-event belongs
    // in a BoundedLog. Now the ring is what enforces it.
    for (let i = 0; i < 40; i += 1) markPhase(`stress-${i}`);
    const marks = heapReport().marks;
    assert.ok(marks.length <= 16, `bounded, saw ${marks.length}`);
    assert.equal(marks[marks.length - 1]!.phase, 'stress-39', 'newest last');
    assert.ok(marks[0]!.atMs <= marks[marks.length - 1]!.atMs);
  });

  test('neither sampler can throw, whatever it is called with', () => {
    assert.doesNotThrow(() => markPhase(''));
    assert.doesNotThrow(() => sampleHeap());
  });
});
