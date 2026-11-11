import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { git } from '../../src/git.ts';
import { hash } from '../../src/model.ts';
import type { Project, PullRequest, Queue, RunConfig, Work } from '../../src/model.ts';
import { runQueue } from '../../src/runner.ts';
import type { PullRequestHost, RunOptions } from '../../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../../src/harness-adapter.ts';
import { preparedTestFramework } from './prepared-test-framework.ts';
import { separateArchive } from './scripted-archive.ts';

/** A pull request of the scripted host, with the base branch it was opened against. */
export interface RecordedPullRequest extends PullRequest { base: string }

export interface WorkerHooks {
  /** Runs at the start of every session, before the scripted work. */
  onSession?: (options: HarnessOptions, prompt: string) => void | Promise<void>;
  /** Sessions whose prompt matches fail, which blocks their task. */
  fail?: (prompt: string) => boolean;
}

/** A scripted worker for counter tasks; it never starts a real harness. */
export function scriptedWorker(hooks: WorkerHooks = {}) {
  return (options: HarnessOptions): HarnessAdapter => ({ probe: () => ({ status: 'interface-ready' }), close() {},
    async startAction(prompt: string) {
      await hooks.onSession?.(options, prompt);
      if (hooks.fail?.(prompt)) throw new Error('Scripted worker failure');
      const id = /Task ([A-Za-z0-9]+);/u.exec(prompt)![1].toLowerCase();
      const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
      const write = async (path: string, content: string) => {
        const before = await call('backlog_tool', { operation: 'read_file', input: { path } } as ToolInput);
        await call('backlog_tool', { operation: 'write_file', input: { path, content, expectedHash: before.hash } } as ToolInput);
      };
      const directory = `openspec/changes/counter-${id}`;
      const result: ToolInput = { outcome: 'ready', summary: 'Scripted worker', findings: [] };
      if (prompt.includes('Inspect current files')) result.inspected = [`src/${id}/requirements.md`];
      else if (prompt.includes('Create proposal.md')) {
        await write(`${directory}/proposal.md`, '# Proposal\n\nImplement the counter.\n');
        await write(`${directory}/design.md`, '# Design\n\nAdd one to finite input.\n');
        await write(`${directory}/tasks.md`, '# Tasks\n\n- [ ] 1.1 (E) (required) next(1) returns 2.\n');
        await write(`${directory}/specs/counter/spec.md`, '## ADDED Requirements\n\n### Requirement: Counter\n' +
          'The function SHALL add one.\n\n#### Scenario: One\n- **WHEN** input is one\n- **THEN** the result is two\n');
      } else if (prompt.includes('Implement all approved')) {
        await write(`src/${id}/result.mjs`, 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n');
        await write(`src/${id}/result.test.mjs`, "import assert from 'node:assert/strict'; import {next} from './result.mjs'; assert.equal(next(1), 2);\n");
      } else if (!prompt.includes('Update the documentation inside')) {
        result.outcome = 'accepted';
        if (prompt.includes('Review actual implementation')) {
          result.completion = { summary: 'The counter adds one. Tests cover it.', grade: 'E' };
        }
      }
      await call('outcome_report', result);
      return { threadId: 'fixture', events: [], text: '' } as unknown as WorkerReply;
    } });
}

/**
 * A bare origin, a start checkout on `target` and an integrator clone that merges pull requests. Every task has its
 * own scope and no dependencies, so different invocations can work on different tasks at the same time.
 */
export function runnerFixture(t: TestContext, { target = 'main', ids = ['A', 'B', 'C', 'D'] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'many-runners-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git'); const root = join(base, 'project');
  mkdirSync(root); git(base, 'init', '-q', '--bare', remote); git(root, 'init', '-q', '-b', target);
  git(root, 'config', 'user.name', 'Fixture Worker'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const project: Project = { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target,
    repository: 'fixture', commitScope: 'fixture', planningCheck: { command: 'node', args: ['-e', ''] },
    checks: [{ command: 'node', args: ['checks.mjs'] },
      { command: 'node', args: ['--test', '--experimental-test-coverage', '--test-coverage-lines={coverage}', '{scope}/*.test.mjs'] }] };
  const queue: Queue = { version: 1, tasks: ids.map((id, priority) => ({ id, priority, title: `Counter ${id}`,
    change: `counter-${id.toLowerCase()}`, scopes: [`src/${id.toLowerCase()}`], dependencies: [],
    criteria: [`Create src/${id.toLowerCase()}/result.mjs exporting next(n) that adds one.`] })) };
  mkdirSync(join(root, 'planning')); writeFileSync(join(root, project.queue), JSON.stringify(queue));
  mkdirSync(join(root, 'openspec')); writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  for (const task of queue.tasks) {
    mkdirSync(join(root, task.scopes[0]), { recursive: true });
    writeFileSync(join(root, task.scopes[0], 'requirements.md'), task.criteria.join('\n') + '\n');
  }
  writeFileSync(join(root, 'checks.mjs'), "import { existsSync, readdirSync } from 'node:fs';\n" +
    "for (const id of readdirSync('src')) {\n  if (!existsSync(`src/${id}/result.mjs`)) continue;\n" +
    "  const { next } = await import(`./src/${id}/result.mjs`);\n  if (next(1) !== 2) process.exit(1);\n}\n");
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'test(fixture): define outcomes');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${target}`);
  const integrator = join(base, 'integrator'); git(base, 'clone', '-q', remote, integrator);
  git(integrator, 'config', 'user.name', 'Fixture Integrator'); git(integrator, 'config', 'user.email', 'integrator@example.invalid');
  const records: RecordedPullRequest[] = [];
  /** A scripted pull request host that opens and merges pull requests against `into`. */
  const hostFor = (into = target): PullRequestHost => ({
    find: branch => records.find(pr => pr.branch === branch) ?? null,
    create(work: Work) {
      const pr: RecordedPullRequest = { number: records.length + 1, branch: work.branch, state: 'OPEN',
        headRefOid: git(work.path, 'rev-parse', 'HEAD'), baseRefName: into, base: into };
      records.push(pr); return pr;
    },
    merge(pr, head) {
      assert.equal(head, pr.headRefOid); assert.equal(pr.state, 'OPEN');
      git(integrator, 'fetch', '-q', 'origin'); git(integrator, 'checkout', '-q', '-B', into, `origin/${into}`);
      git(integrator, 'merge', '-q', '--no-ff', head, '-m', `feat(fixture): accept ${pr.number}`);
      git(integrator, 'push', '-q', 'origin', `HEAD:refs/heads/${into}`); pr.state = 'MERGED';
    } });
  const tasks = Object.fromEntries(queue.tasks.map(task => [task.id, hash(task)]));
  /** The configuration of invocation `name` (each invocation has its own state directory). */
  const config = (name = 'one', patch: Partial<RunConfig> = {}): RunConfig => ({ root, harness: 'claude', model: 'claude-opus-5-5',
    effort: 'medium', stateDirectory: join(base, `state-${name}`), invocation: name, project,
    authority: { reference: 'fixture-owner', instruction: 'OFF implement these exact outcomes and normally merge.', target, tasks },
    ...patch });
  /** Scripted options: preflights pass, the archive is scripted and pull requests target the resolved branch. */
  const options = (config: RunConfig, extra: RunOptions = {}): RunOptions => ({ host: hostFor(config.project.target),
    createAdapter: scriptedWorker(), openspec: { probe: () => ({ status: 0 }), configPresent: () => true },
    selection: { interactive: false, probe: harness => ({ harness, available: true, version: 'scripted' }) },
    testFramework: preparedTestFramework, mergePolling: { delay: async () => {} }, runCommand: separateArchive(), ...extra });
  const run = (candidate: RunConfig, extra: RunOptions = {}) => runQueue(candidate, options(candidate, extra));
  const state = (name = 'one') => JSON.parse(readFileSync(join(base, `state-${name}`, 'state.json'), 'utf8'));
  const outcomes = join(base, 'project-outcomes');
  return { base, remote, root, project, queue, records, hostFor, config, options, run, state, outcomes, integrator };
}

export type RunnerFixture = ReturnType<typeof runnerFixture>;

/** HEAD, the current branch, the index and the porcelain status of a checkout. */
export const checkoutState = (root: string) => ({ head: git(root, 'rev-parse', 'HEAD'),
  branch: git(root, 'branch', '--show-current'), index: git(root, 'ls-files', '--stage'),
  status: git(root, 'status', '--porcelain', '--untracked-files=all') });

/** Whether `refs/heads/<branch>` exists in the repository at `path`. */
export function hasBranch(path: string, branch: string): boolean {
  return git(path, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) === `refs/heads/${branch}`;
}
