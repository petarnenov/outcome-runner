import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from '../src/git.ts';
import type { RunResult } from '../src/runner.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';

const PARALLEL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SEQUENTIAL = ['I', 'J'];
const TASKS = [...PARALLEL, ...SEQUENTIAL];
const RUNNERS = ['one', 'two', 'three', 'four', 'five'];
const WAITING = ['waiting-for-claim', 'waiting-for-dependency'];

const taskOf = (prompt: string) => /Task ([A-Z]);/u.exec(prompt)![1];

/**
 * Releases every waiting runner once each runner has either reached its first session or finished, so the runs
 * really overlap without deadlocking on a runner that found no free task.
 */
function startingLine(runners: number) {
  let arrived = 0; let release!: () => void;
  const open = new Promise<void>(resolve => { release = resolve; });
  const arrive = () => { arrived += 1; if (arrived === runners) release(); };
  return { open, arrive };
}

// Grade A

/** Every task also holds one scope shared with all the others, so no claim may exclude another task by its scopes. */
const SHARED_SCOPES = Object.fromEntries(TASKS.map(id => [id, [`src/${id.toLowerCase()}`, 'src/shared']]));

for (const [layout, scopes] of [['separate', {}], ['shared', SHARED_SCOPES]] as const) test('A (required): five runners ' +
  `started together on 8 parallel and 2 sequential tasks with ${layout} scopes merge every task once without breaking`,
  { timeout: 900000 }, async t => {
    const f = runnerFixture(t, { ids: TASKS, dependencies: { J: ['I'] }, scopes });
    const line = startingLine(RUNNERS.length);
    const sessions: [runner: string, task: string][] = [];
    const sequentialOrder: string[] = [];
    const worker = (runner: string) => {
      let started = false;
      return scriptedWorker({ onSession: async (_options, prompt) => {
        const task = taskOf(prompt);
        sessions.push([runner, task]);
        if (task === 'J' && sequentialOrder.length === 0) {
          sequentialOrder.push(git(f.remote, 'ls-tree', '--name-only', 'refs/heads/main', 'evidence/results/I.json')
            ? 'J after I merged' : 'J before I merged');
        }
        if (started) return;
        started = true; line.arrive(); await line.open;
      } });
    };

    const results: RunResult[] = await Promise.all(RUNNERS.map(runner =>
      f.run(f.config(runner), { createAdapter: worker(runner) }).finally(() => {
        if (!sessions.some(([name]) => name === runner)) line.arrive();
      })));

    // No runner broke: each ended normally, and an unfinished run only waited for work held or needed elsewhere.
    for (const [index, result] of results.entries()) {
      const runner = RUNNERS[index];
      assert.ok(['exhausted', 'incomplete'].includes(result.status), `${runner}: ${JSON.stringify(result)}`);
      if (result.status === 'incomplete') {
        for (const [id, blocker] of Object.entries(result.blockers ?? {})) {
          assert.ok(WAITING.includes(blocker.kind), `${runner} stopped on ${id}: ${JSON.stringify(blocker)}`);
        }
      }
      assert.deepEqual(f.state(runner).blocked ?? {}, {}, `${runner} blocked a task`);
    }

    // The runs overlapped: every runner accepted at least one task.
    for (const [index, result] of results.entries()) {
      assert.ok(result.accepted.length > 0, `${RUNNERS[index]} accepted nothing: ${JSON.stringify(results)}`);
    }

    // Every task was accepted by exactly one runner and worked by no other.
    const accepted = results.flatMap(result => result.accepted);
    assert.deepEqual([...accepted].sort(), TASKS);
    const workers = new Map<string, Set<string>>();
    for (const [runner, task] of sessions) workers.set(task, new Set([...(workers.get(task) ?? []), runner]));
    for (const [task, runners] of workers) assert.equal(runners.size, 1, `${task} worked by ${[...runners]}`);

    // The sequential task started only after its dependency was merged.
    assert.deepEqual(sequentialOrder, ['J after I merged']);

    // Every task was merged into main exactly once, with its receipt, and one claim each in the ledger.
    assert.equal(f.records.length, TASKS.length);
    for (const id of TASKS) {
      assert.equal(f.records.filter(pr => pr.branch!.startsWith(`outcome/${id}-`) && pr.state === 'MERGED').length, 1, id);
    }
    assert.deepEqual(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main', '--', 'evidence/results').split('\n').sort(),
      TASKS.map(id => `evidence/results/${id}.json`));
    assert.deepEqual(git(f.remote, 'ls-tree', '--name-only', 'refs/heads/work-queue-claims-main').split('\n').sort(),
      TASKS.map(id => `${id}.json`));

    // Nothing is left behind: only the start checkout remains and no task branch stays on origin.
    assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/outcome/'), '');
  });
