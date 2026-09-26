import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { resolveBoundaries, zoneValueAt, DEFAULT_ZONES, type CircadianZones } from '../../lib/circadian/simple-curve';
import { TRANSITIONS, shape } from '../../lib/support/interpolate';
import type { AnchorContext } from '../../lib/circadian/circadian-curve';

/**
 * The two places a pairing screen carries its own copy of the engine's maths,
 * held to the engine.
 *
 * A pair view cannot import anything (platform §8), so where a screen has to
 * redraw under a finger — the day screen's strip while a handle is dragged —
 * it computes the curve itself. That is a second implementation, and the one
 * this replaced had already drifted: the strip blended linearly while the
 * engine eased, and nothing noticed, because no test ever put the two side by
 * side. This one does, by lifting each function out of the file and running it.
 *
 *  - `transitionShape` (views/shared/transition-shape.js, spliced into every
 *    carrier) against `shape()` in lib/support/interpolate.ts;
 *  - the day screen's `zoneWarmthAt` against `zoneValueAt` in
 *    lib/circadian/simple-curve.ts, over several days and every transition.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** `function <name>(…) { … }`, matched to its closing brace. */
function lift(file: string, name: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const at = text.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${file} has no ${name}()`);
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return assert.fail(`${file}: ${name}() has unbalanced braces`);
}

type ShapeFn = (kind: string, t: number) => number;
type ZoneFn = (zones: CircadianZones, bounds: unknown, kind: string, minute: number) => number;

// Each run in a fresh context: the lifted source is a script, never code of ours.
const transitionShape = runInNewContext(
  `${lift('views/shared/transition-shape.js', 'transitionShape')}\ntransitionShape;`,
) as ShapeFn;

const zoneWarmthAt = runInNewContext(
  `${lift('views/shared/transition-shape.js', 'transitionShape')}\n`
  + `${lift('drivers/circadian/pair/day.html', 'zoneWarmthAt')}\nzoneWarmthAt;`,
) as ZoneFn;

describe('the screens compute what the engine computes', () => {
  test('transitionShape is shape()', () => {
    for (const transition of TRANSITIONS) {
      for (let i = -10; i <= 110; i++) {
        const t = i / 100;
        assert.ok(
          Math.abs(transitionShape(transition, t) - shape(transition, t)) < 1e-12,
          `${transition} at ${t}`,
        );
      }
    }
  });

  test("the day screen's strip is zoneValueAt, for every transition and several days", () => {
    const days: AnchorContext[] = [
      {},
      { sunriseMinute: 6 * 60 + 30, sunsetMinute: 20 * 60 },
      // A short winter day, where the clamps decide the boundaries.
      { sunriseMinute: 10 * 60, sunsetMinute: 14 * 60 },
    ];
    const zoneSets: CircadianZones[] = [
      DEFAULT_ZONES,
      { ...DEFAULT_ZONES, morningEnd: 150, eveningStart: -150,
        morning: { temperature: 0.1 }, midday: { temperature: 0.9 }, evening: { temperature: 0.3 } },
    ];
    for (const context of days) {
      for (const zones of zoneSets) {
        // The screen is sent the RESOLVED boundaries, as getDay does.
        const bounds = resolveBoundaries(zones, context);
        for (const transition of TRANSITIONS) {
          for (let minute = 0; minute < 1440; minute += 7) {
            const engine = zoneValueAt(zones, context, false, transition, minute).warmth;
            const screen = zoneWarmthAt(zones, bounds, transition, minute);
            assert.ok(
              Math.abs(engine - screen) < 1e-9,
              `${transition} at ${minute} (${JSON.stringify(context)}): engine ${engine}, screen ${screen}`,
            );
          }
        }
      }
    }
  });
});
