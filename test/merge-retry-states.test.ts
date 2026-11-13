import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEligibility } from '../src/merge-eligibility.ts';
import { explainUnfinished } from '../src/runner.ts';
import type { UnfinishedInput } from '../src/runner.ts';

// Runner tests use runnerFixture (a bare origin, the start checkout and an integrator clone), scripted adapters and a
// scripted pull request host wrapped around f.hostFor('main') that reports a scripted eligibility or refuses the
// merge; merge polling uses a fake delay that advances a fake clock passed as `now`. GitHubHost tests stub `gh`.

const explainBlocked = (blocked: UnfinishedInput['blocked']) => explainUnfinished({ remaining: ['A'], ids: ['A'],
  tasks: [{ id: 'A', dependencies: [], scopes: ['src/a'] }], completed: {}, done: [], baselineDone: [],
  foreignClaims: [], statePath: '/state/state.json', blocked });

// Grade E

test('E (required): classifyEligibility classifies merge statuses and required checks', () => {
  const rows: [string, { name: string; bucket: string }[], string, string[]][] = [
    ['CLEAN', [], 'eligible', []],
    ['BEHIND', [], 'behind', []],
    ['BLOCKED', [{ name: 'lint', bucket: 'pass' }, { name: 'build', bucket: 'fail' }], 'failed', ['build']],
    ['UNSTABLE', [{ name: 'deploy', bucket: 'cancel' }, { name: 'build', bucket: 'pending' }], 'failed', ['deploy']],
    ['BLOCKED', [{ name: 'test', bucket: 'pending' }, { name: 'lint', bucket: 'pass' }, { name: 'build', bucket: 'pending' }],
      'pending', ['build', 'test']],
    ['UNSTABLE', [{ name: 'build', bucket: 'pending' }], 'pending', ['build']],
    ['UNKNOWN', [{ name: 'build', bucket: 'pending' }], 'pending', ['build']],
    ['UNKNOWN', [], 'pending', []],
    ['BLOCKED', [{ name: 'lint', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }], 'refused', []],
    ['UNSTABLE', [{ name: 'lint', bucket: 'pass' }], 'refused', []],
    ['DIRTY', [], 'refused', []],
    ['DIRTY', [{ name: 'build', bucket: 'fail' }], 'refused', []],
    ['DRAFT', [], 'refused', []],
  ];
  for (const [status, checks, kind, names] of rows) {
    assert.deepEqual(classifyEligibility({ status, checks: checks as never }), { kind, checks: names },
      `${status} ${JSON.stringify(checks)}`);
  }
});

test('E (required): merge-not-eligible is explained with its status and checks; other reasons are unchanged', () => {
  const blockers = explainBlocked({ A: { reason: 'merge-not-eligible', eligibility: { status: 'BLOCKED', checks: ['build'] },
    work: { stage: 'merge', scopes: ['src/a'] } } });
  assert.deepEqual(blockers.A, { kind: 'blocked', stage: 'merge', reason: 'merge-not-eligible',
    diagnostics: '/state/state.json', status: 'BLOCKED', checks: ['build'] });
  for (const [reason, expected] of [['target-keeps-advancing', 'target-keeps-advancing'],
    ['PR protection or identity blocks merge (DIRTY)', 'operation-incomplete'], ['Worker plan incomplete', 'operation-incomplete']]) {
    const other = explainBlocked({ A: { reason, work: { stage: 'merge', scopes: ['src/a'] } } });
    assert.deepEqual(other.A, { kind: 'blocked', stage: 'merge', reason: expected, diagnostics: '/state/state.json' });
  }
});

test('E (required): README describes merge eligibility retries, merge-not-eligible and the release-commit exception', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('## When the target advances during a run');
  assert.ok(start >= 0);
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  for (const text of ['BEHIND', 'pending required checks', '30 minutes', 'merge-not-eligible', 'release commit',
    'do not count toward the attempt limit', '| `merge-not-eligible` |']) assert.ok(section.includes(text), text);
  const unfinished = readme.slice(readme.indexOf('### Unfinished results'), readme.indexOf('### Review and check budgets'));
  assert.match(unfinished, /^\| `blocked` \|.*`merge-not-eligible`/mu);
  const steps = readme.slice(readme.indexOf('## Step lines'), readme.indexOf('## Mascot'));
  for (const text of ['is behind origin/<target>; catching', 'advanced with a release commit; integrating it without using an',
    'wait: waiting for required checks of #<number> (<status>)']) assert.ok(steps.includes(text), text);
});
