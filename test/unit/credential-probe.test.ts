import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { flowWriteProbe } from '../../lib/credential-service';

/**
 * The whole of credential validation, and it had no test.
 *
 * Two things make that worth fixing rather than noting. It runs on the RAW write
 * client — outside `withWriteClient`, which is the one boundary that sanitises
 * an error before it can quote the API key back — so its failure paths are the
 * ones closest to the key. And its opening sweep is the only place in this app
 * that DELETES a Flow folder matched by a name a user could also type, guarded
 * only by an exact name match plus `parent === null`.
 *
 * It also has to be a write. Every flow READ succeeds on a key that cannot write
 * a thing (platform §1), so a read-based check sends the user away happy with a
 * key that will fail at the first reconcile.
 */

const PROBE_NAME = 'Lightkeeper (checking permissions)';

function client(over: {
  folders?: Record<string, { id: string; name: string; parent: string | null }>;
  failList?: Error;
  failCreate?: Error;
  failDelete?: Error;
  createReturns?: unknown;
} = {}) {
  const calls: string[] = [];
  const deleted: string[] = [];
  let created = 0;

  return {
    calls,
    deleted,
    get created() { return created; },
    flow: {
      async getFlowFolders() {
        calls.push('list');
        if (over.failList) throw over.failList;
        return over.folders ?? {};
      },
      async createFlowFolder({ flowfolder }: { flowfolder: { name: string } }) {
        calls.push(`create:${flowfolder.name}`);
        if (over.failCreate) throw over.failCreate;
        created += 1;
        return over.createReturns !== undefined ? over.createReturns : { id: 'probe-1' };
      },
      async deleteFlowFolder({ id }: { id: string }) {
        calls.push(`delete:${id}`);
        if (over.failDelete) throw over.failDelete;
        deleted.push(id);
      },
    },
  };
}

const folder = (id: string, name: string, parent: string | null = null) => ({ id, name, parent });

describe('the probe proves a key can write', () => {
  test('it creates a folder and removes it again', async () => {
    const c = client();

    await flowWriteProbe(c as any);

    assert.deepEqual(c.calls, ['list', `create:${PROBE_NAME}`, 'delete:probe-1']);
    assert.deepEqual(c.deleted, ['probe-1']);
  });

  /**
   * A failed CREATE *is* the verdict, and is rethrown untouched so
   * `classifyCredentialError()` upstream can tell the three 401/403 failures
   * apart (platform §2) — they mean completely different things and send the
   * user to different fixes.
   */
  test('a failed create is the verdict, rethrown untouched', async () => {
    const c = client({ failCreate: new Error('403 Missing Scopes') });

    await assert.rejects(() => flowWriteProbe(c as any), /403 Missing Scopes/);
    assert.ok(!c.calls.some(call => call.startsWith('delete:')), 'nothing to clean up');
  });

  /**
   * A failed DELETE does not change the verdict. The key demonstrably wrote,
   * which is the entire question; it only leaves a folder behind, and says so.
   */
  test('a failed delete leaves the verdict alone and logs what it left', async () => {
    const logs: string[] = [];
    const c = client({ failDelete: new Error('folder is locked') });

    await flowWriteProbe(c as any, (...args) => logs.push(args.join(' ')));

    assert.ok(logs.some(line => /Left the permission-check folder behind/.test(line)));
  });

  /**
   * The delete is in a `finally`, which is why this function exists at all: it
   * was copy-pasted at four call sites and three had no `try/finally`, so a
   * validator that threw after the create left the folder in the user's Flow
   * list, named after a check that had already finished.
   */
  test('a folder that came back without an id still attempts the delete', async () => {
    const c = client({ createReturns: {} });

    await flowWriteProbe(c as any);

    assert.ok(c.calls.some(call => call.startsWith('delete:')), 'the finally ran');
  });
});

describe('the opening sweep is exact about what it deletes', () => {
  test('it removes a root-level probe folder an interrupted check left behind', async () => {
    const c = client({ folders: { a: folder('a', PROBE_NAME) } });
    const logs: string[] = [];

    await flowWriteProbe(c as any, (...args) => logs.push(args.join(' ')));

    assert.ok(c.deleted.includes('a'));
    assert.ok(logs.some(line => /left behind by an earlier check/.test(line)));
  });

  /**
   * The load-bearing half. This is the only place in the app that deletes a Flow
   * folder matched by a NAME rather than by something we minted, so anything but
   * an exact root-level match must survive — including the app's own folder, and
   * including a folder a user happened to name something similar.
   */
  test('it leaves everything else alone', async () => {
    const c = client({
      folders: {
        ours: folder('ours', 'Lightkeeper'),
        nested: folder('nested', PROBE_NAME, 'some-parent'),
        similar: folder('similar', 'Lightkeeper (checking permissions) — mine'),
        prefixed: folder('prefixed', ' Lightkeeper (checking permissions)'),
        unrelated: folder('unrelated', 'Evening'),
      },
    });

    await flowWriteProbe(c as any);

    // Only the probe's own folder, and it is the one the probe just created.
    assert.deepEqual(c.deleted, ['probe-1']);
  });

  test('a nested folder of the same name is never touched', async () => {
    // `parent === null` is the second half of the match: a user who filed
    // something under a folder of ours has put it somewhere of their own.
    const c = client({ folders: { n: folder('n', PROBE_NAME, 'root-id') } });

    await flowWriteProbe(c as any);

    assert.ok(!c.deleted.includes('n'));
  });

  test('several leaked folders are all removed', async () => {
    const c = client({
      folders: { a: folder('a', PROBE_NAME), b: folder('b', PROBE_NAME) },
    });

    await flowWriteProbe(c as any);

    assert.deepEqual(c.deleted.sort(), ['a', 'b', 'probe-1']);
  });

  /**
   * Best-effort in both directions: a Homey that refuses to list or delete
   * folders must not fail a key that can write them. The probe is the verdict;
   * the sweep is housekeeping.
   */
  test('a Homey that will not list folders does not fail the key', async () => {
    const c = client({ failList: new Error('cannot list') });

    await flowWriteProbe(c as any);

    assert.equal(c.created, 1, 'the probe still ran');
    assert.deepEqual(c.deleted, ['probe-1']);
  });

  test('a sweep delete that fails does not fail the key either', async () => {
    let first = true;
    const c = {
      deleted: [] as string[],
      flow: {
        async getFlowFolders() { return { a: folder('a', PROBE_NAME) }; },
        async createFlowFolder() { return { id: 'probe-1' }; },
        async deleteFlowFolder({ id }: { id: string }) {
          if (first) { first = false; throw new Error('refused'); }
          c.deleted.push(id);
        },
      },
    };

    await flowWriteProbe(c as any);

    assert.deepEqual(c.deleted, ['probe-1'], 'the probe was still created and cleaned up');
  });
});
