import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, GitHubHost, MergeIneligible } from '../src/git.ts';
import type { CheckBucket, MergeEligibility } from '../src/git.ts';
import { classifyEligibility, releaseOnlyAdvance, MERGE_ELIGIBILITY_POLL_MS } from '../src/merge-eligibility.ts';
import type { MergeRetry, Project, PullRequest, Work } from '../src/model.ts';
import { explainUnfinished, TARGET_ATTEMPTS } from '../src/runner.ts';
import type { PullRequestHost, UnfinishedInput } from '../src/runner.ts';
import { formatStep } from '../src/step-log.ts';
import { hasBranch, runnerFixture } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

// Runner tests use runnerFixture (a bare origin, the start checkout and an integrator clone), scripted adapters and a
// scripted pull request host wrapped around f.hostFor('main') that reports a scripted eligibility or runs code before
// its merge; merge polling uses a fake delay that advances a fake clock passed as `now`. Target advances are commits
// pushed from the integrator clone. GitHubHost tests stub `gh`.

const MINUTE = 60 * 1000;
const WAIT = 30 * MINUTE;
/** A large eligibility poll interval keeps the 30-minute wait at a few views. */
const POLL = 5 * MINUTE;
const PREFIX = '[outcome-runner] 09:05:03 '.length;
const RETRY = 'A retry: origin/main advanced; integrating it again';
const INTEGRATED = 'A compare: comparing origin/main with the integrated target';
const RELEASE = (attempt: number) =>
  `origin/main advanced with a release commit; integrating it without using an attempt (attempt ${attempt})`;
/** The release retry line as written: with its time and task id it is longer than 120 characters and cut. */
const releaseLine = (attempt: number) => formatStep(new Date(0), 'A', 'retry', RELEASE(attempt)).slice(PREFIX);

const explainBlocked = (blocked: UnfinishedInput['blocked']) => explainUnfinished({ remaining: ['A'], ids: ['A'],
  tasks: [{ id: 'A', dependencies: [], scopes: ['src/a'] }], completed: {}, done: [], baselineDone: [],
  foreignClaims: [], statePath: '/state/state.json', blocked });

const eligibility = (status: string, ...checks: [string, CheckBucket][]): MergeEligibility =>
  ({ status, checks: checks.map(([name, bucket]) => ({ name, bucket })) });

/** Collects the step line bodies (the part after `[outcome-runner] HH:MM:SS `) of task A. */
function capture() {
  const lines: string[] = [];
  const steps = (line: string) => { lines.push(line.slice(PREFIX, -1)); };
  return { lines, steps, task: () => lines.filter(line => line.startsWith('A ')) };
}

/** A fake clock that only the fake merge polling delay advances. */
function clock(start = Date.parse('2026-11-13T09:00:00Z')) {
  let time = start;
  return { now: () => time, advance: (milliseconds: number) => { time += milliseconds; } };
}

interface Script {
  /** The eligibility of the `call`-th ready view; omitted for a host that reports none. */
  eligibility?: (call: number) => MergeEligibility;
  /** Runs before the scripted merge, like GitHubHost.merge before `gh pr merge`; it may advance, guard or throw. */
  beforeMerge?: (call: number, guard: () => void | Promise<void>) => Promise<void>;
}

/** The scripted host of the fixture with a scripted eligibility and code that runs before its merge. */
function scriptedHost(f: RunnerFixture, script: Script) {
  const inner = f.hostFor('main'); const heads: string[] = []; let views = 0; let delegated = 0;
  const host: PullRequestHost = {
    find: branch => inner.find(branch),
    create: (work, body) => inner.create(work, body),
    ...(script.eligibility ? { eligibility: () => script.eligibility!(++views) } : {}),
    async merge(pr, head, guard) {
      heads.push(head);
      assert.ok(guard, 'the runner passes a target guard');
      await script.beforeMerge?.(heads.length, guard);
      delegated += 1;
      return inner.merge(pr, head);
    },
  };
  return { host, heads, views: () => views, delegated: () => delegated };
}

