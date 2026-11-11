import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import type { PullRequest } from '../src/model.ts';
import type { PullRequestHost } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, WorkerReply } from '../src/harness-adapter.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

/** Collects step lines without their newline. */
function capture() {
  const lines: string[] = [];
  return { lines, steps: (line: string) => { assert.ok(line.endsWith('\n')); lines.push(line.slice(0, -1)); } };
}
/** The part of a step line after `[outcome-runner] HH:MM:SS `. */
const body = (line: string) => line.slice('[outcome-runner] 09:05:03 '.length);
/** The bodies of the lines of one subject, in order. */
const of = (lines: string[], subject: string) => lines.map(body).filter(line => line.startsWith(`${subject} `));

interface WorkerScript {
  /** Answers a session instead of the scripted worker when it returns a reply. */
  replace?: (options: HarnessOptions, prompt: string) => Promise<WorkerReply | undefined>;
  /** Runs after the scripted worker finished a session. */
  after?: (options: HarnessOptions, prompt: string) => void;
}

/** The scripted counter worker with optional replaced sessions and effects after a session. */
function worker({ replace, after }: WorkerScript = {}) {
  const base = scriptedWorker();
  return (options: HarnessOptions): HarnessAdapter => {
    const inner = base(options);
    return { probe: () => inner.probe(), close: () => inner.close(), async startAction(prompt: string) {
      const replaced = await replace?.(options, prompt);
      if (replaced) return replaced;
      const reply = await inner.startAction(prompt);
      after?.(options, prompt);
      return reply;
    } };
  };
}

const reply: WorkerReply = { status: 'worker-returned', threadId: 'fixture', events: [], text: '' };
const IMPLEMENT = 'Implement all approved';
/** Breaks the counter of task A after the implementation sessions selected by `when`, so its checks fail. */
const breakingWorker = (when: () => boolean) => worker({ after: (options, prompt) => {
  if (prompt.includes(IMPLEMENT) && when()) writeFileSync(join(options.cwd, 'src/a/result.mjs'), 'export const next = n => n;\n');
} });

/** Commits an unrelated file to origin/main outside every task scope. */
function advanceTarget(f: RunnerFixture, name = 'other.txt') {
  git(f.integrator, 'fetch', '-q', 'origin'); git(f.integrator, 'checkout', '-q', '-B', 'main', 'origin/main');
  writeFileSync(join(f.integrator, name), 'unrelated\n'); git(f.integrator, 'add', name);
  git(f.integrator, 'commit', '-q', '-m', `chore(fixture): advance ${name}`);
  git(f.integrator, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
}

// Grade D

test('D (required): a throwing OpenSpec preflight logs run start, the OpenSpec preflight and run end unavailable', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  await assert.rejects(f.run(f.config('one', { leaves: ['A'] }),
    { steps, openspec: { probe: () => ({ status: 1 }), interactive: false } }), /OpenSpec CLI unavailable/u);
  assert.deepEqual(lines.map(body), [
    'run start: invocation=one harness=claude model=claude-opus-5-5 effort=medium',
    'run preflight: checking OpenSpec',
    'run end: outcome unavailable',
  ]);
});

// Grade C

test('C (required): a task blocked by failing checks ends with the step it stopped at and no private text', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps, createAdapter: breakingWorker(() => true) });
  assert.equal(result.status, 'incomplete');
  const task = of(lines, 'A');
  assert.equal(task.at(-1), 'A blocked: stopped at check');
  assert.equal(task.filter(line => line.startsWith('A implementation:')).length, 4);
  assert.equal(body(lines.at(-1)!), 'run end: outcome incomplete');
  const reason = f.state('one').blocked.A.reason as string;
  assert.match(reason, /remain unresolved/u);
  for (const line of lines) {
    assert.ok(line.length <= 120, line);
    for (const secret of ['unresolved', 'Scripted worker', 'export const', 'Implement all', 'findings', 'Error']) {
      assert.ok(!line.includes(secret), `${line} contains ${secret}`);
    }
  }
});

