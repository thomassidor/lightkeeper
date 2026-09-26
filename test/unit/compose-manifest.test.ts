import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_VALUE_CAPABILITIES, PUBLISHED_DECIMALS } from '../../lib/runtime/published-values';
import { CONTROL_CAPABILITY } from '../../lib/pairing/control-choice';

/**
 * `app.json` is GENERATED from `.homeycompose/` and must never be hand-edited.
 *
 * The trap this test exists for: `homey app validate` is what regenerates it,
 * so a stale committed manifest is silently repaired by the very command you
 * would reach for to check it — locally and in CI both. The build goes green,
 * the commit ships a manifest that disagrees with its own sources, and the next
 * person to run validate gets an unexplained diff.
 *
 * So the comparison happens here, where nothing can quietly fix it first. It is
 * a SUBSET check by design: every compose source must appear verbatim in
 * app.json. Extra fields in app.json are the CLI's business (`_comment`, the
 * `id` it stamps onto each driver), and `homey app validate` is what judges
 * those.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const readJson = (...parts: string[]) =>
  JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

const manifest = readJson('app.json') as Record<string, any>;

/** Cards declared app-wide, by id. */
function composedCards(dir: string): Map<string, Record<string, unknown>> {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return new Map();
  return new Map(readdirSync(full)
    .filter(f => f.endsWith('.json'))
    .map(f => [f.replace(/\.json$/, ''), readJson(dir, f) as Record<string, unknown>]));
}