/** Commits `files` on origin/main through the integrator clone and returns the new target commit. */
function commitOnTarget(f: RunnerFixture, files: Record<string, string>, subject: string): string {
  const clone = f.integrator;
  git(clone, 'fetch', '-q', 'origin'); git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true }); writeFileSync(join(clone, path), content);
  }
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', subject);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return git(clone, 'rev-parse', 'HEAD');
}

/** `package.json` and `package-lock.json` of `version` with the dependency `left` at `dependency`. */
const packageFiles = (version: string, dependency = '1.0.0'): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'fixture', version, private: true, dependencies: { left: dependency } }, null, 2) + '\n',
  'package-lock.json': JSON.stringify({ name: 'fixture', version, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', version, dependencies: { left: dependency } } } }, null, 2) + '\n',
});
const CHANGELOG = '# Changelog\n';
const withRelease = (changelog: string, version: string) =>
  changelog.replace(CHANGELOG, `${CHANGELOG}\n## ${version}\n\n- Release ${version}.\n`);

/** Adds the package files and the changelog to origin/main before a run. */
const addPackageFiles = (f: RunnerFixture) =>
  commitOnTarget(f, { ...packageFiles('0.0.1'), 'CHANGELOG.md': CHANGELOG }, 'test(fixture): add package files');

/** Pushes a release commit to origin/main that changes only the version fields and adds a changelog section. */
function releaseCommit(f: RunnerFixture, version: string): string {
  git(f.integrator, 'fetch', '-q', 'origin');
  const changelog = git(f.integrator, 'show', 'origin/main:CHANGELOG.md') + '\n';
  return commitOnTarget(f, { ...packageFiles(version), 'CHANGELOG.md': withRelease(changelog, version) },
    `chore(release): v${version}`);
}

/** The worktree, the local branch and the remote task branch of `work` still exist. */
function assertKept(f: RunnerFixture, work: Work) {
  assert.ok(existsSync(work.path)); assert.ok(hasBranch(f.root, work.branch));
  assert.notEqual(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
}
const hasReceipt = (f: RunnerFixture) => git(f.remote, 'ls-tree', 'main', 'evidence/results/A.json') !== '';
const retries = (work: Work) => (work.mergeRetries ?? []).map(({ reason, attempt }: MergeRetry) => [reason, attempt]);
const attemptOf = (line: string) => Number(/\(attempt (\d+)\)$/u.exec(line)?.[1] ?? 1);

/** A Git repository with one commit holding the package files, the changelog and a README. */
function releaseRepository(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'release-only-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  const commit = (files: Record<string, string>, subject: string): string => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', subject);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = commit({ ...packageFiles('0.0.1'), 'CHANGELOG.md': CHANGELOG, 'README.md': '# Fixture\n' }, 'test: base');
  return { dir, base, commit, branch: (name: string) => git(dir, 'checkout', '-q', '-B', name, base) };
}

// Grade E