test('C (required): a second implementation attempt and its steps carry (attempt 2)', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  let sessions = 0;
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps, createAdapter: breakingWorker(() => sessions++ === 0) });
  assert.equal(result.status, 'exhausted');
  const task = of(lines, 'A');
  const first = task.indexOf('A implementation: starting the implementation session');
  const second = task.indexOf('A implementation: starting the implementation session (attempt 2)');
  assert.ok(first >= 0 && second > first, task.join('\n'));
  assert.deepEqual(task.slice(first, second), ['A implementation: starting the implementation session',
    'A commit: committing the implementation', 'A check: running 1/2: node']);
  assert.deepEqual(task.slice(second, second + 6), [
    'A implementation: starting the implementation session (attempt 2)',
    'A commit: committing the implementation (attempt 2)',
    'A check: running 1/2: node (attempt 2)',
    'A check: running 2/2: node (attempt 2)',
    'A review: starting the implementation review session (attempt 2)',
    'A documentation: starting the documentation session',
  ]);
  assert.ok(!lines.some(line => line.includes(' integrate: ') || line.includes('resuming')));
});

test('C (required): a second documentation round carries (attempt 2) and the first round does not', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  let reviews = 0;
  const createAdapter = worker({ replace: async (options, prompt) => {
    if (!prompt.includes('Review the documentation changes') || reviews++ > 0) return undefined;
    await options.handleTool('outcome_report', { outcome: 'changes-required', summary: 'Documentation incomplete',
      findings: ['Describe the counter'] }, { threadId: 'fixture' });
    return reply;
  } });
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps, createAdapter });
  assert.equal(result.status, 'exhausted');
  const task = of(lines, 'A');
  const start = task.indexOf('A documentation: starting the documentation session');
  assert.deepEqual(task.slice(start, start + 7), [
    'A documentation: starting the documentation session',
    'A commit: committing the documentation',
    'A documentation review: starting the documentation review session',
    'A documentation: starting the documentation session (attempt 2)',
    'A commit: committing the documentation (attempt 2)',
    'A documentation review: starting the documentation review session (attempt 2)',
    'A final checks: running the final checks',
  ]);
  assert.ok(!lines.some(line => line.includes('Describe the counter')));
});

test('C (required): several stale pull request views write one mergeability wait and one head wait line', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  const scripted = f.hostFor('main'); let stale = 0; let polls = 0;
  const host: PullRequestHost = {
    find: branch => {
      const pr = scripted.find(branch) as PullRequest | null;
      if (pr?.state === 'OPEN' && stale < 3) { stale += 1; return { ...pr, headRefOid: '0'.repeat(40) }; }
      return pr;
    },
    create: (work, text) => scripted.create(work, text),
    merge: (pr, head) => scripted.merge(pr, head),
  };
  const result = await f.run(f.config('one', { leaves: ['A'] }),
    { steps, host, mergePolling: { views: 10, delay: async () => { polls += 1; } } });
  assert.equal(result.status, 'exhausted'); assert.equal(stale, 3); assert.equal(polls, 3);
  const task = of(lines, 'A');
  assert.deepEqual(task.filter(line => line.startsWith('A wait:')), [
    'A wait: waiting for mergeability and checks of #1',
    'A wait: waiting for pull request head to match',
  ]);
  assert.deepEqual(task.filter(line => line.startsWith('A merge:')), ['A merge: merging #1']);
});

test('C (required): a target advanced before publish writes an integrate line before the merge commit', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  const headAtIntegrate: string[] = [];
  const recording = (line: string) => {
    steps(line);
    if (line.includes(' A integrate: ')) headAtIntegrate.push(git(f.state('one').current.path, 'log', '-1', '--format=%s'));
  };
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps: recording,
    afterEffect: async operation => { if (operation === 'archive') advanceTarget(f); } });
  assert.equal(result.status, 'exhausted');
  const task = of(lines, 'A');
  assert.deepEqual(task.filter(line => line.startsWith('A integrate:')), ['A integrate: integrating the advanced main']);
  const integrate = task.indexOf('A integrate: integrating the advanced main');
  assert.ok(task.indexOf('A commit: committing the receipt') < integrate);
  assert.ok(integrate < task.indexOf('A push: pushing the tested head'));
  assert.equal(headAtIntegrate.length, 1);
  assert.doesNotMatch(headAtIntegrate[0], /integrate main into A/u);
  assert.match(git(f.remote, 'log', 'main', '--format=%s'), /chore\(fixture\): integrate main into A/u);
  // A target that did not advance writes no integrate line.
  const second = capture();
  assert.equal((await f.run(f.config('two', { leaves: ['B'] }), { steps: second.steps })).status, 'exhausted');
  assert.ok(of(second.lines, 'B').includes('B push: pushing the tested head'));
  assert.ok(!second.lines.some(line => line.includes(' integrate: ')));
});
