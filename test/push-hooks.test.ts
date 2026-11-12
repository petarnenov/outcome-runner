import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposeInvocation } from '../src/dispose.ts';
import { git } from '../src/git.ts';
import type { RunOptions } from '../src/runner.ts';
import { runnerFixture } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

/**
 * Installs a pre-push hook like a project's `make verify` guard: it logs every pushed ref and refuses a push whose
 * commit is not the checked-out HEAD, because its verification can only check the working tree. With `refuseTasks`
 * it also refuses every task branch, standing for a verification that fails.
 */
function installPrePushHook(f: RunnerFixture, { refuseTasks = false } = {}) {
  const hooks = join(f.base, 'hooks'); const log = join(f.base, 'pre-push.log');
  mkdirSync(hooks); writeFileSync(log, '');
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh
head=$(git rev-parse HEAD)
while read local_ref local_sha remote_ref remote_sha; do
  echo "$remote_ref" >> "${log}"
  if [ "$local_sha" != "$head" ]; then
    echo "pre-push: make verify checks only the checked-out commit; check out and push $remote_ref separately" >&2
    exit 1
  fi
  ${refuseTasks ? 'case "$remote_ref" in refs/heads/outcome/*) echo "pre-push: make verify failed" >&2; exit 1;; esac' : ''}
done
exit 0
`);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  git(f.root, 'config', 'core.hooksPath', hooks);
  return { pushed: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

const protectedMerge = (f: RunnerFixture): RunOptions => ({ host: { ...f.hostFor(), merge: () => { throw new Error('Protected merge'); } } });

// Grade C

test('C (required): the fixture hook refuses a push of a commit that is not the checked-out HEAD', t => {
  const f = runnerFixture(t, { ids: ['A'] }); installPrePushHook(f);
  const other = git(f.root, 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'not checked out');
  assert.throws(() => git(f.root, 'push', 'origin', `${other}:refs/heads/elsewhere`), /checks only the checked-out commit/u);
});

test('C (required): dispose removes the remote branch of unaccepted work although the hook refuses deletions', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one');
  assert.equal((await f.run(config, protectedMerge(f))).status, 'incomplete');
  const work = f.state('one').blocked.A.work;
  assert.notEqual(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
  const hook = installPrePushHook(f);
  await disposeInvocation(config, { removeWork: true, host: f.hostFor() });
  assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
  assert.deepEqual(hook.pushed(), []);
});

// Grade A

test('A (required): with a pre-push hook in the start checkout a run claims, merges and cleans up every task', { timeout: 300000 }, async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] }); const hook = installPrePushHook(f);
  const result = await f.run(f.config('one'));
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A', 'B']);
  assert.deepEqual(git(f.remote, 'ls-tree', '--name-only', 'refs/heads/work-queue-claims-main').split('\n').sort(), ['A.json', 'B.json']);
  // Tested task heads went through the hook; the claims ledger and branch deletions did not.
  const pushed = hook.pushed();
  assert.ok(pushed.length > 0 && pushed.every(ref => /^refs\/heads\/outcome\/[AB]-/u.test(ref)), pushed.join());
  assert.ok(['A', 'B'].every(id => pushed.some(ref => ref.startsWith(`refs/heads/outcome/${id}-`))), pushed.join());
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/outcome/'), '');
  assert.equal(f.state('one').completed.A.cleanup, undefined);
});

test('A (required): a task head the project hook refuses is not published and its task is blocked', { timeout: 300000 }, async t => {
  const f = runnerFixture(t, { ids: ['A'] }); installPrePushHook(f, { refuseTasks: true });
  const result = await f.run(f.config('one'));
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.match(f.state('one').blocked.A.reason, /make verify failed/u);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/outcome/'), '');
  assert.equal(f.records.length, 0);
  assert.ok(existsSync(f.state('one').blocked.A.work.path));
});
