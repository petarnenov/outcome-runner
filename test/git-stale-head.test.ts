import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, GitHubHost } from '../src/git.ts';
import type { Project, PullRequest } from '../src/model.ts';

for (const scenario of ['converges', 'final', 'exhausts', 'foreign', 'moves', 'missing',
  'read-failure', 'mixed', 'shared-exhaustion', 'unknown-foreign', 'fallback-branch'] as const) {
  test(`GitHubHost stale head: ${scenario}`, async t => {
    const base = mkdtempSync(join(tmpdir(), 'stale-host-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'root'); const origin = join(base, 'origin.git');
    mkdirSync(root); git(base, 'init', '--bare', origin); git(root, 'init', '-b', 'topic');
    git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'commit', '--allow-empty', '-m', 'old');
    const old = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '--allow-empty', '-m', 'tested');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'remote', 'add', 'origin', origin); git(root, 'push', 'origin', 'HEAD:refs/heads/topic');
    if (scenario === 'foreign' || scenario === 'unknown-foreign') git(origin, 'update-ref', 'refs/heads/topic', old);
    if (scenario === 'missing') git(origin, 'update-ref', '-d', 'refs/heads/topic');
    if (scenario === 'read-failure') git(root, 'remote', 'set-url', 'origin', join(base, 'absent.git'));
    const calls: string[][] = []; const delays: number[] = []; let views = 0;
    const initialRefs = git(origin, 'show-ref');
    const host = new GitHubHost(root, { repository: 'fixture', target: 'main' } as Project, undefined,
      { views: 5, delay: async ms => {
        delays.push(ms);
        assert.equal(git(root, 'rev-parse', 'HEAD'), head);
        assert.equal(git(root, 'status', '--porcelain'), '');
        if (scenario === 'moves') git(origin, 'update-ref', 'refs/heads/topic', old);
        else assert.equal(git(origin, 'show-ref'), initialRefs);
      } });
    host.gh = (...args) => {
      calls.push(args);
      if (args[1] === 'merge') return '';
      assert.equal(args[1], 'view'); views += 1;
      const convergeAt = scenario === 'final' ? 5 : scenario === 'mixed' ? 3 : 4;
      const stale = scenario === 'exhausts' || views < convergeAt;
      const unknown = scenario === 'unknown-foreign' || scenario === 'shared-exhaustion' ||
        scenario === 'mixed' && views <= 3;
      return JSON.stringify({ state: 'OPEN', headRefOid: stale ? old : head, headRefName: 'topic',
        baseRefName: 'main', isDraft: false, mergeStateStatus: unknown ? 'UNKNOWN' : 'CLEAN' });
    };
    const pr = { number: 7, branch: scenario === 'fallback-branch' ? undefined : 'topic' } as PullRequest;
    const success = ['converges', 'final', 'mixed', 'fallback-branch'].includes(scenario);
    if (success) await host.merge(pr, head);
    else await assert.rejects(host.merge(pr, head),
      scenario === 'read-failure' ? /git/u : scenario === 'shared-exhaustion' ? /UNKNOWN/u : /^Error: Checked head or target changed$/u);
    const merges = calls.filter(args => args[1] === 'merge');
    assert.equal(merges.length, success ? 1 : 0);
    if (success) assert.deepEqual(merges[0], ['pr', 'merge', '7', '--merge', '--match-head-commit', head]);
    assert.ok(delays.every(ms => ms === 3000));
    assert.equal(delays.length, views - 1);
    assert.ok(calls.every(args => args[1] === 'view' || args[1] === 'merge'));
    if (['final', 'exhausts', 'shared-exhaustion'].includes(scenario)) assert.equal(views, 5);
    if (['foreign', 'missing', 'read-failure', 'unknown-foreign'].includes(scenario)) assert.equal(views, 1);
    if (scenario === 'moves') assert.equal(views, 2);
    if (scenario === 'mixed') assert.equal(views, 4);
  });
}
