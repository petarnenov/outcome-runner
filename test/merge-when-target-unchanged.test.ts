import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, GitHubHost } from '../src/git.ts';
import type { Project, PullRequest, Work } from '../src/model.ts';
import { TARGET_ATTEMPTS, conflictMarkers, explainUnfinished } from '../src/runner.ts';
import type { PullRequestHost } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { RESULT_TEST, checkoutState, hasBranch, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

// Runs use runnerFixture (a bare origin, the start checkout and an integrator clone), scripted adapters and the
// scripted pull request host, wrapped where a test needs the merge guard. The target advances by committing in the
// integrator clone and pushing origin/main.

const RESOLVED = 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n' +
  '// Resolved with the advanced target.\n';
const FOREIGN = 'export function next(n) { return n + 1; }\n';
const CHECKED = 'A compare: comparing origin/main with the checked target';
const INTEGRATED = 'A compare: comparing origin/main with the integrated target';
const RETRY = 'A retry: origin/main advanced; integrating it again';
const isResolution = (prompt: string) => prompt.includes('Resolve the merge conflicts');

/** Collects the step line bodies (the part after `[outcome-runner] HH:MM:SS `) of task A. */
function capture() {
  const lines: string[] = [];
  const steps = (line: string) => { lines.push(line.slice('[outcome-runner] 09:05:03 '.length, -1)); };
  return { lines, steps, task: () => lines.filter(line => line.startsWith('A ')) };
}

/** Commits `content` at `path` on origin/main through the integrator clone and returns the new target commit. */
function advance(f: RunnerFixture, path: string, content = `# ${path}\n`): string {
  const clone = f.integrator;
  git(clone, 'fetch', '-q', 'origin'); git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');
  mkdirSync(dirname(join(clone, path)), { recursive: true }); writeFileSync(join(clone, path), content);
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', `test(fixture): advance ${path}`);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return git(clone, 'rev-parse', 'HEAD');
}

/** The scripted worker plus a conflict resolution session that writes RESOLVED, or fails when `fail` is set. */
function worker(prompts: string[] = [], fail = false) {
  const scripted = scriptedWorker();
  return (options: HarnessOptions): HarnessAdapter => {
    const inner = scripted(options);
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
    return { ...inner, async startAction(prompt: string) {
      prompts.push(prompt);
      if (!isResolution(prompt)) return inner.startAction(prompt);
      if (fail) throw new Error('Scripted resolution failure');
      const before = await call('backlog_tool', { operation: 'read_file', input: { path: 'src/a/result.mjs' } } as ToolInput);
      assert.ok(conflictMarkers(before.content));
      await call('backlog_tool', { operation: 'write_file',
        input: { path: 'src/a/result.mjs', content: RESOLVED, expectedHash: before.hash } } as ToolInput);
      await call('outcome_report', { outcome: 'ready', summary: 'Resolved', findings: [] } as ToolInput);
      return { threadId: 'fixture', events: [], text: '' } as unknown as WorkerReply;
    } };
  };
}

/**
 * The scripted host whose `merge` first runs `before`, which may advance the target and call the guard like
 * `GitHubHost.merge` does right before `gh pr merge`; only then does it delegate to the scripted merge.
 */
function guardedHost(f: RunnerFixture, before: (call: number, guard: () => void | Promise<void>) => Promise<void>) {
  const scripted = f.hostFor('main'); const heads: string[] = []; let delegated = 0;
  const host: PullRequestHost = {
    find: branch => scripted.find(branch),
    create: (work, body) => scripted.create(work, body),
    async merge(pr, head, guard) {
      heads.push(head);
      assert.ok(guard, 'the runner passes a target guard');
      await before(heads.length, guard);
      delegated += 1;
      return scripted.merge(pr, head);
    },
  };
  return { host, heads, delegated: () => delegated };
}

const sessions = (work: Work, purpose: string) => (work.sessions ?? []).filter(item => item.purpose === purpose).length;
/** The merge commits of origin/main (after a fetch in the start checkout) whose second parent is `commit`. */
function mergesOf(f: RunnerFixture, commit: string): string[] {
  git(f.root, 'fetch', '-q', 'origin');
  return git(f.root, 'rev-list', '--merges', '--parents', 'origin/main').split('\n').filter(Boolean)
    .filter(line => line.split(' ')[2] === commit);
}
const hasReceipt = (f: RunnerFixture) => git(f.remote, 'ls-tree', 'main', 'evidence/results/A.json') !== '';

// Grade E

test('E (required): target-keeps-advancing is explained as a blocked reason without paths and the limit is 10', () => {
  const blockers = explainUnfinished({ remaining: ['A'], ids: ['A'], tasks: [{ id: 'A', dependencies: [], scopes: ['src/a'] }],
    completed: {}, done: [], baselineDone: [], foreignClaims: [], statePath: '/state/state.json',
    blocked: { A: { reason: 'target-keeps-advancing', work: { stage: 'publish', scopes: ['src/a'] } } } });
  assert.deepEqual(blockers.A, { kind: 'blocked', stage: 'publish', reason: 'target-keeps-advancing',
    diagnostics: '/state/state.json' });
  assert.equal(blockers.A.paths, undefined);
  assert.equal(TARGET_ATTEMPTS, 10);
});

test('E (required): no source file produces Target changed outcome scope', () => {
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  assert.ok(files.length > 10);
  for (const entry of files) {
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    assert.ok(!text.includes('Target changed outcome scope'), entry.name);
  }
});

test('E (required): README explains how the runner integrates an advanced target', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /(?:do not|don't|avoid) merg/iu);
  const start = readme.indexOf('## When the target advances during a run');
  assert.ok(start >= 0);
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  for (const text of ['Owners may merge', 'inside a running task\'s scopes', 'task worktree', 'product checks',
    'implementation review', 'immediately before merging', '--match-head-commit', '10 attempts',
    'target-keeps-advancing']) assert.ok(section.includes(text), text);
});

// Grade D

test('D (required): GitHubHost.merge calls the guard after the settled view and right before gh pr merge', async t => {
  const base = mkdtempSync(join(tmpdir(), 'guard-host-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  for (const throwing of [false, true]) {
    const events: string[] = [];
    const host = new GitHubHost(base, { repository: 'fixture', target: 'main' } as Project, undefined,
      { views: 3, delay: async () => {} });
    host.gh = (...args) => {
      events.push(`gh ${args[1]}`);
      if (args[1] === 'merge') {
        assert.deepEqual(args, ['pr', 'merge', '7', '--merge', '--match-head-commit', head]);
        return '';
      }
      return JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'topic', baseRefName: 'main', isDraft: false,
        mergeStateStatus: 'CLEAN' });
    };
    const guard = () => { events.push('guard'); if (throwing) throw new Error('advanced'); };
    const merged = host.merge({ number: 7, branch: 'topic' } as PullRequest, head, guard);
    if (throwing) await assert.rejects(merged, /advanced/u); else await merged;
    assert.deepEqual(events, throwing ? ['gh view', 'guard'] : ['gh view', 'guard', 'gh merge']);
  }
});

