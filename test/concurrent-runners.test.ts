import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.ts';
import { GIT_LOCK_TIMEOUT_MS, withGitLock } from '../src/git-lock.ts';
import type { RunConfig } from '../src/model.ts';
import { invocationLockFiles } from '../src/runner.ts';
import type { RunEvent, RunOptions } from '../src/runner.ts';
import { setupWorktree } from '../src/setup-worktree.ts';
import { main } from './support/isolated-cli.ts';
import { checkoutState, hasBranch, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const child = fileURLToPath(new URL('./support/git-lock-child.ts', import.meta.url));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'NODE_OPTIONS'].includes(key)));

function spawnChild(t: TestContext, args: string[]) {
  const process = fork(child, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; process.stdout!.resume(); process.stderr!.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  const exit = once(process, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  return { process, exit, stderr: () => stderr };
}

async function waitFor(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

/** Starts a child that takes the Git lock of `root` and keeps it until it is killed. */
async function holder(t: TestContext, f: RunnerFixture): Promise<ChildProcess & { exited: Promise<unknown> }> {
  const marker = join(f.base, `held-${Math.random().toString(36).slice(2)}`);
  const started = spawnChild(t, ['hold', f.root, 'holder', '0', marker]);
  await waitFor(() => existsSync(marker), 'the Git lock holder');
  return Object.assign(started.process, { exited: started.exit });
}

/** The fixture configuration as an invocation file would hold it: without root and state directory. */
function invocationFile(f: RunnerFixture, config: RunConfig): string {
  const { root: _root, stateDirectory: _state, ...invocation } = config;
  const path = join(f.base, `${config.invocation}.json`); writeFileSync(path, JSON.stringify(invocation));
  return path;
}

const protectedMerge = (f: RunnerFixture): RunOptions => ({ host: { ...f.hostFor(), merge: () => { throw new Error('Protected merge'); } } });

// Grade C

test('C (required): concurrent fetch, worktree and branch operations through the Git lock never fail on lock files', { timeout: 120000 }, async t => {
  const f = runnerFixture(t);
  const children = ['one', 'two', 'three', 'four'].map(name => spawnChild(t, ['work', f.root, name, '4']));
  const exits = await Promise.all(children.map(started => started.exit));
  for (const [index, [code, signal]] of exits.entries()) {
    assert.deepEqual([code, signal], [0, null], children[index].stderr());
    assert.doesNotMatch(children[index].stderr(), /index\.lock|packed-refs\.lock|\.lock/u);
  }
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/lock-'), '');
});

test('C (required): a Git lock holder killed with SIGKILL releases the lock without waiting for the timeout', { timeout: 60000 }, async t => {
  const f = runnerFixture(t);
  const held = await holder(t, f);
  held.kill('SIGKILL'); await held.exited;
  const started = performance.now();
  assert.equal(withGitLock(f.root, () => 'acquired', { timeoutMs: 20000 }), 'acquired');
  assert.ok(performance.now() - started < 5000, `waited ${performance.now() - started} ms`);
});

test('C (required): a wait behind a held Git lock stops at the limit and never runs the group', { timeout: 60000 }, async t => {
  assert.equal(GIT_LOCK_TIMEOUT_MS, 60000);
  const f = runnerFixture(t);
  const held = await holder(t, f);
  let called = false; const started = performance.now();
  assert.throws(() => withGitLock(f.root, () => { called = true; }, { timeoutMs: 300 }),
    (error: Error) => error.message === 'Git lock wait exceeded 60 seconds');
  assert.equal(called, false);
  assert.ok(performance.now() - started >= 250);
  held.kill('SIGKILL'); await held.exited;
});

test('C (required): a second process of the same invocation is refused at once while the first completes', async t => {
  const f = runnerFixture(t);
  const config = f.config('one', { leaves: ['A'] }); const path = invocationFile(f, config);
  const env = { XDG_STATE_HOME: join(f.base, 'xdg') };
  let second: { code: number; lines: string[]; milliseconds: number } | undefined;
  const first: string[] = [];
  const code = await main(path, (resolved, options) => f.run(resolved, { ...options, afterEffect: async kind => {
    if (kind !== 'claim' || second) return;
    const lines: string[] = []; const started = performance.now();
    const refused = await main(path, (again, againOptions) => f.run(again, againOptions), line => lines.push(line), { cwd: f.root, env });
    second = { code: refused, lines, milliseconds: performance.now() - started };
  } }), line => first.push(line), { cwd: f.root, env });
  assert.ok(second, 'the second process started while the first ran');
  assert.equal(second.code, 4); assert.equal(second.lines.length, 1);
  const report = JSON.parse(second.lines[0]);
  assert.equal(report.reason, 'invocation-running');
  assert.equal(JSON.parse(readFileSync(report.diagnostics, 'utf8')).reason, 'invocation-running');
  rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
  assert.ok(second.milliseconds < 10000, `refused after ${second.milliseconds} ms`);
  assert.equal(code, 0);
  const result = JSON.parse(first.at(-1)!);
  assert.equal(result.status, 'exhausted'); assert.deepEqual(result.accepted, ['A']);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'MERGED');
});

test('C (required): a different invocation runs while another invocation\'s ownership is unreleased and leaves its work unchanged', async t => {
  const f = runnerFixture(t);
  const a = f.config('a', { leaves: ['A'] });
  assert.equal((await f.run(a, protectedMerge(f))).status, 'incomplete');
  const work = f.state('a').blocked.A.work;
  const ownership = invocationLockFiles(f.root, a.stateDirectory).ownership;
  const snapshot = () => ({ ownership: readFileSync(ownership, 'utf8'),
    state: readFileSync(join(a.stateDirectory, 'state.json'), 'utf8'),
    worktree: existsSync(work.path) && git(work.path, 'rev-parse', 'HEAD'),
    listed: git(f.root, 'worktree', 'list', '--porcelain').includes(work.path),
    claim: git(f.remote, 'show', 'work-queue-claims-main:A.json'),
    local: git(f.root, 'rev-parse', `refs/heads/${work.branch}`), remote: git(f.remote, 'rev-parse', `refs/heads/${work.branch}`) });
  const before = snapshot();
  assert.equal(JSON.parse(before.ownership).released, false); assert.equal(before.listed, true);
  const b = await f.run(f.config('b', { leaves: ['B'] }));
  assert.equal(b.status, 'exhausted', JSON.stringify(b)); assert.deepEqual(b.accepted, ['B']);
  assert.deepEqual(snapshot(), before);
  const claimants = ['A', 'B'].map(id => JSON.parse(git(f.remote, 'show', `work-queue-claims-main:${id}.json`)).claimant);
  assert.notEqual(claimants[0], claimants[1]);
  assert.equal(claimants[0], f.state('a').claimant); assert.equal(claimants[1], f.state('b').claimant);
});

test('C (required): leftovers of accepted tasks are removed on start before selection while other worktrees stay', async t => {
  const f = runnerFixture(t);
  const one = f.config('one', { leaves: ['A', 'B'] });
  const first = await f.run(one, { createAdapter: scriptedWorker({ fail: prompt => prompt.includes('Task B;') }) });
  assert.equal(first.status, 'incomplete'); assert.deepEqual(first.accepted, ['A']);
  const accepted = f.state('one').completed.A; const unfinished = f.state('one').blocked.B.work;
  assert.equal(existsSync(accepted.path), false);
  // A leftover of the accepted task, for example from a cleanup that failed or a run that stopped before it.
  git(f.root, 'worktree', 'add', '-q', '-b', accepted.branch, accepted.path, 'origin/main');
  const two = f.config('two', { leaves: ['C'] });
  assert.equal((await f.run(two, { createAdapter: scriptedWorker({ fail: prompt => prompt.includes('Task C;') }) })).status, 'incomplete');
  const foreign = f.state('two').blocked.C.work;
  const setup = setupWorktree(f.root, one);
  const events: string[] = []; let observed: Record<string, boolean> | undefined;
  const result = await f.run(one, { afterEffect: async kind => { events.push(kind); },
    createAdapter: scriptedWorker({ onSession: () => {
      if (observed) return;
      events.push('session');
      observed = { leftoverWorktree: existsSync(accepted.path), leftoverBranch: hasBranch(f.root, accepted.branch),
        leftoverListed: git(f.root, 'worktree', 'list', '--porcelain').includes(accepted.path),
        unfinished: existsSync(unfinished.path) && hasBranch(f.root, unfinished.branch),
        foreign: existsSync(foreign.path) && hasBranch(f.root, foreign.branch),
        setup: existsSync(setup.path) && hasBranch(f.root, setup.branch) };
    } }) });
  // A stays in the invocation's accepted results from its earlier run; B is accepted now.
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.deepEqual(result.accepted, ['A', 'B']);
  assert.deepEqual(observed, { leftoverWorktree: false, leftoverBranch: false, leftoverListed: false,
    unfinished: true, foreign: true, setup: true });
  assert.equal(events[0], 'sweep'); assert.ok(events.indexOf('sweep') < events.indexOf('session'), events.join());
  assert.deepEqual(f.state('one').completed.A.cleanup, { failed: [] });
  assert.ok(existsSync(foreign.path) && hasBranch(f.root, foreign.branch));
  assert.ok(existsSync(setup.path) && hasBranch(f.root, setup.branch));
});

test('C (required): a blocked task keeps its worktree, local branch and pushed remote branch and resumes there', async t => {
  const f = runnerFixture(t); const config = f.config('one', { leaves: ['A'] });
  assert.equal((await f.run(config, protectedMerge(f))).status, 'incomplete');
  const work = f.state('one').blocked.A.work;
  assert.equal(work.stage, 'merge');
  assert.ok(existsSync(work.path)); assert.ok(hasBranch(f.root, work.branch));
  assert.equal(git(f.remote, 'rev-parse', `refs/heads/${work.branch}`), work.head);
  const sessions: string[] = [];
  const resumed = await f.run(config, { createAdapter: scriptedWorker({ onSession: options => { sessions.push(options.cwd); } }) });
  assert.equal(resumed.status, 'exhausted', JSON.stringify(resumed)); assert.deepEqual(resumed.accepted, ['A']);
  assert.deepEqual(sessions, []);
  const completed = f.state('one').completed.A;
  assert.equal(completed.path, work.path); assert.equal(completed.branch, work.branch); assert.equal(completed.head, work.head);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'MERGED');
});

// Grade B

test('B (required): after the merge and confirmed acceptance the worktree, local branch and remote branch are removed', async t => {
  const f = runnerFixture(t); const events: RunEvent[] = [];
  const result = await f.run(f.config('one', { leaves: ['A'] }), { report: event => { events.push(event); } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const work = f.state('one').completed.A;
  assert.equal(existsSync(work.path), false);
  assert.ok(!git(f.root, 'worktree', 'list', '--porcelain').includes(work.path));
  assert.equal(hasBranch(f.root, work.branch), false);
  assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
  assert.equal(events.length, 1); assert.equal(events[0].status, 'accepted'); assert.equal(events[0].id, 'A');
  assert.equal('cleanupFailed' in events[0], false); assert.equal(work.cleanup, undefined);
  assert.ok(git(f.remote, 'show', 'refs/heads/main:evidence/results/A.json'));
});

test('B (required): a cleanup failure is reported in the accepted event without changing the result or exit code', async t => {
  const f = runnerFixture(t);
  // Origin refuses every branch deletion, so the remote task branch cannot be removed.
  writeFileSync(join(f.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do\n' +
    '  case "$new" in *[!0]*) ;; *) echo "deletion refused" >&2; exit 1 ;; esac\ndone\nexit 0\n', { mode: 0o755 });
  const path = invocationFile(f, f.config('one', { leaves: ['A'] }));
  let stateDirectory = ''; const lines: string[] = [];
  const code = await main(path, (resolved, options) => { stateDirectory = resolved.stateDirectory; return f.run(resolved, options); },
    line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg') } });
  const [accepted, result] = lines.map(line => JSON.parse(line));
  assert.equal(code, 0, lines.join(''));
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.id, 'A'); assert.deepEqual(accepted.cleanupFailed, ['remote-branch']);
  assert.equal(accepted.grade, 'E'); assert.match(accepted.summary, /^The counter adds one\./u);
  assert.equal(result.status, 'exhausted'); assert.deepEqual(result.accepted, ['A']); assert.deepEqual(result.remaining, []);
  assert.equal(lines.length, 2);
  const work = JSON.parse(readFileSync(join(stateDirectory, 'state.json'), 'utf8')).completed.A;
  assert.deepEqual(work.cleanup, { failed: ['remote-branch'] });
  assert.equal(existsSync(work.path), false); assert.equal(hasBranch(f.root, work.branch), false);
  assert.notEqual(git(f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
});

test('B (required): a run started from a feature branch opens and merges its pull requests against that branch', async t => {
  const f = runnerFixture(t);
  git(f.root, 'checkout', '-q', '-b', 'feature/x'); git(f.root, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
  const main0 = git(f.remote, 'rev-parse', 'refs/heads/main');
  const config = f.config('one', { leaves: ['A'] });
  const { target: _project, ...project } = config.project; const { target: _authority, ...authority } = config.authority;
  const path = invocationFile(f, { ...config, project, authority } as RunConfig);
  let resolved!: RunConfig; const lines: string[] = [];
  const code = await main(path, (candidate, options) => { resolved = candidate; return f.run(candidate, options); },
    line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg') } });
  assert.equal(code, 0, lines.join(''));
  assert.deepEqual([resolved.project.target, resolved.authority.target], ['feature/x', 'feature/x']);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].base, 'feature/x'); assert.equal(f.records[0].state, 'MERGED');
  const receipt = JSON.parse(git(f.remote, 'show', 'refs/heads/feature/x:evidence/results/A.json'));
  assert.equal(receipt.target, 'feature/x');
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), main0);
  assert.notEqual(git(f.remote, 'for-each-ref', 'refs/heads/work-queue-claims-feature-x'), '');
});

test('B (required): the start checkout is unchanged and every task session works in a worktree outside it', async t => {
  const f = runnerFixture(t); const before = checkoutState(f.root); const checkout = realpathSync(f.root);
  const sessions: { cwd: string; real: string }[] = [];
  const result = await f.run(f.config('one', { leaves: ['A', 'B'] }), {
    createAdapter: scriptedWorker({ onSession: options => { sessions.push({ cwd: options.cwd, real: realpathSync(options.cwd) }); } }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.deepEqual(result.accepted, ['A', 'B']);
  assert.deepEqual(checkoutState(f.root), before);
  assert.ok(sessions.length > 0);
  assert.equal(new Set(sessions.map(session => session.cwd)).size, 2);
  for (const { cwd, real } of sessions) {
    assert.ok(cwd.startsWith(`${f.outcomes}/`), cwd);
    assert.notEqual(cwd, f.root); assert.notEqual(real, checkout);
    assert.ok(!real.startsWith(`${checkout}/`), real);
  }
});

// Grade A

test('A (required): two invocations run concurrently in one clone on one branch and merge different tasks', { timeout: 300000 }, async t => {
  const f = runnerFixture(t);
  // Both invocations hold a claimed task before either works on it, so the runs really overlap.
  const arrived = new Set<string>(); let release!: () => void;
  const together = new Promise<void>(resolve => { release = resolve; });
  const sessions: [string, string][] = [];
  const worker = (name: string) => scriptedWorker({ onSession: async (_options, prompt) => {
    sessions.push([name, /Task ([A-Z]);/u.exec(prompt)![1]]);
    if (arrived.has(name)) return;
    arrived.add(name); if (arrived.size === 2) release();
    await together;
  } });
  const [one, two] = await Promise.all(['one', 'two'].map(name => f.run(f.config(name), { createAdapter: worker(name) })));
  for (const result of [one, two]) assert.ok(['exhausted', 'incomplete'].includes(result.status), JSON.stringify(result));
  assert.ok(one.accepted.length > 0 && two.accepted.length > 0, JSON.stringify([one, two]));
  assert.deepEqual([...one.accepted, ...two.accepted].sort(), ['A', 'B', 'C', 'D']);
  // No task was worked by both invocations.
  const workers = new Map<string, Set<string>>();
  for (const [name, id] of sessions) workers.set(id, new Set([...(workers.get(id) ?? []), name]));
  for (const [id, names] of workers) assert.equal(names.size, 1, `${id} worked by ${[...names]}`);
  // The claims ledger holds one claim per task, each by the claimant of the invocation that accepted it.
  const claimants = { one: f.state('one').claimant as string, two: f.state('two').claimant as string };
  assert.notEqual(claimants.one, claimants.two);
  assert.deepEqual(git(f.remote, 'ls-tree', '--name-only', 'refs/heads/work-queue-claims-main').split('\n').sort(),
    ['A.json', 'B.json', 'C.json', 'D.json']);
  for (const id of ['A', 'B', 'C', 'D']) {
    const claim = JSON.parse(git(f.remote, 'show', `refs/heads/work-queue-claims-main:${id}.json`));
    assert.equal(claim.claimant, one.accepted.includes(id) ? claimants.one : claimants.two, id);
  }
  // Every task was merged into the start branch exactly once.
  assert.equal(f.records.length, 4);
  for (const id of ['A', 'B', 'C', 'D']) {
    assert.equal(f.records.filter(pr => pr.branch!.startsWith(`outcome/${id}-`) && pr.state === 'MERGED').length, 1, id);
  }
  assert.ok(f.records.every(pr => pr.base === 'main'));
  assert.deepEqual(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main', '--', 'evidence/results').split('\n').sort(),
    ['evidence/results/A.json', 'evidence/results/B.json', 'evidence/results/C.json', 'evidence/results/D.json']);
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
});