test('E (required): classifyEligibility classifies merge statuses and required checks', () => {
  const rows: [MergeEligibility, string, string[]][] = [
    [eligibility('CLEAN'), 'eligible', []],
    [eligibility('BEHIND'), 'behind', []],
    [eligibility('BLOCKED', ['lint', 'pass'], ['build', 'fail']), 'failed', ['build']],
    [eligibility('UNSTABLE', ['deploy', 'cancel'], ['build', 'pending']), 'failed', ['deploy']],
    [eligibility('BLOCKED', ['test', 'pending'], ['lint', 'pass'], ['build', 'pending']), 'pending', ['build', 'test']],
    [eligibility('UNSTABLE', ['build', 'pending']), 'pending', ['build']],
    [eligibility('UNKNOWN', ['build', 'pending']), 'pending', ['build']],
    [eligibility('UNKNOWN'), 'pending', []],
    [eligibility('BLOCKED', ['lint', 'pass'], ['docs', 'skipping']), 'refused', []],
    [eligibility('UNSTABLE', ['lint', 'pass']), 'refused', []],
    [eligibility('DIRTY'), 'refused', []],
    [eligibility('DIRTY', ['build', 'fail']), 'refused', []],
    [eligibility('DRAFT'), 'refused', []],
  ];
  for (const [input, kind, checks] of rows) {
    assert.deepEqual(classifyEligibility(input), { kind, checks }, JSON.stringify(input));
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

// Grade D

test('D (required): releaseOnlyAdvance accepts only release commits that change version fields and the changelog', t => {
  const repo = releaseRepository(t);
  const release = repo.commit({ ...packageFiles('0.0.2'), 'CHANGELOG.md': withRelease(CHANGELOG, '0.0.2') },
    'chore(release): v0.0.2');
  assert.equal(releaseOnlyAdvance(repo.dir, repo.base, release), true);
  assert.equal(releaseOnlyAdvance(repo.dir, release, release), false, 'from equals to');
  assert.equal(releaseOnlyAdvance(repo.dir, release, repo.base), false, 'from is not an ancestor of to');
  repo.branch('dependency');
  const dependency = repo.commit(packageFiles('0.0.2', '2.0.0'), 'chore(release): v0.0.2');
  assert.equal(releaseOnlyAdvance(repo.dir, repo.base, dependency), false, 'a dependency change');
  repo.branch('subject');
  const subject = repo.commit(packageFiles('0.0.2'), 'chore: bump the version');
  assert.equal(releaseOnlyAdvance(repo.dir, repo.base, subject), false, 'not a release subject');
  repo.branch('other-file');
  const other = repo.commit({ ...packageFiles('0.0.2'), 'README.md': '# Changed\n' }, 'chore(release): v0.0.2');
  assert.equal(releaseOnlyAdvance(repo.dir, repo.base, other), false, 'another file changes');
  repo.branch('side');
  repo.commit(packageFiles('0.0.2'), 'chore(release): v0.0.2');
  repo.branch('merged');
  git(repo.dir, 'merge', '-q', '--no-ff', 'side', '-m', 'chore(release): v0.0.2');
  assert.equal(releaseOnlyAdvance(repo.dir, repo.base, git(repo.dir, 'rev-parse', 'HEAD')), false, 'a merge commit');
});

test('D (required): GitHubHost reports eligibility and refuses a status-only merge with MergeIneligible', async () => {
  const head = 'a'.repeat(40); const pr = { number: 7, branch: 'topic' } as PullRequest;
  const stub = (status: string, checks: (args: string[]) => string) => {
    const calls: string[][] = [];
    const host = new GitHubHost('.', { repository: 'fixture', target: 'main' } as Project, undefined,
      { views: 3, delay: async () => {} });
    host.gh = (...args) => {
      calls.push(args);
      if (args[1] === 'checks') return checks(args);
      if (args[1] === 'merge') return '';
      assert.equal(args[1], 'view');
      return JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'topic', baseRefName: 'main', isDraft: false,
        mergeStateStatus: status });
    };
    return { host, calls };
  };
  const clean = stub('CLEAN', () => assert.fail('a CLEAN view reads no checks'));
  assert.deepEqual(await clean.host.eligibility(pr, head), { status: 'CLEAN', checks: [] });
  assert.ok(!clean.calls.some(args => args[1] === 'checks'));
  const printed = [{ name: 'build', bucket: 'pending' }, { name: 'lint', bucket: 'pass' }];
  const blocked = stub('BLOCKED', args => {
    assert.deepEqual(args, ['pr', 'checks', '7', '--required', '--json', 'name,bucket']);
    throw Object.assign(new Error('gh exited with 8'), { stdout: `${JSON.stringify(printed)}\n` });
  });
  assert.deepEqual(await blocked.host.eligibility(pr, head), { status: 'BLOCKED', checks: printed });
  const behind = stub('BEHIND', () => '[]'); let guarded = false;
  const error = await behind.host.merge(pr, head, () => { guarded = true; }).then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof MergeIneligible);
  assert.equal(error.status, 'BEHIND');
  assert.equal(error.message, 'PR protection or identity blocks merge (BEHIND)');
  assert.deepEqual(error.checks, []);
  assert.equal(guarded, false);
  assert.ok(!behind.calls.some(args => args[1] === 'merge'));
});