test('D (required): a changed pull request head refuses the merge', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture();
  const { host, delegated, heads } = guardedHost(f, async () => {});
  const result = await f.run(f.config('one'), { steps: out.steps, host, afterEffect: async operation => {
    if (operation !== 'pr') return;
    const branch = f.state('one').current.branch as string;
    git(f.integrator, 'fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    git(f.integrator, 'checkout', '-q', '-B', 'foreign', `origin/${branch}`);
    git(f.integrator, 'commit', '-q', '--allow-empty', '-m', 'test(fixture): foreign commit');
    git(f.integrator, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  } });
  assert.equal(result.status, 'incomplete');
  assert.equal(f.state('one').blocked.A.reason, 'Checked head or target changed');
  assert.equal(heads.length, 0); assert.equal(delegated(), 0);
  assert.equal(f.records[0].state, 'OPEN');
  assert.ok(!hasReceipt(f));
  assert.ok(!out.task().some(line => line.startsWith('A merge:') || line.startsWith('A retry:')));
});

test('D (required): an advance outside the scopes is merged and checked without a new review', async t => {
  const plain = runnerFixture(t, { ids: ['A'] });
  assert.equal((await plain.run(plain.config('one'))).status, 'exhausted');
  const baseline = plain.state('one').completed.A as Work;
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); const before = checkoutState(f.root);
  let target = '';
  const result = await f.run(f.config('one'), { steps: out.steps, afterEffect: async operation => {
    if (operation === 'pr' && !target) target = advance(f, 'docs/other.md');
  } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(checkoutState(f.root), before);
  const completed = f.state('one').completed.A as Work;
  assert.equal(completed.integratedTargets!.at(-1), target);
  assert.equal(completed.targetAttempts, 1);
  assert.equal(sessions(completed, 'review'), sessions(baseline, 'review'));
  assert.equal(sessions(completed, 'document-review'), sessions(baseline, 'document-review'));
  const task = out.task();
  const retry = task.indexOf(`${RETRY} (attempt 2)`);
  assert.ok(retry > 0, task.join('\n'));
  assert.ok(task.indexOf(INTEGRATED) >= 0 && task.indexOf(INTEGRATED) < task.indexOf('A merge: merging #1 (attempt 2)'));
  assert.equal(task[retry - 1], CHECKED);
  assert.deepEqual(task.slice(retry + 1, retry + 5), [`${INTEGRATED} (attempt 2)`,
    'A integrate: integrating the advanced main (attempt 2)', 'A check: running 1/2: node (attempt 2)',
    'A check: running 2/2: node (attempt 2)']);
  assert.ok(task.indexOf('A push: pushing the tested head (attempt 2)') > retry + 4);
  const merge = task.indexOf('A merge: merging #1 (attempt 2)');
  assert.equal(task[merge - 1], `${CHECKED} (attempt 2)`);
  assert.ok(!task.includes('A merge: merging #1'));
  assert.equal(mergesOf(f, target).length, 1);
});

test('D (required): polling the pull request logs only the first and the ready comparison', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture();
  const scripted = f.hostFor('main'); let stale = 0;
  const host: PullRequestHost = {
    find: branch => {
      const pr = scripted.find(branch) as PullRequest | null;
      if (pr?.state === 'OPEN' && f.state('one').current?.stage === 'merge' && stale < 2) {
        stale += 1; return { ...pr, headRefOid: 'f'.repeat(40) };
      }
      return pr;
    },
    create: (work, body) => scripted.create(work, body),
    merge: (pr, head) => scripted.merge(pr, head),
  };
  const result = await f.run(f.config('one'), { steps: out.steps, host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(stale, 2);
  const task = out.task();
  const start = task.indexOf('A wait: waiting for mergeability and checks of #1');
  const end = task.indexOf('A merge: merging #1');
  assert.deepEqual(task.slice(start, end + 1), ['A wait: waiting for mergeability and checks of #1', CHECKED,
    'A wait: waiting for pull request head to match', CHECKED, 'A merge: merging #1']);
  assert.ok(!task.some(line => line.startsWith('A retry:')));
});

// Grade C

test('C (required): an advance inside the scopes while waiting is merged in the worktree, checked, reviewed and accepted', async t => {
  const plain = runnerFixture(t, { ids: ['A'] });
  assert.equal((await plain.run(plain.config('one'))).status, 'exhausted');
  const baseline = plain.state('one').completed.A as Work;
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); const before = checkoutState(f.root);
  let target = '';
  const result = await f.run(f.config('one'), { steps: out.steps, afterEffect: async operation => {
    if (operation === 'pr' && !target) target = advance(f, 'src/a/result.test.mjs', RESULT_TEST);
  } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(checkoutState(f.root), before);
  const state = f.state('one');
  assert.ok(!JSON.stringify(state).includes('Target changed outcome scope'));
  assert.deepEqual(state.blocked ?? {}, {});
  const completed = state.completed.A as Work;
  assert.deepEqual(completed.integratedTargets, [target]);
  assert.equal(sessions(completed, 'review'), sessions(baseline, 'review') + 1);
  const [merge] = mergesOf(f, target);
  assert.ok(merge, 'origin/main has the worktree merge of the target');
  assert.equal(git(f.root, 'log', '-1', '--format=%s', merge.split(' ')[0]), 'chore(fixture): integrate main into A');
  const task = out.task();
  const retry = task.indexOf(`${RETRY} (attempt 2)`);
  assert.equal(task[retry - 1], CHECKED);
  assert.deepEqual(task.slice(retry + 1, retry + 3), [`${INTEGRATED} (attempt 2)`,
    'A integrate: merging the advanced main into the task scope (attempt 2)']);
  const push = task.indexOf('A push: pushing the tested head (attempt 2)');
  const check = task.findIndex((line, index) => index > retry && line.startsWith('A check: '));
  const review = task.indexOf('A review: starting the implementation review session of the merged result');
  assert.ok(retry + 2 < check && check < review && review < push, task.join('\n'));
  assert.equal(git(f.root, 'show', 'origin/main:src/a/result.test.mjs'), RESULT_TEST.trimEnd());
});

test('C (required): origin advancing between the check and the merge repeats the integration before merging', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); let target = '';
  const { host, heads, delegated } = guardedHost(f, async (call, guard) => {
    if (call !== 1) return;
    target = advance(f, 'docs/other.md');
    await guard();
  });
  const result = await f.run(f.config('one'), { steps: out.steps, host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(heads.length, 2); assert.equal(delegated(), 1);
  assert.notEqual(heads[0], heads[1]);
  const task = out.task();
  const merge = task.indexOf('A merge: merging #1');
  assert.deepEqual(task.slice(merge - 1, merge + 3), [CHECKED, 'A merge: merging #1', CHECKED, `${RETRY} (attempt 2)`]);
  assert.ok(task.indexOf('A integrate: integrating the advanced main (attempt 2)') > merge);
  assert.equal(f.state('one').completed.A.targetAttempts, 1);
  assert.equal(git(f.remote, 'show', 'main:docs/other.md'), '# docs/other.md');
  assert.ok(hasReceipt(f));
  assert.equal(mergesOf(f, target).length, 1);
});

// Grade B

test('B (required): a target that keeps advancing blocks with target-keeps-advancing and a restart merges', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const out = capture();
  const { host, heads, delegated } = guardedHost(f, async (call, guard) => {
    advance(f, `docs/other-${call}.md`);
    await guard();
  });
  const result = await f.run(f.config('one'), { steps: out.steps, host });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(heads.length, TARGET_ATTEMPTS); assert.equal(delegated(), 0);
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.equal(result.blockers!.A.reason, 'target-keeps-advancing');
  const blocked = f.state('one').blocked.A;
  assert.equal(blocked.reason, 'target-keeps-advancing');
  assert.equal(blocked.work.stage, 'publish'); assert.equal(blocked.work.targetAttempts, 0);
  const task = out.task();
  assert.deepEqual(task.filter(line => line.startsWith('A retry:')), Array.from({ length: TARGET_ATTEMPTS - 1 }, (_, index) => `${RETRY} (attempt ${index + 2})`));
  assert.deepEqual(task.slice(-2), [`${CHECKED} (attempt ${TARGET_ATTEMPTS})`, 'A blocked: stopped at compare']);
  assert.equal(f.records[0].state, 'OPEN'); assert.ok(!hasReceipt(f));
  const work = blocked.work as Work;
  assert.ok(existsSync(work.path)); assert.ok(hasBranch(f.root, work.branch));
  assert.notEqual(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
  const again = await f.run(f.config('one'));
  assert.equal(again.status, 'exhausted', JSON.stringify(again));
  assert.equal(f.state('one').completed.A.path, work.path);
  assert.ok(hasReceipt(f));
});

for (const resolution of ['resolved', 'unresolved'] as const) {
  test(`B (required): a conflict while waiting to merge is ${resolution}`, async t => {
    const f = runnerFixture(t, { ids: ['A'] }); const out = capture(); const prompts: string[] = [];
    let advanced = false;
    const result = await f.run(f.config('one'), { steps: out.steps, createAdapter: worker(prompts, resolution === 'unresolved'),
      afterEffect: async operation => {
        if (operation === 'pr' && !advanced) { advanced = true; advance(f, 'src/a/result.mjs', FOREIGN); }
      } });
    const task = out.task();
    const retry = task.indexOf(`${RETRY} (attempt 2)`);
    assert.ok(retry > 0, task.join('\n'));
    assert.equal(task[retry - 1], CHECKED);
    assert.equal(prompts.filter(isResolution).length, 1);
    if (resolution === 'resolved') {
      assert.equal(result.status, 'exhausted', JSON.stringify(result));
      const session = task.indexOf('A implementation: starting the conflict resolution session');
      const check = task.findIndex((line, index) => index > session && line.startsWith('A check: '));
      const review = task.indexOf('A review: starting the implementation review session of the merged result');
      assert.ok(retry < session && session < check && check < review, task.join('\n'));
      assert.equal(git(f.remote, 'show', 'main:src/a/result.mjs') + '\n', RESOLVED);
    } else {
      assert.equal(result.status, 'incomplete');
      const blocked = f.state('one').blocked.A;
      assert.equal(blocked.reason, 'target-conflict-unresolved');
      assert.deepEqual(blocked.paths, ['src/a/result.mjs']);
      assert.deepEqual(result.blockers!.A.paths, ['src/a/result.mjs']);
      assert.equal(f.records[0].state, 'OPEN'); assert.ok(!hasReceipt(f));
    }
  });
}

// Grade A

test('A (required): a restart resumes from the recorded target commit without merging it twice', async t => {
  const f = runnerFixture(t, { ids: ['A'] }); const controller = new AbortController();
  const first = capture(); let target = '';
  const cancelled = await f.run(f.config('one'), { steps: first.steps, signal: controller.signal,
    afterEffect: async operation => {
      if (operation === 'pr' && !target) target = advance(f, 'src/a/result.test.mjs', RESULT_TEST);
      if (operation === 'integrate') controller.abort();
    } });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  assert.ok(first.task().includes('A integrate: merging the advanced main into the task scope (attempt 2)'));
  const current = f.state('one').current as Work;
  assert.equal(current.integratedTargets!.at(-1), target);
  assert.equal(current.targetAttempts, 1);
  const second = capture();
  const result = await f.run(f.config('one'), { steps: second.steps });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.match(second.task()[0], /^A (setup|check): resuming /u);
  assert.ok(second.task().includes(`${INTEGRATED} (attempt 2)`));
  assert.ok(!second.task().some(line => line.startsWith('A integrate:')));
  assert.equal(mergesOf(f, target).length, 1);
  const completed = f.state('one').completed.A as Work;
  assert.equal(completed.integratedTargets!.filter(commit => commit === target).length, 1);
});