/** Cards declared by a driver, by id, with the driver that owns them. */
function driverCards(
  type: 'conditions' | 'triggers' | 'actions',
): Map<string, { driverId: string; source: Record<string, unknown> }> {
  const found = new Map<string, { driverId: string; source: Record<string, unknown> }>();
  for (const entry of readdirSync(join(ROOT, 'drivers'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(ROOT, 'drivers', entry.name, 'driver.flow.compose.json');
    if (!existsSync(path)) continue;
    const cards = (readJson('drivers', entry.name, 'driver.flow.compose.json')[type] ?? []) as Array<Record<string, unknown>>;
    for (const card of cards) found.set(String(card.id), { driverId: entry.name, source: card });
  }
  return found;
}

describe('app.json is generated from .homeycompose/', () => {
  test('every app-level field matches its compose source', () => {
    const composed = readJson('.homeycompose', 'app.json') as Record<string, unknown>;

    for (const [key, value] of Object.entries(composed)) {
      assert.deepEqual(
        manifest[key], value,
        `app.json "${key}" disagrees with .homeycompose/app.json — app.json is `
        + 'generated, so run `npm run validate` and commit the result',
      );
    }
  });

  test('the flow actions match the files in .homeycompose/flow/actions/', () => {
    const dir = join(ROOT, '.homeycompose', 'flow', 'actions');
    const ids = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();

    const actions = (manifest.flow?.actions ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(
      actions.map(a => String(a.id)).sort(), ids,
      'app.json\'s flow actions are not the files in .homeycompose/flow/actions/',
    );

    for (const id of ids) {
      const source = readJson('.homeycompose', 'flow', 'actions', `${id}.json`);
      const generated = actions.find(a => a.id === id);
      // The CLI stamps the id on from the filename; everything else is verbatim.
      assert.deepEqual(generated, { ...source, id }, `flow action "${id}" drifted`);
    }
  });

  /**
   * The bridge cards are hidden from the Flow editor's card picker.
   *
   * `deprecated` is a real flowCard property — homey-lib's own app schema
   * declares it (`definitions.flowCard.properties.deprecated`, `enum: [true]`),
   * which is why this validates at publish level. What it buys: these cards are
   * ours to write and nobody else's to add by hand, and a Flow somebody built
   * around one carries a Lightkeeper device id it does not belong to. The
   * sweep already refuses to DELETE such a Flow (looksGenerated); this stops it
   * being made in the first place.
   *
   * Pinned by a test because removing it is a one-character edit that nothing
   * else would notice, and because "deprecated" reads, wrongly, like something
   * on its way out.
   */
  test('all three bridge cards are hidden from the Flow editor', () => {
    const actions = (manifest.flow as any)?.actions as Array<Record<string, unknown>>;
    for (const id of ['bridge_event', 'bridge_numeric_event', 'bridge_token_event']) {
      assert.equal(
        actions.find(a => a.id === id)?.deprecated, true,
        `${id} must stay hidden from the card picker`,
      );
    }
  });

  /**
   * The conditions and triggers, which come from a DIFFERENT place.
   *
   * A driver's own `driver.flow.compose.json` is merged into the app-level
   * `flow` block, not into the driver (the app schema has no `flow` on a
   * driver), and the CLI unshifts a `device` argument onto every card on the
   * way — so a card declared per driver arrives beside the app-level ones with
   * one more argument than its source has. Checked here because the actions
   * test above would otherwise be the only parity check there is, and it looks
   * from its name like it covers all three types.
   *
   * The `$`-prefixed keys a compose source may carry (`$extends`, `$filter`,
   * `$id`) are stripped recursively before `app.json` is written, which is also
   * why the per-driver `deepEqual` below still holds with this file present.
   */
  test('the conditions and triggers match their compose sources', () => {
    for (const type of ['conditions', 'triggers'] as const) {
      const fromApp = composedCards(join('.homeycompose', 'flow', type));
      const fromDrivers = driverCards(type);
      const expected = [...fromApp.keys(), ...fromDrivers.keys()].sort();

      const generated = ((manifest.flow?.[type] ?? []) as Array<Record<string, any>>);
      assert.deepEqual(
        generated.map(card => String(card.id)).sort(), expected,
        `app.json's flow ${type} are not the cards declared in .homeycompose/ and drivers/`,
      );

      for (const [id, source] of fromApp) {
        assert.deepEqual(generated.find(c => c.id === id), { ...source, id }, `flow ${type} "${id}" drifted`);
      }

      for (const [id, { driverId, source }] of fromDrivers) {
        const card = generated.find(c => c.id === id) as Record<string, any> | undefined;
        assert.ok(card, `flow ${type} "${id}" is missing from app.json`);
        // The device argument the CLI adds, and nothing else about it.
        assert.deepEqual(card.args?.[0], {
          type: 'device', name: 'device', filter: `driver_id=${driverId}`,
        }, `flow ${type} "${id}" lost its device argument`);
        assert.deepEqual(
          { ...card, args: (card.args as unknown[]).slice(1) }, { ...source, id },
          `flow ${type} "${id}" drifted`,
        );
      }
    }
  });

  /**
   * The custom capabilities, which nothing else guards.
   *
   * They are a name map twice over: a capability the manifest defines but no
   * driver declares is invisible, and one a driver declares but the manifest
   * does not define fails validation with a message about the driver rather
   * than about the missing file. The runtime half — that the ids the app
   * publishes under are these ids — is `VALUE_CAPABILITIES` in
   * `lib/runtime/published-values.ts`, tied to this set below.
   */
  test('the capabilities match the files in .homeycompose/capabilities/', () => {
    const dir = join(ROOT, '.homeycompose', 'capabilities');
    const ids = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();

    assert.deepEqual(Object.keys(manifest.capabilities ?? {}).sort(), ids);
    for (const id of ids) {
      assert.deepEqual(
        manifest.capabilities[id], readJson('.homeycompose', 'capabilities', `${id}.json`),
        `capability "${id}" drifted`,
      );
    }

    // Every id the runtimes publish under is one of these, and every one of
    // these is carried by at least one driver. Either half failing means a
    // value computed every minute that lands nowhere. The one that is not a
    // published value is the control picker, which the device layer owns.
    assert.deepEqual([...ALL_VALUE_CAPABILITIES, CONTROL_CAPABILITY].sort(), ids);

    const carried = new Set(
      (manifest.drivers as Array<Record<string, any>>).flatMap(d => d.capabilities as string[]),
    );
    for (const id of ids) assert.ok(carried.has(id), `no driver carries "${id}"`);
  });

  /**
   * A read-only capability stays read-only, and keeps the resolution its gate
   * assumes.
   *
   * `setable: false` is what makes these rows a reading rather than a control:
   * Homey draws a slider for a setable number, and a driver with no capability
   * listener behind it rejects the write. And `decimals` is half of a contract
   * with `PUBLISHED_DECIMALS` — the board rounds to it before deciding whether
   * anything moved, so a capability that declared more would publish changes
   * Homey then rounded away, once a minute, forever.
   */
  test('every value capability is read-only, at the resolution the gate assumes', () => {
    for (const id of ALL_VALUE_CAPABILITIES) {
      const capability = manifest.capabilities[id];
      assert.equal(capability.setable, false, `${id} must not be setable`);
      assert.equal(capability.getable, true, `${id} must be getable`);
      if (capability.type === 'number') {
        assert.equal(capability.decimals, PUBLISHED_DECIMALS, `${id} must match PUBLISHED_DECIMALS`);
      }
    }
  });

  /**
   * The one custom capability that IS a control.
   *
   * Its values are `ControlMode`s verbatim, which is what lets the device layer
   * hand a picked value straight to the rules the review screen uses. A
   * Room-sensing Light narrows it through `capabilitiesOptions`, and a narrowed
   * list that named a value the capability does not have would draw a choice
   * nothing can store.
   */
  test('the control picker offers exactly the three modes, and a Room-sensing Light two', () => {
    const control = manifest.capabilities[CONTROL_CAPABILITY];
    assert.equal(control.type, 'enum');
    assert.equal(control.setable, true);
    assert.equal(control.uiComponent, 'picker');
    const ids = (values: Array<{ id: string }>) => values.map(v => v.id);
    assert.deepEqual(ids(control.values), ['after', 'before', 'none']);

    const drivers = manifest.drivers as Array<Record<string, any>>;
    const carriers = drivers.filter(d => (d.capabilities as string[]).includes(CONTROL_CAPABILITY));
    assert.deepEqual(carriers.map(d => d.id).sort(), ['circadian', 'curve', 'daylight']);

    const daylight = drivers.find(d => d.id === 'daylight')!;
    assert.deepEqual(ids(daylight.capabilitiesOptions[CONTROL_CAPABILITY].values), ['after', 'none']);
  });

  /**
   * Every custom capability carries an icon, and every icon file is one of them.
   *
   * Homey's own default icons (platform §10): a system capability's icon cannot
   * be borrowed by name, so the files ship under `assets/capabilities/`. The
   * validator checks the path exists case-exactly; this checks it first, and
   * that the folder holds nothing no capability names.
   */
  test('every custom capability has an icon, and no icon is orphaned', () => {
    const dir = join(ROOT, 'assets', 'capabilities');
    const files = new Set(readdirSync(dir));
    const named = new Set<string>();
    for (const [id, capability] of Object.entries(manifest.capabilities ?? {}) as Array<[string, any]>) {
      assert.match(String(capability.icon), /^\/assets\/capabilities\/[a-z_]+\.svg$/, `${id} has no icon`);
      const file = String(capability.icon).split('/').pop()!;
      assert.ok(files.has(file), `${id}: ${capability.icon} does not exist (case-exact)`);
      named.add(file);
    }
    for (const file of files) assert.ok(named.has(file), `assets/capabilities/${file} is named by no capability`);
  });

  test('every driver matches its driver.compose.json', () => {
    // Discovered from disk, not listed here: a third driver must not be able to
    // ship with an unchecked manifest.
    const driverIds = readdirSync(join(ROOT, 'drivers'), { withFileTypes: true })
      .filter(e => e.isDirectory()
        && existsSync(join(ROOT, 'drivers', e.name, 'driver.compose.json')))
      .map(e => e.name)
      .sort();

    const drivers = (manifest.drivers ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(
      drivers.map(d => String(d.id)).sort(), driverIds,
      'app.json\'s drivers are not the folders under drivers/',
    );

    for (const id of driverIds) {
      const source = readJson('drivers', id, 'driver.compose.json');
      const generated = drivers.find(d => d.id === id);
      assert.deepEqual(generated, { ...source, id }, `driver "${id}" drifted`);
    }
  });
});

/**
 * Every route the manifest declares is a function `api.ts` actually exports.
 *
 * The manifest's `api` block is a NAME MAP: Homey routes `GET /evidence` to
 * whatever `module.exports.getEvidence` happens to be, and a name that matches
 * nothing produces no build error, no validate error and no test failure —
 * only a 404 at the moment somebody presses a button in the settings page.
 * The reverse is just as quiet: an exported handler with no manifest entry is
 * unreachable and looks, from the code, exactly like a working feature.
 *
 * Nothing checked this until the recorder added six routes at once, which is
 * six chances to typo a name that only a Homey would ever tell you about.
 *
 * Read as SOURCE rather than imported: `api.ts` imports the app contract and
 * the whole `lib/` tree behind it, and this file is about names.
 */
describe('the app API surface', () => {
  const source = readFileSync(join(ROOT, 'api.ts'), 'utf8');

  /**
   * `  async name(` or `  name(` at the top level of `module.exports = {`, plus
   * anything reached through a spread.
   *
   * The recorder's six routes are not written out in `api.ts` at all: they come
   * from `...evidenceRoutes(appOf)`, so that a launch build can drop them by
   * returning none rather than by deleting them from generated JavaScript
   * (`lib/support/evidence-feature.ts`). A source scan that only knew about
   * literal properties would call all six missing.
   *
   * Each spread is followed to the module that defines it and scanned the same
   * way, which keeps this test honest about the one thing it is for — a route
   * declared in the manifest with no handler behind it is a 404 at the moment
   * somebody presses the button.
   */
  const handlersIn = (text: string) =>
    [...text.matchAll(/^ {2,4}(?:async )?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm)].map(m => m[1]!);

  /**
   * Every handler name `module.exports` ends up carrying, spreads followed.
   *
   * A function rather than a constant, and called from inside each test, because
   * an assertion that throws out here fails the SUITE without being counted:
   * `node --test` reported `fail 0` on a broken file while this was module-level
   * code. Anything that can throw belongs in a test.
   *
   * Following the spreads is the point. The recorder's six routes are not written
   * out in `api.ts` at all — they arrive as `...evidenceRoutes(appOf)` so that a
   * launch build can drop them by returning none, rather than by deleting them
   * from generated JavaScript (`lib/support/evidence-feature.ts`). A scan that
   * only knew about literal properties would call all six missing.
   */
  const handlerNames = () => {
    const names = new Set(handlersIn(source));
    for (const [, fn] of source.matchAll(/^ {2}\.\.\.([a-zA-Z][a-zA-Z0-9_]*)\(/gm)) {
      const line = source.split(/\r?\n/).find(text =>
        text.startsWith('import ') && text.includes(fn) && text.includes(' from '));
      assert.ok(line, `api.ts spreads ${fn}() but does not import it`);
      const from = /from '([^']+)'/.exec(line);
      assert.ok(from, `cannot read a module path out of: ${line}`);
      for (const name of handlersIn(readFileSync(join(ROOT, `${from[1]!}.ts`), 'utf8'))) names.add(name);
    }
    return names;
  };

  const routes = () => {
    const composed = readJson('.homeycompose', 'app.json') as { api?: Record<string, unknown> };
    return Object.keys(composed.api ?? {});
  };

  test('the api block is not empty, or this whole test is vacuous', () => {
    assert.ok(routes().length > 10, `only ${routes().length} routes found`);
    const exported = handlerNames();
    assert.ok(exported.size > 10, `only ${exported.size} handlers parsed out of api.ts`);
  });

  test('every declared route names a handler api.ts exports', () => {
    const exported = handlerNames();
    const missing = routes().filter(name => !exported.has(name));
    assert.deepEqual(
      missing, [],
      'declared in .homeycompose/app.json\'s "api" block but not exported by api.ts — '
      + 'these are a 404 at the moment a user presses the button',
    );
  });

  test('and app.json carries the same block, since it is generated', () => {
    const generated = (manifest.api ?? {}) as Record<string, unknown>;
    const composed = (readJson('.homeycompose', 'app.json').api ?? {}) as Record<string, unknown>;
    assert.deepEqual(generated, composed, 'run `npm run validate` and commit app.json');
  });

  test('every route declares a method and a path', () => {
    const composed = (readJson('.homeycompose', 'app.json').api ?? {}) as Record<string, any>;
    for (const [name, route] of Object.entries(composed)) {
      assert.ok(
        ['GET', 'POST', 'PUT', 'DELETE'].includes(String(route?.method)),
        `route "${name}" has method "${route?.method}"`,
      );
      assert.ok(String(route?.path ?? '').startsWith('/'), `route "${name}" has path "${route?.path}"`);
    }
  });
});