// Grade C

test('C (required): a failed required check blocks at once with merge-not-eligible', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const delays: number[] = [];
  const s = scriptedHost(f, { eligibility: () => eligibility('BLOCKED', ['lint', 'pass'], ['build', 'fail']) });
  const result = await f.run(f.config('one'), { host: s.host, mergePolling: { delay: async ms => { delays.push(ms); } } });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const blocked = f.state('one').blocked.A;
  assert.equal(blocked.reason, 'merge-not-eligible');
  assert.deepEqual(blocked.eligibility, { status: 'BLOCKED', checks: ['build'] });
  assert.equal(blocked.work.stage, 'merge'); assert.equal(blocked.work.mergeWait, undefined);
  assert.deepEqual(result.blockers!.A, { kind: 'blocked', stage: 'merge', reason: 'merge-not-eligible',
    diagnostics: result.blockers!.A.diagnostics, status: 'BLOCKED', checks: ['build'] });
  assert.equal(s.views(), 1); assert.deepEqual(delays, []); assert.equal(s.heads.length, 0);
  assert.ok(!hasReceipt(f));
  assertKept(f, blocked.work);
});

test('C (required): statuses that waiting cannot fix block at once with merge-not-eligible', async t => {
  for (const input of [eligibility('BLOCKED', ['lint', 'pass']), eligibility('DIRTY')]) {
    const f = runnerFixture(t, { ids: ['A'] }); const delays: number[] = [];
    const s = scriptedHost(f, { eligibility: () => input });
    const result = await f.run(f.config('one'), { host: s.host, mergePolling: { delay: async ms => { delays.push(ms); } } });
    assert.equal(result.status, 'incomplete', JSON.stringify(result));
    const state = f.state('one'); const blocked = state.blocked.A;
    assert.equal(blocked.reason, 'merge-not-eligible', input.status);
    assert.deepEqual(blocked.eligibility, { status: input.status, checks: [] });
    assert.deepEqual(result.blockers!.A, { kind: 'blocked', stage: 'merge', reason: 'merge-not-eligible',
      diagnostics: result.blockers!.A.diagnostics, status: input.status, checks: [] });
    assert.deepEqual(delays, []); assert.equal(s.heads.length, 0);
    assert.ok(!JSON.stringify(state).includes('operation-incomplete'));
    assert.ok(!JSON.stringify(result).includes('operation-incomplete'));
    assertKept(f, blocked.work);
  }
});

test('C (required): a merge refused after an eligible read blocks with merge-not-eligible', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const delays: number[] = [];
  const s = scriptedHost(f, { eligibility: () => eligibility('CLEAN'),
    beforeMerge: async () => { throw new MergeIneligible('DIRTY', []); } });
  const result = await f.run(f.config('one'), { host: s.host, mergePolling: { delay: async ms => { delays.push(ms); } } });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const state = f.state('one'); const blocked = state.blocked.A;
  assert.equal(blocked.reason, 'merge-not-eligible');
  assert.deepEqual(blocked.eligibility, { status: 'DIRTY', checks: [] });
  assert.deepEqual(result.blockers!.A, { kind: 'blocked', stage: 'merge', reason: 'merge-not-eligible',
    diagnostics: result.blockers!.A.diagnostics, status: 'DIRTY', checks: [] });
  assert.equal(s.heads.length, 1); assert.equal(s.delegated(), 0); assert.deepEqual(delays, []);
  assert.ok(!JSON.stringify(state).includes('operation-incomplete'));
  assert.ok(!JSON.stringify(result).includes('operation-incomplete'));
  assertKept(f, blocked.work);
});

