import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as enabled from '../../lib/support/evidence-feature';
import * as disabled from '../../lib/support/evidence-feature-disabled';

/**
 * The two halves of a file substitution, held in step.
 *
 * `scripts/build.mjs` makes a launch build by copying the compiled
 * `evidence-feature-disabled.js` over `evidence-feature.js` and deleting the
 * recorder and the sampler. Nothing about that is type-checked: `tsc` compiles
 * both files happily and never learns that one stands in for the other, so a
 * name added to the real module and forgotten in the twin compiles, packages,
 * validates — and then throws `TypeError: x is not a function` at `onInit` on
 * somebody's Homey, in the build that has no recorder to debug it with.
 *
 * This file is the only thing standing between that and a release, which is why
 * it checks the substitution from every direction it can:
 *
 *  - the same exported NAMES, both ways round;
 *  - the same KIND for each (a class stays a class, a constant a constant);
 *  - the same METHODS on `EvidenceFeature`, both ways round;
 *  - and, separately from any of that, the twin importing no VALUE from a module
 *    a launch build deletes.
 *
 * The last one is the trap that types cannot see at all. `import type` is erased
 * and is fine; a plain `import` of the same name emits a `require` of a file
 * that will not be there.
 */
describe('the evidence feature and its disabled twin', () => {
  const names = (module: object) => Object.keys(module).sort();

  test('export exactly the same names', () => {
    assert.deepEqual(names(disabled), names(enabled));
  });

  test('and the same kind of thing under each name', () => {
    for (const name of names(enabled)) {
      const real = (enabled as Record<string, unknown>)[name];
      const twin = (disabled as Record<string, unknown>)[name];
      assert.equal(typeof twin, typeof real, `${name} is a ${typeof twin}, not a ${typeof real}`);
    }
  });

  /**
   * The PUBLIC methods, which is the only set the substitution has to preserve.
   *
   * `private` is erased by the time there is a prototype to inspect, so the
   * real module's private helpers show up on it exactly like its API does.
   * Taking the exclusion list from the source rather than hard-coding one means
   * a new private helper needs no change here, while a new public method still
   * fails until the twin has it.
   */
  test('EvidenceFeature offers the same public methods, in both directions', () => {
    const source = readFileSync(join(process.cwd(), 'lib/support/evidence-feature.ts'), 'utf8');
    const privates = new Set([...source.matchAll(/^\s+private\s+(?:async\s+)?(\w+)\s*\(/gm)].map(m => m[1]));
    const methods = (prototype: object) =>
      Object.getOwnPropertyNames(prototype).filter(name => !privates.has(name)).sort();

    assert.ok(privates.size > 0, 'no private helpers found — has the regex gone stale?');
    assert.deepEqual(
      methods(disabled.EvidenceFeature.prototype),
      methods(enabled.EvidenceFeature.prototype),
    );
  });

  /**
   * The one rule a launch build breaks loudly and everything else quietly.
   *
   * `sink` is `undefined` rather than a no-op function so that every producer's
   * `this.deps.onEvidence?.('control_event', { … })` short-circuits BEFORE it
   * builds the payload object it would have passed. A no-op twin would be
   * correct and would still cost a household an object literal per lamp event,
   * for a feature their app does not have.
   */
  test('the twin hands producers undefined, not a no-op', () => {
    const feature = new disabled.EvidenceFeature({} as never);
    assert.equal(feature.sink, undefined);
    assert.equal(feature.status(), null);
    assert.equal(disabled.EVIDENCE_ENABLED, false);
    assert.equal(enabled.EVIDENCE_ENABLED, true);
  });

  test('and offers no Web API routes at all', () => {
    assert.deepEqual(Object.keys(disabled.evidenceRoutes(() => ({}) as never)), []);
    assert.equal(Object.keys(enabled.evidenceRoutes(() => ({}) as never)).length, 6);
  });

  test('every route the twin drops is one the manifest declares', () => {
    // Route names must match the `api` block, and `scripts/build.mjs` strips
    // those six declarations from the packaged manifest. Three lists that have
    // to agree, so they are compared rather than trusted.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), '.homeycompose/app.json'), 'utf8'));
    const declared = Object.keys(manifest.api).filter((name: string) => /Evidence$/.test(name)).sort();
    const built = Object.keys(enabled.evidenceRoutes(() => ({}) as never)).sort();
    assert.deepEqual(built, declared);

    const script = readFileSync(join(process.cwd(), 'scripts/build.mjs'), 'utf8');
    const listed = /const EVIDENCE_ROUTES = \[([^\]]*)\]/.exec(script);
    assert.ok(listed, 'scripts/build.mjs no longer lists the routes it strips');
    const stripped = [...listed[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    assert.deepEqual(stripped, declared, 'the build strips a different set than the manifest declares');
  });

  /**
   * Read as source, not as a module: an `import type` has been erased by the
   * time anything can be imported, so only the text can tell the two apart.
   */
  test('the twin imports no value from a module the launch build deletes', () => {
    const source = readFileSync(join(process.cwd(), 'lib/support/evidence-feature-disabled.ts'), 'utf8');
    for (const [, kind, from] of source.matchAll(/^import(\s+type)?\s[^;]*?from '([^']+)';/gm)) {
      if (!/evidence-(recorder|sampler)$/.test(from)) continue;
      assert.ok(kind, `evidence-feature-disabled.ts imports a VALUE from ${from}; a launch build deletes it`);
    }
  });

  /** The modules the build deletes are exactly the ones nothing else imports. */
  test('nothing outside the feature module imports the recorder or the sampler', () => {
    const offenders: string[] = [];
    for (const file of ['app.ts', 'api.ts', 'lib/app-contract.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const [line, kind, from] of source.matchAll(/^import(\s+type)?\s[^;]*?from '([^']+)';/gm)) {
        if (!/evidence-(recorder|sampler)$/.test(from) || kind) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [],
      'only lib/support/evidence-feature.ts may import the recorder as a value');
  });
});
