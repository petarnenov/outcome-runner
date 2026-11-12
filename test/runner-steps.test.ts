import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from '../src/git.ts';
import type { PullRequest, RunConfig } from '../src/model.ts';
import { runQueue } from '../src/runner.ts';
import type { PullRequestHost, RunOptions } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, WorkerReply } from '../src/harness-adapter.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';
import { separateArchive } from './support/scripted-archive.ts';

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
  assert.match(reason, /^Implementation check budget exhausted: /u);
  for (const line of lines) {
    assert.ok(line.length <= 120, line);
    for (const secret of ['unresolved', 'exhausted', 'Scripted worker', 'export const', 'Implement all', 'findings',
      'Error']) {
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

// Grade B

test('B (required): a contended Git lock writes one wait line before the Git group and none when the lock is free', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  const marker = join(f.base, 'lock-held');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'support/git-lock-child.ts'), 'hold-ms', f.root, 'steps',
    '2500', marker], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { child.kill(); });
  while (!existsSync(marker)) await delay(20);
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps });
  assert.equal(await exited, 0);
  assert.equal(result.status, 'exhausted');
  const bodies = lines.map(body);
  assert.deepEqual(bodies.filter(line => line.includes('git lock')), ['run git lock: waiting for the Git lock']);
  const waited = bodies.indexOf('run git lock: waiting for the Git lock');
  assert.ok(bodies.indexOf('run preflight: checking the test framework') < waited);
  assert.ok(waited < bodies.indexOf('A claim: claiming the task'));
  const free = capture();
  assert.equal((await f.run(f.config('two', { leaves: ['B'] }), { steps: free.steps })).status, 'exhausted');
  assert.ok(free.lines.length > 10);
  assert.ok(!free.lines.some(line => line.includes('git lock')));
});

test('B (required): a target advance during the merge stage repeats the publish steps with (attempt 2)', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  let advanced = 0;
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps,
    afterEffect: async operation => { if (operation === 'pr') { advanced += 1; advanceTarget(f); } } });
  assert.equal(result.status, 'exhausted'); assert.equal(advanced, 1);
  const task = of(lines, 'A');
  const start = task.indexOf('A wait: waiting for mergeability and checks of #1');
  assert.deepEqual(task.slice(start), [
    'A wait: waiting for mergeability and checks of #1',
    'A compare: comparing origin/main with the checked target',
    'A retry: origin/main advanced; integrating it again (attempt 2)',
    'A compare: comparing origin/main with the integrated target (attempt 2)',
    'A integrate: integrating the advanced main (attempt 2)',
    'A check: running 1/2: node (attempt 2)',
    'A check: running 2/2: node (attempt 2)',
    'A push: pushing the tested head (attempt 2)',
    'A pull request: finding the pull request (attempt 2)',
    'A pull request: reusing #1 (attempt 2)',
    'A wait: waiting for mergeability and checks of #1 (attempt 2)',
    'A compare: comparing origin/main with the checked target (attempt 2)',
    'A merge: merging #1 (attempt 2)',
    'A acceptance: recording the acceptance',
    'A cleanup: removing the worktree and branches',
  ]);
  assert.ok(!lines.some(line => line.includes('resuming')));
});

test('B (required): a resumed run does not repeat completed steps and marks only its first line resuming', async t => {
  const f = runnerFixture(t); const config = f.config('one', { leaves: ['A'] });
  let interrupt = true;
  const createAdapter = worker({ replace: async (_options, prompt) => {
    if (interrupt && prompt.includes(IMPLEMENT)) {
      interrupt = false; throw Object.assign(new Error('Interrupted'), { interrupted: true });
    }
    return undefined;
  } });
  const stopped = capture();
  await assert.rejects(f.run(config, { steps: stopped.steps, createAdapter }), /Interrupted/u);
  assert.equal(f.state('one').current.stage, 'work');
  assert.ok(of(stopped.lines, 'A').includes('A planning review: starting the planning review session'));
  assert.equal(body(stopped.lines.at(-1)!), 'run end: outcome unavailable');
  const { lines, steps } = capture();
  const result = await f.run(config, { steps, createAdapter });
  assert.equal(result.status, 'exhausted');
  const task = of(lines, 'A');
  assert.equal(task[0], 'A implementation: resuming starting the implementation session (attempt 2)');
  for (const step of ['claim', 'worktree', 'investigation', 'planning', 'planning check', 'planning review']) {
    assert.ok(!task.some(line => line.startsWith(`A ${step}:`)), step);
  }
  assert.deepEqual(lines.filter(line => line.includes('resuming')).map(body), [task[0]]);
  assert.ok(task.includes('A acceptance: recording the acceptance'));
  assert.equal(body(lines.at(-1)!), 'run end: outcome exhausted');
});