test('C (required): pending required checks are waited for quietly and the pull request merges once CLEAN', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); const delays: number[] = []; const snapshots: string[] = [];
  const s = scriptedHost(f, { eligibility: call => call <= 2 ?
    eligibility('BLOCKED', ['build', 'pending'], ['lint', 'pass']) : eligibility('CLEAN') });
  // Everything a check, push or pull request creation would change during the wait.
  const snapshot = () => {
    const current = f.state('one').current as Work;
    return JSON.stringify({ refs: git(f.remote, 'show-ref'), head: git(current.path, 'rev-parse', 'HEAD'),
      checks: current.finalChecks, prs: f.records.length });
  };
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host, mergePolling: { delay: async ms => {
    delays.push(ms); snapshots.push(snapshot());
  } } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(delays, [MERGE_ELIGIBILITY_POLL_MS, MERGE_ELIGIBILITY_POLL_MS]);
  assert.equal(new Set(snapshots).size, 1);
  const task = out.task();
  const waitLine = 'A wait: waiting for required checks of #1 (BLOCKED)';
  assert.equal(task.filter(line => line === waitLine).length, 1);
  const wait = task.indexOf(waitLine); const merge = task.indexOf('A merge: merging #1');
  assert.ok(wait > 0 && wait < merge, task.join('\n'));
  assert.ok(!task.slice(wait, merge).some(line => /^A (check|push|pull request|commit|setup):/u.test(line)), task.join('\n'));
  assert.equal(f.records.length, 1); assert.equal(s.heads.length, 1); assert.equal(s.delegated(), 1);
  const completed = f.state('one').completed.A as Work;
  assert.deepEqual(completed.mergeRetries!.map(({ reason, attempt, status, checks }) => ({ reason, attempt, status, checks })),
    [{ reason: 'checks-pending', attempt: 1, status: 'BLOCKED', checks: ['build'] }]);
  assert.equal(completed.mergeWait, undefined);
  assert.ok(hasReceipt(f));
});

test('C (required): checks pending for 30 minutes block with merge-not-eligible and the pending checks', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const c = clock(); const times: number[] = [];
  const s = scriptedHost(f, { eligibility: () => { times.push(c.now()); return eligibility('UNSTABLE', ['build', 'pending']); } });
  const result = await f.run(f.config('one'), { host: s.host, now: c.now,
    mergePolling: { eligibilityPollMs: POLL, delay: async ms => { assert.equal(ms, POLL); c.advance(ms); } } });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const first = times[0];
  assert.ok(times.at(-2)! - first < WAIT, 'the last view before blocking is under 30 minutes after the first');
  assert.ok(times.at(-1)! - first >= WAIT, 'the blocking view is at least 30 minutes after the first');
  assert.equal(times.length, WAIT / POLL + 1);
  const blocked = f.state('one').blocked.A;
  assert.equal(blocked.reason, 'merge-not-eligible');
  assert.deepEqual(blocked.eligibility, { status: 'UNSTABLE', checks: ['build'] });
  assert.equal(blocked.work.mergeWait, undefined);
  assert.deepEqual(result.blockers!.A, { kind: 'blocked', stage: 'merge', reason: 'merge-not-eligible',
    diagnostics: result.blockers!.A.diagnostics, status: 'UNSTABLE', checks: ['build'] });
  assert.equal(s.heads.length, 0); assert.ok(!hasReceipt(f));
  assertKept(f, blocked.work);
});

// Grade B

test('B (required): a BEHIND pull request catches up with the target and merges', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture();
  const s = scriptedHost(f, { eligibility: call => call === 1 ? eligibility('BEHIND') : eligibility('CLEAN') });
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const task = out.task();
  const retry = task.indexOf('A retry: #1 is behind origin/main; catching up (attempt 2)');
  assert.ok(retry > 0, task.join('\n'));
  assert.equal(task[retry - 1], 'A compare: comparing origin/main with the checked target');
  assert.equal(task[retry + 1], `${INTEGRATED} (attempt 2)`);
  const check = task.indexOf('A check: running 1/2: node (attempt 2)');
  const push = task.indexOf('A push: pushing the tested head (attempt 2)');
  const merge = task.indexOf('A merge: merging #1 (attempt 2)');
  assert.ok(retry < check && check < push && push < merge, task.join('\n'));
  const completed = f.state('one').completed.A as Work;
  assert.deepEqual(retries(completed), [['behind', 2]]);
  assert.equal(completed.mergeRetries![0].status, 'BEHIND');
  assert.equal(completed.targetAttempts, 1);
  assert.equal(s.views(), 2); assert.equal(s.delegated(), 1);
  assert.ok(!JSON.stringify(f.state('one')).includes('operation-incomplete'));
  assert.ok(hasReceipt(f));
});

test('B (required): a BEHIND merge refusal after a target advance integrates the advance and merges', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); let target = '';
  const s = scriptedHost(f, { beforeMerge: async call => {
    if (call !== 1) return;
    target = commitOnTarget(f, { 'docs/other.md': '# Other\n' }, 'test(fixture): advance docs/other.md');
    throw new MergeIneligible('BEHIND', []);
  } });
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(s.heads.length, 2); assert.notEqual(s.heads[0], s.heads[1]); assert.equal(s.delegated(), 1);
  assert.ok(out.task().includes(`${RETRY} (attempt 2)`));
  assert.ok(out.task().includes('A integrate: integrating the advanced main (attempt 2)'));
  const completed = f.state('one').completed.A as Work;
  assert.deepEqual(retries(completed), [['target-advanced', 2]]);
  assert.equal(completed.integratedTargets!.at(-1), target);
  assert.equal(git(f.remote, 'show', 'main:docs/other.md'), '# Other');
  assert.ok(hasReceipt(f));
});

test('B (required): a release-only advance is integrated without using an attempt', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); addPackageFiles(f); const out = capture(); let release = '';
  const s = scriptedHost(f, { beforeMerge: async (call, guard) => {
    if (call !== 1) return;
    release = releaseCommit(f, '0.0.2');
    await guard();
  } });
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const task = out.task();
  const retry = task.indexOf(releaseLine(1));
  assert.ok(retry > 0, task.join('\n'));
  assert.equal(task[retry - 1], 'A compare: comparing origin/main with the checked target');
  assert.ok(!task.some(line => line.startsWith(RETRY)));
  // The publish pass after the release-only retry keeps attempt 1, so its lines carry no attempt suffix.
  assert.equal(task[retry + 1], INTEGRATED);
  assert.equal(task[retry + 2], 'A integrate: integrating the advanced main');
  const completed = f.state('one').completed.A as Work;
  assert.ok(!completed.targetAttempts);
  assert.deepEqual(retries(completed), [['release-commit', 1]]);
  assert.equal(completed.mergeRetries![0].target, release);
  assert.equal(s.heads.length, 2); assert.equal(s.delegated(), 1);
  git(f.root, 'fetch', '-q', 'origin');
  git(f.root, 'merge-base', '--is-ancestor', release, 'origin/main');
  assert.equal(JSON.parse(git(f.root, 'show', 'origin/main:package.json')).version, '0.0.2');
  assert.ok(hasReceipt(f));
});

test('B (required): release-only retries never raise the attempt and the tenth counted attempt blocks', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); addPackageFiles(f); const out = capture(); let releases = 0;
  const s = scriptedHost(f, { beforeMerge: async (call, guard) => {
    if (call % 2 === 1) { releases += 1; releaseCommit(f, `0.0.${releases + 1}`); }
    else commitOnTarget(f, { [`docs/other-${call}.md`]: `# ${call}\n` }, `test(fixture): advance docs/other-${call}.md`);
    await guard();
  } });
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.A.reason, 'target-keeps-advancing');
  assert.equal(releases, TARGET_ATTEMPTS);
  assert.equal(s.heads.length, TARGET_ATTEMPTS + releases); assert.equal(s.delegated(), 0);
  assert.equal(f.records[0].state, 'OPEN'); assert.ok(!hasReceipt(f));
  const task = out.task();
  assert.deepEqual(task.filter(line => line.startsWith(RETRY)),
    Array.from({ length: TARGET_ATTEMPTS - 1 }, (_, index) => `${RETRY} (attempt ${index + 2})`));
  const releaseIndexes = task.flatMap((line, index) => line === releaseLine(1) ? [index] : []);
  assert.equal(releaseIndexes.length, releases);
  const attempts: number[] = [];
  for (const index of releaseIndexes) {
    const publish = task.slice(0, index).findLast(line => line.startsWith(INTEGRATED))!;
    const attempt = attemptOf(publish); attempts.push(attempt);
    const next = task.slice(index + 1).find(line => line.startsWith(RETRY));
    if (next) assert.equal(next, `${RETRY} (attempt ${attempt + 1})`);
  }
  assert.deepEqual(attempts, Array.from({ length: releases }, (_, index) => index + 1));
  assert.deepEqual(task.slice(-2), [`A compare: comparing origin/main with the checked target (attempt ${TARGET_ATTEMPTS})`,
    'A blocked: stopped at compare']);
  const blocked = f.state('one').blocked.A;
  assert.equal(blocked.reason, 'target-keeps-advancing'); assert.equal(blocked.work.targetAttempts, 0);
  const expected: [string, number][] = [];
  for (let attempt = 1; attempt <= TARGET_ATTEMPTS; attempt += 1) {
    if (attempt > 1) expected.push(['target-advanced', attempt]);
    expected.push(['release-commit', attempt]);
  }
  assert.deepEqual(retries(blocked.work), expected);
  assertKept(f, blocked.work);
});