/** Runs the CLI `main` over one fixture task with the given step output and returns stdout, exit code and receipt. */
async function throughMain(f: RunnerFixture, steps: RunOptions['steps']) {
  const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
  const path = join(f.base, 'invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const stdout: string[] = [];
  const code = await main(path, (config: RunConfig, options: RunOptions) =>
    runQueue(config, f.options(config, { ...options, steps, now: () => Date.UTC(2026, 10, 11, 9, 5, 3) })),
  line => { stdout.push(line); }, { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg'), OUTCOME_RUNNER_MASCOT: '0' },
    mascot: () => {} });
  const { head: _head, base: _base, ...receipt } = JSON.parse(git(f.remote, 'show', 'main:evidence/results/A.json'));
  return { code, stdout, receipt };
}

test('B (required): stdout, exit code and receipt are identical with a capturing and a no-op step output', async t => {
  const { lines, steps } = capture();
  const captured = await throughMain(runnerFixture(t), steps);
  const silent = await throughMain(runnerFixture(t), () => {});
  assert.equal(captured.code, 0); assert.equal(silent.code, 0);
  assert.deepEqual(captured.stdout, silent.stdout);
  assert.deepEqual(captured.receipt, silent.receipt);
  assert.equal(JSON.parse(captured.stdout.at(-1)!).status, 'exhausted');
  assert.ok(lines.length > 20);
  assert.ok(!captured.stdout.some(line => line.includes('[outcome-runner]')));
});

// Grade A

/** The step line expected immediately before each session, by a distinctive part of its prompt. */
const SESSIONS: [string, string][] = [
  ['Inspect current files', 'A investigation: starting the investigation session'],
  ['Create proposal.md', 'A planning: starting the planning session'],
  ['Review planning artifacts', 'A planning review: starting the planning review session'],
  [IMPLEMENT, 'A implementation: starting the implementation session'],
  ['Review actual implementation', 'A review: starting the implementation review session'],
  ['Update the documentation inside', 'A documentation: starting the documentation session'],
  ['Review the documentation changes', 'A documentation review: starting the documentation review session'],
];

test('A (required): an accepted task writes the ordered step lines, each before the first effect of its step', async t => {
  const f = runnerFixture(t);
  const project = { ...f.project, setup: [{ command: 'node', args: ['-e', ''] }] };
  const config = f.config('one', { leaves: ['A'], project });
  const events: string[] = []; const lines: string[] = []; const effectsPending: [string, boolean][] = [];
  const current = () => f.state('one').current;
  // Each step line checks that the effect of its step has not happened yet.
  const before: Record<string, () => boolean> = {
    'A claim: claiming the task': () => git(f.remote, 'for-each-ref', 'refs/heads/work-queue-claims-main') === '',
    'A worktree: preparing the worktree': () => !existsSync(current().path),
    'A commit: committing the implementation': () => !git(current().path, 'log', '--format=%s').includes('implement A'),
    'A receipt: recording the receipt': () => !existsSync(join(current().path, 'evidence/results/A.json')),
    'A push: pushing the tested head': () => git(f.remote, 'for-each-ref', `refs/heads/${current().branch}`) === '',
    'A merge: merging #1': () => git(f.remote, 'ls-tree', 'main', 'evidence/results/A.json') === '',
    'A acceptance: recording the acceptance': () => !f.state('one').completed?.A,
    'A cleanup: removing the worktree and branches': () => existsSync(f.state('one').completed.A.path),
  };
  const steps = (line: string) => {
    lines.push(line.slice(0, -1)); const text = body(line.slice(0, -1)); events.push(`step ${text}`);
    if (before[text]) effectsPending.push([text, before[text]()]);
  };
  const createAdapter = worker({ replace: async (_options, prompt) => {
    events.push(`session ${SESSIONS.find(([marker]) => prompt.includes(marker))![0]}`); return undefined;
  } });
  const scripted = f.hostFor('main');
  const host: PullRequestHost = {
    find: branch => { events.push('host find'); return scripted.find(branch); },
    create: (work, text) => { events.push('host create'); return scripted.create(work, text); },
    merge: (pr, head) => { events.push('host merge'); return scripted.merge(pr, head); },
  };
  const archive = separateArchive();
  const runCommand = (cwd: string, program: string, args: string[]) => { events.push('command archive'); return archive(cwd, program, args); };
  const result = await f.run(config, { steps, createAdapter, host, runCommand });
  assert.equal(result.status, 'exhausted');
  assert.deepEqual(lines.map(body), [
    'run start: invocation=one harness=claude model=claude-opus-5-5 effort=medium',
    'run preflight: checking OpenSpec',
    'run preflight: checking the harness version',
    'run preflight: checking the test framework',
    'A claim: claiming the task',
    'A worktree: preparing the worktree',
    'A setup: running 1/1: node',
    'A investigation: starting the investigation session',
    'A planning: starting the planning session',
    'A planning check: validating the planning artifacts',
    'A planning review: starting the planning review session',
    'A implementation: starting the implementation session',
    'A commit: committing the implementation',
    'A check: running 1/2: node',
    'A check: running 2/2: node',
    'A review: starting the implementation review session',
    'A documentation: starting the documentation session',
    'A commit: committing the documentation',
    'A documentation review: starting the documentation review session',
    'A final checks: running the final checks',
    'A check: running 1/2: node',
    'A check: running 2/2: node',
    'A archive: archiving the change',
    'A commit: committing the archive',
    'A receipt: recording the receipt',
    'A commit: committing the receipt',
    'A compare: comparing origin/main with the integrated target',
    'A check: running 1/2: node',
    'A check: running 2/2: node',
    'A push: pushing the tested head',
    'A pull request: finding the pull request',
    'A pull request: creating the pull request',
    'A wait: waiting for mergeability and checks of #1',
    'A compare: comparing origin/main with the checked target',
    'A merge: merging #1',
    'A acceptance: recording the acceptance',
    'A cleanup: removing the worktree and branches',
    'run end: outcome exhausted',
  ]);
  for (const line of lines) {
    assert.match(line, /^\[outcome-runner\] \d{2}:\d{2}:\d{2} (?:run|A) [a-z]+(?: [a-z]+)?: \S.*$/u, line);
    assert.ok(line.length <= 120, line); assert.ok(!line.includes('resuming'), line);
  }
  assert.equal(effectsPending.length, Object.keys(before).length);
  for (const [text, pending] of effectsPending) assert.ok(pending, `the effect of "${text}" happened before its line`);
  // Every session, archive command and host call follows the step line of its step in the shared event log.
  const lastStep = (index: number) => events.slice(0, index).reverse().find(event => event.startsWith('step '))!.slice(5);
  events.forEach((event, index) => {
    if (event.startsWith('session ')) {
      const [, expected] = SESSIONS.find(([marker]) => event === `session ${marker}`)!;
      assert.equal(lastStep(index), expected, event);
    }
    if (event === 'command archive') assert.equal(lastStep(index), 'A archive: archiving the change');
    if (event === 'host create') assert.equal(lastStep(index), 'A pull request: creating the pull request');
    if (event === 'host merge') assert.equal(lastStep(index), 'A merge: merging #1');
    if (event === 'host find') {
      assert.ok(['A pull request: finding the pull request', 'A wait: waiting for mergeability and checks of #1',
        'A acceptance: recording the acceptance'].includes(lastStep(index)), lastStep(index));
    }
  });
  assert.equal(events.filter(event => event.startsWith('session ')).length, SESSIONS.length);
  assert.equal(events.filter(event => event === 'command archive').length, 1);
});