// Grade A

test('A (required): a restart after a recorded BEHIND retry resumes at the recorded attempt', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const controller = new AbortController();
  const s = scriptedHost(f, { eligibility: call => call === 1 ? eligibility('BEHIND') : eligibility('CLEAN') });
  const cancelled = await f.run(f.config('one'), { host: s.host, signal: controller.signal,
    afterEffect: async operation => { if (operation === 'retry') controller.abort(); } });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  const current = f.state('one').current as Work;
  assert.equal(current.targetAttempts, 1); assert.equal(current.stage, 'publish');
  assert.deepEqual(retries(current), [['behind', 2]]);
  const out = capture();
  const result = await f.run(f.config('one'), { steps: out.steps, host: s.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.match(out.task()[0], /^A compare: (resuming )?comparing origin\/main with the integrated target \(attempt 2\)$/u);
  assert.ok(!out.task().some(line => line.startsWith('A retry:')));
  const completed = f.state('one').completed.A as Work;
  assert.deepEqual(retries(completed), [['behind', 2]]);
  assert.equal(completed.targetAttempts, 1);
  assert.equal(s.views(), 2); assert.ok(hasReceipt(f));
});

test('A (required): a restart during the eligibility wait keeps its start and blocks 30 minutes after it', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const c = clock(); const controller = new AbortController();
  const times: number[] = [];
  const s = scriptedHost(f, { eligibility: () => { times.push(c.now()); return eligibility('BLOCKED', ['build', 'pending']); } });
  const polling = (cancel: boolean) => ({ eligibilityPollMs: POLL, delay: async (ms: number) => {
    c.advance(ms); if (cancel) controller.abort();
  } });
  const cancelled = await f.run(f.config('one'), { host: s.host, now: c.now, signal: controller.signal,
    mergePolling: polling(true) });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  const wait = (f.state('one').current as Work).mergeWait!;
  assert.ok(wait);
  const since = Date.parse(wait.since);
  assert.equal(since, times[0]); assert.equal(wait.views, 1); assert.equal(wait.status, 'BLOCKED');
  times.length = 0;
  const result = await f.run(f.config('one'), { host: s.host, now: c.now, mergePolling: polling(false) });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.ok(times[0] > since);
  assert.ok(times.at(-2)! - since < WAIT, 'the rerun does not block before 30 minutes after the recorded start');
  assert.ok(times.at(-1)! - since >= WAIT, 'the rerun blocks once 30 minutes have passed since the recorded start');
  assert.equal(times.at(-1)! - since, WAIT);
  const blocked = f.state('one').blocked.A;
  assert.equal(blocked.reason, 'merge-not-eligible');
  assert.deepEqual(blocked.eligibility, { status: 'BLOCKED', checks: ['build'] });
  assert.deepEqual(retries(blocked.work), [['checks-pending', 1]]);
  assert.equal(s.heads.length, 0); assert.ok(!hasReceipt(f));
});
