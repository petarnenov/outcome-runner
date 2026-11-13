import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { git, command } from '../src/git.ts';
import { hash, validateConfig, validateQueue } from '../src/model.ts';
import type { CheckRecord, Harness, Project, PullRequest, Queue, ReviewRecord, RunConfig, Work, WorkerSession } from '../src/model.ts';
import { main } from './support/isolated-cli.ts';
import { main as ledgerMain } from '../src/cli.ts';
import { Statistics, ledgerPath } from '../src/statistics.ts';
import type { RunStatistics } from '../src/statistics.ts';
import { invocationLockFiles, runQueue as runQueueWithPreflight } from '../src/runner.ts';
import { PAGE_BYTES } from '../src/text-page.ts';
import type { RunEvent, RunOptions } from '../src/runner.ts';
import { ClaimLedger } from '../src/claims.ts';
import { RunStore } from '../src/run-store.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolContext, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { separateArchive } from './support/scripted-archive.ts';

// Scripted runs pass a scripted OpenSpec preflight so no test runs the openspec binary;
// test/openspec-preflight.test.ts covers the real checks.
const passingOpenspec: RunOptions['openspec'] = { probe: () => ({ status: 0 }), configPresent: () => true };
// Scripted runs also report both harnesses available, non-interactively, so no test probes a real harness;
// test/harness-selection.test.ts covers the availability check and the prompts.
const passingSelection: RunOptions['selection'] = { interactive: false,
  probe: harness => ({ harness, available: true, version: 'scripted' }) };
// Scripted runs also archive through a scripted command, so no test runs openspec archive;
// test/document-archive.test.ts covers the archive stage.
// A run that waits for work held elsewhere is cancelled by its first fake sleep instead of polling for real;
// test/wait-for-free-work.test.ts covers the waits themselves.
const runQueue: typeof runQueueWithPreflight = (config, options = {}) => {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const sleep = options.sleep ?? (async () => {
    if (abort.signal.aborted) throw new Error('fake sleep: poll limit reached');
    abort.abort();
  });
  return runQueueWithPreflight(config, { openspec: passingOpenspec, selection: passingSelection,
    mergePolling: { delay: async () => {} }, runCommand: separateArchive(), ...options, signal, sleep });
};
const withPassingOpenspec = (portable: typeof runQueueWithPreflight): typeof runQueueWithPreflight =>
  (config, options = {}) => portable(config, { openspec: passingOpenspec, selection: passingSelection,
    runCommand: separateArchive(), ...options });

interface FixtureHost {
  find(branch: string): PullRequest | null;
  create(work: Work, body?: string): PullRequest;
  merge(pr: PullRequest, head: string): void;
}

interface ScriptedOptions extends Omit<HarnessOptions, 'handleTool'> {
  // Method syntax keeps this assignable from HarnessOptions: scripted workers omit the context argument.
  handleTool(name: string, input: ToolInput, context?: ToolContext): Promise<any>;
}

interface ChildOutcome { status?: string; interrupted?: boolean }

interface ChildMessage {
  type: string;
  id: number;
  method: keyof FixtureHost;
  args: unknown[];
  result: ChildOutcome;
  message: string;
}

type Fixture = ReturnType<typeof fixture>;
type RunResult = Awaited<ReturnType<typeof runQueue>>;

function fixture(t: TestContext, { second = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'outcome-test-')); t.after(() => {
    if (process.env.KEEP_OUTCOME_FIXTURE !== '1') rmSync(base, { recursive: true, force: true });
  });
  const remote = join(base, 'origin.git'); const root = join(base, 'project');
  // The start checkout is on the target branch: the run target is the branch the runner starts from.
  mkdirSync(root); git(base, 'init', '--bare', remote); git(root, 'init', '-b', second ? 'staging' : 'proposal');
  git(root, 'config', 'user.name', 'Fixture Worker'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const project: Project = { queue: second ? 'planning/work.json' : 'docs/work-queue/queue.json',
    changes: 'openspec/changes', receipts: second ? 'evidence/results' : 'docs/work-queue/receipts',
    target: second ? 'staging' : 'proposal', repository: 'fixture',
    commitScope: second ? 'counter' : 'fixture-tools', commitSuffix: second ? ' (PORT-1)' : '',
    planningCheck: { command: 'openspec', args: ['validate', '{change}', '--strict'] },
    checks: [{ command: 'make', args: [second ? 'verify-result' : 'pr-check'] },
      { command: 'node', args: ['--test', '--experimental-test-coverage', '--test-coverage-lines={coverage}', '{scope}/*.test.mjs'] }] };
  const queue: Queue = { version: 1, tasks: ['A', 'B', 'C', 'D'].map((id, priority) => ({
    id, priority, title: `Implement finite counter ${id}`, change: `counter-${id.toLowerCase()}`,
    scopes: [`src/${id.toLowerCase()}`], dependencies: priority ? [['A'], ['B'], []][priority - 1] : [],
    criteria: [`Create src/${id.toLowerCase()}/result.mjs exporting next(n).`,
      'Return n + 1 for finite numbers. Throw TypeError for nonnumbers, NaN, Infinity and negative Infinity.',
      'Preserve the requirements.md file. Include tests within your scope.'] })) };
  mkdirSync(join(root, project.queue, '..'), { recursive: true });
  writeFileSync(join(root, project.queue), JSON.stringify(queue));
  mkdirSync(join(root, 'openspec'), { recursive: true });
  writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  for (const task of queue.tasks) {
    mkdirSync(join(root, task.scopes[0]), { recursive: true });
    writeFileSync(join(root, task.scopes[0], 'requirements.md'), task.criteria.join('\n'));
  }
  writeFileSync(join(root, 'checks.mjs'), `import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
for(const id of ['a','b','c','d']){
 if(!existsSync('src/'+id+'/result.mjs'))continue;
 const {next}=await import('./src/'+id+'/result.mjs');
 assert.equal(next(1),2);assert.equal(next(-1),0);assert.throws(()=>next('1'),TypeError);
}
console.log('Fixture result checks passed');\n`);
  writeFileSync(join(root, 'Makefile'), `${second ? 'verify-result' : 'pr-check'}:\n\tnode checks.mjs\n`);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test(fixture-tools): define outcomes');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', `HEAD:${project.target}`);
  const integrator = join(base, 'integrator'); git(base, 'clone', remote, integrator);
  git(integrator, 'config', 'user.name', 'Fixture Integrator');
  git(integrator, 'config', 'user.email', 'integrator@example.invalid');
  const records: PullRequest[] = [];
  const host: FixtureHost = { find: branch => records.find(pr => pr.branch === branch) ?? null,
    create(work) { const pr = { number: records.length + 1, branch: work.branch, state: 'OPEN',
      headRefOid: git(work.path, 'rev-parse', 'HEAD') } as PullRequest; records.push(pr); return pr; },
    merge(pr, head) {
      assert.equal(head, pr.headRefOid); assert.equal(pr.state, 'OPEN');
      git(integrator, 'fetch', 'origin');
      git(integrator, 'checkout', '-B', project.target, `origin/${project.target}`);
      git(integrator, 'merge', '--no-ff', head, '-m', `feat(fixture-tools): accept ${pr.number}`);
      git(integrator, 'push', 'origin', `HEAD:${project.target}`); pr.state = 'MERGED';
    } };
  // Scripted runs use the static Claude catalog so resolution never starts a real harness.
  const config: RunConfig = { root, harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', stateDirectory: join(base, 'state'), invocation: 'fixture', project,
    authority: { reference: 'fixture-owner-off', instruction: 'OFF implement these exact outcomes and normally merge.',
      target: project.target, tasks: Object.fromEntries(queue.tasks.map(task => [task.id, hash(task)])) } };
  return { base, root, project, queue, config, records, host };
}

function realHarness(config: RunConfig) {
  config.harness = (process.env.OUTCOME_TEST_HARNESS ?? 'codex') as Harness;
  config.model = config.harness === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol';
  config.effort = 'medium';
}

function scripted(options: ScriptedOptions): HarnessAdapter {
  return { probe: () => ({ status: 'interface-ready' }), close() {}, async startAction(prompt: string) {
    const id = /Task ([A-D]);/u.exec(prompt)![1].toLowerCase();
    const directory = `openspec/changes/counter-${id}`;
    const write = async (path: string, content: string) => {
      const before = await options.handleTool('backlog_tool', { operation: 'read_file', input: { path } });
      await options.handleTool('backlog_tool', { operation: 'write_file',
        input: { path, content, expectedHash: before.hash } });
    };
    await options.onHandle!({ threadId: 'scripted-unit-session' });
    const context = await options.handleTool('backlog_tool', { operation: 'context', input: {} as BrokerInput });
    assert.ok(context.files.length);
    await assert.rejects(options.handleTool('backlog_tool', { operation: 'context', input: { offset: -1 } as BrokerInput }), /offset/u);
    let result: ToolInput = { outcome: 'ready', summary: 'Scripted test adapter', findings: [] };
    if (prompt.includes('Inspect current files')) result.inspected = [`src/${id}/requirements.md`];
    else if (prompt.includes('Create proposal.md')) {
      await write(`${directory}/proposal.md`, '# Proposal\n\n## Why\nImplement the finite counter.\n');
      await write(`${directory}/design.md`, '# Design\nValidate finite input before adding one.\n');
      await write(`${directory}/tasks.md`, '# Tasks\n- [ ] 1.1 Implement and test the finite counter.\n');
      await write(`${directory}/specs/finite-counter/spec.md`, '# Spec Delta\n\n## Purpose\n' +
        'Provide a counter that rejects nonfinite input and increments finite values.\n\n## ADDED Requirements\n\n' +
        '### Requirement: Finite increment\nThe function SHALL increment finite numbers and reject other inputs.\n\n' +
        '#### Scenario: Finite input\n- **WHEN** input is one\n- **THEN** the result is two\n');
    } else if (prompt.includes('Implement all approved')) {
      await write(`src/${id}/result.mjs`, 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n');
      await write(`src/${id}/result.test.mjs`, "import assert from 'node:assert/strict'; import {next} from './result.mjs'; assert.equal(next(1),2);\n");
      await options.handleTool('backlog_tool', { operation: 'run_checks', input: {} as BrokerInput });
    } else {
      result.outcome = 'accepted';
      if (prompt.includes('Review actual implementation')) {
        result.completion = { summary: 'The counter now increments finite numbers. Invalid inputs are rejected.', grade: 'E' };
        const file = await options.handleTool('backlog_tool', { operation: 'read_file', input: { path: `src/${id}/result.mjs` } });
        if (!file.content.includes('Number.isFinite')) {
          result.outcome = 'changes-required'; result.findings = ['Reject NaN and infinities as required.'];
        }
      }
    }
    await options.handleTool('outcome_report', result);
    return { threadId: 'scripted-unit-session', events: [], text: 'Private text must never prompt a human.' } as unknown as WorkerReply;
  } };
}

test('queue rejects cycles, duplicate change identities and controller scope writes', t => {
  const f = fixture(t); validateConfig(f.config); validateQueue(f.queue, f.project);
  const cycle = structuredClone(f.queue); cycle.tasks[0].dependencies = ['B'];
  assert.throws(() => validateQueue(cycle, f.project), /cyclic/u);
  const duplicate = structuredClone(f.queue); duplicate.tasks[1].change = duplicate.tasks[0].change;
  assert.throws(() => validateQueue(duplicate, f.project), /duplicate/u);
  const scope = structuredClone(f.queue); scope.tasks[0].scopes = ['docs'];
  assert.throws(() => validateQueue(scope, f.project), /overlaps/u);
  assert.throws(() => validateConfig({ ...f.config, maxAccepted: 0 }), /Invalid/u);
  assert.throws(() => validateConfig({ ...f.config, project: { ...f.project, commitScope: 'bad scope' } }), /metadata/u);
  assert.throws(() => validateConfig({ ...f.config, project: { ...f.project, commitSuffix: '\nunsafe' } }), /metadata/u);
});

test('scripted outcome creates and reviews OpenSpec then accepts one result', async t => {
  const f = fixture(t); const events: RunEvent[] = [];
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: scripted, report: event => events.push(event) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'MERGED');
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.ok(state.completed.A.specification); assert.ok(state.completed.A.planningReviews.length);
  assert.ok(!JSON.stringify(events).includes('Private text'));
});

test(`${process.env.OUTCOME_TEST_HARNESS ?? 'codex'}: one real outcome starts without a packet and reaches actual acceptance`, {
  skip: process.env.LIVE_OUTCOME_ONE !== '1', timeout: 360000,
}, async t => {
  const f = fixture(t); realHarness(f.config);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.ok(state.completed.A.sessions.length >= 5); assert.equal(f.records.length, 1);
  t.diagnostic(JSON.stringify({ harness: f.config.harness, model: f.config.model, effort: f.config.effort, result, sessions: state.completed.A.sessions.map((s: WorkerSession) => ({ purpose: s.purpose, threadId: s.threadId })),
    checks: state.completed.A.checks, fixture: f.base }));
});

test(`${process.env.OUTCOME_TEST_HARNESS ?? 'codex'}: three real outcomes repair a review finding and stop before the fourth`, {
  skip: process.env.LIVE_OUTCOME_THREE !== '1', timeout: 900000,
}, async t => {
  const f = fixture(t); realHarness(f.config); let injected = false;
  const result = await runQueue({ ...f.config, maxAccepted: 3 }, { host: f.host,
    afterEffect: async (kind, work) => {
      if (kind === 'implementation' && !injected) {
        injected = true; writeFileSync(join((work as Work).path, 'src/a/requirements.md'),
          readFileSync(join((work as Work).path, 'src/a/requirements.md'), 'utf8') + '\nUnapproved modification for review detection.\n');
      }
    } });
  assert.equal(result.status, 'limit-reached', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A', 'B', 'C']); assert.deepEqual(result.remaining, ['D']);
  assert.equal(f.records.length, 3);
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.ok(state.completed.A.reviews.some((r: ReviewRecord) => r.outcome === 'changes-required'));
  t.diagnostic(JSON.stringify({ harness: f.config.harness, model: f.config.model, effort: f.config.effort, result, reviews: state.completed.A.reviews, fixture: f.base }));
});

for (const boundary of ['claim', 'pr', 'merge']) test(`restart reconciles outcome ${boundary}`, async t => {
  const f = fixture(t); const config = { ...f.config, maxAccepted: 1 };
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => {
      if (kind === boundary) throw Object.assign(new Error('Interrupted'), { interrupted: true });
    } }), /Interrupted/u);
  const result = await runQueue(config, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'limit-reached', JSON.stringify(result)); assert.equal(f.records.length, 1);
  const repeat = await runQueue(config, { host: f.host, createAdapter: scripted });
  assert.deepEqual(repeat, result); assert.equal(f.records.length, 1);
});

test('copied distribution accepts a differently configured independent project', async t => {
  const f = fixture(t, { second: true }); const distribution = join(f.base, 'portable');
  cpSync('src', distribution, { recursive: true });
  const { runQueue: copied } = await import(pathToFileURL(join(distribution, 'runner.ts')).href);
  const portable = withPassingOpenspec(copied);
  for (const coverage of [0, 101, 85.5, '90', null]) {
    await assert.rejects(portable({ ...f.config, coverage } as RunConfig), /Invalid coverage/u);
  }
  await assert.rejects(portable({ ...f.config, project: { ...f.project,
    checks: [{ command: 'node', args: ['--test'] }] } }), /A coverage gate check is required/u);
  const result = await portable({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(f.records[0].state, 'MERGED');
});

test('protected result stays incomplete while independent work proceeds without leaking worker output', async t => {
  const f = fixture(t); const merge = f.host.merge;
  f.host.merge = (pr, head) => {
    if (pr.branch!.startsWith('outcome/A-')) throw new Error('Please approve this merge?');
    return merge(pr, head);
  };
  const result = await runQueue(f.config, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.accepted, ['D']); assert.deepEqual(Object.keys(result.completions), ['D']);
  assert.deepEqual(result.remaining, ['A', 'B', 'C']);
  assert.ok(!JSON.stringify(result).includes('Private text'));
  assert.ok(!JSON.stringify(result).includes('Please approve'));
  // Another invocation of the clone runs; the unfinished claim of A keeps it and its dependents out of reach, so it
  // waits for the claim until its first poll cancels it.
  const other = await runQueue({ ...f.config, invocation: 'other', stateDirectory: join(f.base, 'other') },
    { host: f.host, createAdapter: scripted });
  assert.equal(other.status, 'cancelled'); assert.equal(other.blockers!.A.kind, 'waiting-for-claim');
  const count = f.records.length;
  const retry = await runQueue(f.config, { host: f.host, createAdapter: scripted });
  assert.equal(retry.status, 'incomplete'); assert.equal(f.records.length, count);
});

test('a second process of the same invocation is refused while another invocation runs alongside', async t => {
  const f = fixture(t); let checked = false;
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => {
      if (kind !== 'claim' || checked) return;
      checked = true;
      await assert.rejects(runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted }),
        (error: Error & { reason?: string }) => error.reason === 'invocation-running' && /locked/u.test(error.message));
      const other = await runQueue({ ...f.config, leaves: ['D'], invocation: 'other', stateDirectory: join(f.base, 'other') },
        { host: f.host, createAdapter: scripted });
      assert.equal(other.status, 'exhausted', JSON.stringify(other));
    } });
  assert.equal(result.status, 'exhausted'); assert.ok(checked);
});

test('changed source and bound specification cannot gain execution authority', async t => {
  const f = fixture(t);
  await assert.rejects(runQueue({ ...f.config, authority: { ...f.config.authority,
    tasks: { A: '0'.repeat(64) } } }, { host: f.host, createAdapter: scripted }), /source differs/u);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async (kind, work) => {
      if (kind === 'implementation') writeFileSync(join((work as Work).path, (work as Work).directory, 'design.md'), '# Changed scope\n');
    } });
  assert.equal(result.status, 'incomplete'); assert.equal(f.records.length, 0);
  assert.equal(result.blockers!.A.stage, 'work');
  const privateState = JSON.parse(readFileSync(result.blockers!.A.diagnostics!, 'utf8'));
  assert.match(privateState.blocked.A.reason, /specification changed/u);
});

test('CLI reports bounded success, incomplete work and unavailable configuration', async t => {
  const f = fixture(t); const configPath = join(f.base, 'config.json');
  const { main } = await import('./support/isolated-cli.ts');
  const { root, stateDirectory, ...invocation } = f.config;
  writeFileSync(configPath, JSON.stringify(invocation));
  for (const [status, expected] of [['exhausted', 0], ['limit-reached', 0], ['incomplete', 3]] as [string, number][]) {
    const output: Record<string, unknown>[] = [];
    assert.equal(await main(configPath, async (_, { report }) => {
      report!({ status: 'accepted', id: 'A' }); return { status };
    }, text => output.push(JSON.parse(text)), { cwd: root }), expected);
    assert.equal(output[0].id, 'A'); assert.equal(output[1].status, status);
  }
  assert.equal(await main(join(f.base, 'missing'), undefined, () => {}, { cwd: root }), 4);
});

test('GitHub host uses explicit target and never bypasses protected merges', async () => {
  const { GitHubHost } = await import('../src/git.ts');
  assert.throws(() => new GitHubHost('.', {} as Project), /Explicit/u);
  const host = new GitHubHost('.', { target: 'staging', repository: 'fixture' } as Project);
  const calls: string[][] = []; let rows: { number: number }[] = []; let view = {};
  host.gh = (...args) => { calls.push(args); return args[1] === 'view' ? JSON.stringify(view) : JSON.stringify(rows); };
  assert.equal(host.find('branch'), null);
  rows = [{ number: 1 }]; assert.equal(host.create({ id: 'A', branch: 'branch' } as Work, '/body')!.number, 1);
  rows.push({ number: 2 }); assert.throws(() => host.find('branch'), /Multiple/u);
  await assert.rejects(host.merge({ number: 1 } as PullRequest, 'head'), /protection/u);
  view = { state: 'OPEN', headRefOid: 'head', baseRefName: 'staging', mergeStateStatus: 'CLEAN', isDraft: false };
  await host.merge({ number: 1 } as PullRequest, 'head');
  assert.ok(calls.some(args => args[1] === 'merge' && args.includes('--match-head-commit')));
  assert.ok(calls.every(args => !args.includes('--admin')));
});

function mergeHost(GitHubHost: typeof import('../src/git.ts').GitHubHost, statuses: string[]) {
  const host = new GitHubHost('.', { target: 'staging', repository: 'fixture' } as Project, 0, { delay: async () => {} });
  const calls = { views: 0, merges: 0 };
  host.gh = (...args) => {
    if (args[1] === 'merge') { calls.merges += 1; return ''; }
    const mergeStateStatus = statuses[Math.min(calls.views, statuses.length - 1)]; calls.views += 1;
    return JSON.stringify({ state: 'OPEN', headRefOid: 'head', baseRefName: 'staging', mergeStateStatus, isDraft: false });
  };
  return { host, calls };
}

test('merge waits while GitHub is still computing mergeability', async () => {
  const { GitHubHost } = await import('../src/git.ts');
  const { host, calls } = mergeHost(GitHubHost, ['UNKNOWN', 'UNKNOWN', 'CLEAN']);
  await host.merge({ number: 1 } as PullRequest, 'head');
  assert.deepEqual(calls, { views: 3, merges: 1 });
});

test('merge gives up when mergeability never settles', async () => {
  const { GitHubHost } = await import('../src/git.ts');
  const { host, calls } = mergeHost(GitHubHost, ['UNKNOWN']);
  await assert.rejects(host.merge({ number: 1 } as PullRequest, 'head'), /UNKNOWN/u);
  assert.deepEqual(calls, { views: 100, merges: 0 });
});

test('merge does not wait out a settled blocked status', async () => {
  const { GitHubHost } = await import('../src/git.ts');
  const { host, calls } = mergeHost(GitHubHost, ['BLOCKED', 'CLEAN']);
  await assert.rejects(host.merge({ number: 1 } as PullRequest, 'head'), /BLOCKED/u);
  assert.deepEqual(calls, { views: 1, merges: 0 });
});

test('previously accepted dependency is usable outside selected tasks and counts zero', async t => {
  const f = fixture(t);
  const first = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted });
  assert.equal(first.status, 'exhausted');
  const second = await runQueue({ ...f.config, leaves: ['B'], maxAccepted: 1,
    invocation: 'second', stateDirectory: join(f.base, 'second') }, { host: f.host, createAdapter: scripted });
  assert.equal(second.status, 'limit-reached', JSON.stringify(second)); assert.deepEqual(second.accepted, ['B']); assert.deepEqual(Object.keys(second.completions), ['B']);
  const previousOnly = await runQueue({ ...f.config, leaves: ['A'], maxAccepted: 1,
    invocation: 'third', stateDirectory: join(f.base, 'third') }, { host: f.host, createAdapter: scripted });
  assert.equal(previousOnly.status, 'incomplete'); assert.deepEqual(previousOnly.accepted, []); assert.deepEqual(previousOnly.completions, {});
  assert.equal(f.records.length, 2);
});


test(`${process.env.OUTCOME_TEST_HARNESS ?? 'codex'}: fresh process resumes real outcome after external PR creation`, {
  skip: process.env.LIVE_OUTCOME_RESTART !== '1', timeout: 600000,
}, async t => {
  const f = fixture(t); realHarness(f.config); const configPath = join(f.base, 'invocation.json');
  writeFileSync(configPath, JSON.stringify({ ...f.config, leaves: ['A'], maxAccepted: 1 }));
  const childRun = (boundary?: string) => new Promise<ChildOutcome>((resolve, reject) => {
    const child = fork('test/support/work-queue-child.ts', [configPath, boundary ?? ''],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.resume(); child.stderr!.resume(); let result: ChildOutcome | undefined; let killed = false; let failure: Error | undefined;
    child.on('error', reject);
    child.on('message', async (message: ChildMessage) => {
      if (message.type === 'host') {
        try { child.send({ id: message.id, result: await (f.host[message.method] as (...args: unknown[]) => unknown)(...message.args) }); }
        catch (error) { child.send({ id: message.id, error: (error as Error).message }); }
      } else if (message.type === 'boundary') { killed = true; child.kill('SIGKILL'); }
      else if (message.type === 'result') result = message.result;
      else if (message.type === 'error') failure = new Error(message.message);
    });
    child.on('exit', (code, signal) => {
      if (failure) reject(failure);
      else if (killed && signal === 'SIGKILL') resolve({ interrupted: true });
      else if (code === 0 && result) resolve(result);
      else reject(new Error('Child exited without a recorded result'));
    });
  });
  assert.deepEqual(await childRun('pr'), { interrupted: true });
  const before = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8')).current;
  const result = await childRun();
  assert.equal(result.status, 'limit-reached', JSON.stringify(result)); assert.equal(f.records.length, 1);
  const after = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8')).completed.A;
  assert.equal(before.operation, after.operation); assert.equal(before.branch, after.branch);
  t.diagnostic(JSON.stringify({ harness: f.config.harness, model: f.config.model, effort: f.config.effort, result, operation: after.operation, pr: after.pr.number, fixture: f.base }));
});

test('planning validation and review findings are repaired before implementation', async t => {
  const f = fixture(t); let planning = 0; let reviewed = false;
  const adapter = (options: ScriptedOptions): HarnessAdapter => {
    const inner = scripted({ ...options, handleTool: async (name, input) => {
      if (name === 'outcome_report' && input.outcome === 'accepted' && !reviewed) {
        reviewed = true; return options.handleTool(name, { ...input,
          outcome: 'changes-required', findings: ['Describe rejection of NaN explicitly.'] });
      }
      return options.handleTool(name, input);
    } });
    return { ...inner, async startAction(prompt: string) {
      const result = await inner.startAction(prompt);
      if (prompt.includes('Create proposal.md') && ++planning === 1) {
        writeFileSync(join(options.cwd, 'openspec/changes/counter-a/specs/finite-counter/spec.md'), '# Invalid delta\n');
      }
      return result;
    } };
  };
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: adapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(planning, 3);
});

test('unresolved structured report and unavailable interface remain incomplete', async t => {
  const f = fixture(t);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: () => ({ probe: () => ({ status: 'unsupported' }), close() {} }) as HarnessAdapter });
  assert.equal(result.status, 'incomplete'); assert.equal(f.records.length, 0);
  assert.equal(result.blockers!.A.stage, 'investigate');
  assert.match(JSON.parse(readFileSync(result.blockers!.A.diagnostics!, 'utf8')).blocked.A.reason, /interface/u);
  const retry = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: () => ({ probe: () => ({ status: 'interface-ready' }), close() {},
      async startAction() { return { threadId: 'no-report', events: [], text: 'Private question?' } as unknown as WorkerReply; } }) });
  assert.equal(retry.status, 'incomplete'); assert.ok(!JSON.stringify(retry).includes('Private question'));
});

test('failed implementation checks are automatically repaired and too-large bound is incomplete', async t => {
  const f = fixture(t); let injected = false;
  const result = await runQueue({ ...f.config, leaves: ['A'], maxAccepted: 2 }, { host: f.host,
    createAdapter: scripted, afterEffect: async (kind, work) => {
      if (kind === 'implementation' && !injected) {
        injected = true; writeFileSync(join((work as Work).path, 'src/a/result.mjs'), 'invalid syntax!');
      }
    } });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.accepted, ['A']);
  assert.deepEqual(result.remaining, []); assert.equal(f.records.length, 1);
});

test('review reads a large diff in pages and check output through its section', async t => {
  const f = fixture(t); let reviewed = false;
  const result = await runQueue({ ...f.config, leaves: ['A'], maxAccepted: 1 }, { host: f.host,
    afterEffect: async (kind, work) => {
      if (kind === 'implementation') writeFileSync(join((work as Work).path, 'src/a/large.txt'), 'line\n'.repeat(30_000) + 'last-marker\n');
    },
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      const call = (input: object) => options.handleTool('backlog_tool', { operation: 'context', input: input as BrokerInput }, { threadId: 'test' }) as Promise<any>;
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Review actual implementation')) {
          let page = await call({ section: 'diff' }); let diff = ''; let pages = 0;
          for (;;) {
            assert.ok(Buffer.byteLength(page.content) <= PAGE_BYTES);
            diff += page.content; pages += 1;
            if (page.nextOffset === null) break;
            page = await call({ section: 'diff', offset: page.nextOffset });
          }
          assert.ok(pages > 1); assert.ok(diff.includes('last-marker'));
          const checks = await call({ section: 'checks' });
          assert.match(JSON.parse(checks.content)[0].output, /Fixture result checks passed/u);
          assert.deepEqual(JSON.parse((await call({ section: 'findings' })).content), []);
          await assert.rejects(call({ section: 'other' }), /section/u);
          reviewed = true;
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.equal(result.status, 'limit-reached'); assert.ok(reviewed);
});

test('run_checks answers compactly and bounds a failing check', async t => {
  const f = fixture(t); let observed = false;
  const failing = { command: 'node', args: ['-e', "process.stderr.write('x'.repeat(40000)); process.exit(1)", '{coverage}'] };
  const result = await runQueue({ ...f.config, leaves: ['A'], project: { ...f.config.project, checks: [failing] } }, { host: f.host,
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Implement all approved')) {
          await assert.rejects(options.handleTool('backlog_tool', { operation: 'run_checks', input: {} as BrokerInput }, { threadId: 'test' }),
            (error: Error) => error.message.length <= 16000 && error.message.endsWith('x'));
          observed = true;
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.equal(result.status, 'incomplete'); assert.ok(observed);
});

test('run_checks shows a failing check its standard output and its notices', async t => {
  const f = fixture(t); let observed = false;
  const failing = { command: 'node', args: ['-e',
    "process.stdout.write('not ok 1 - broken test'); process.stderr.write('npm notice run'); process.exit(1)", '{coverage}'] };
  const result = await runQueue({ ...f.config, leaves: ['A'], project: { ...f.config.project, checks: [failing] } }, { host: f.host,
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Implement all approved')) {
          await assert.rejects(options.handleTool('backlog_tool', { operation: 'run_checks', input: {} as BrokerInput }, { threadId: 'test' }),
            (error: Error) => error.message.includes('not ok 1 - broken test') && error.message.includes('npm notice run'));
          observed = true;
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.equal(result.status, 'incomplete'); assert.ok(observed);
});

test('run_checks reports passing checks without their output', async t => {
  const f = fixture(t); let observed = false;
  await runQueue({ ...f.config, leaves: ['A'], maxAccepted: 1 }, { host: f.host,
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Implement all approved')) {
          const reply = await inner.startAction(prompt);
          const answer = await options.handleTool('backlog_tool', { operation: 'run_checks', input: {} as BrokerInput }, { threadId: 'test' }) as { checks: object[] };
          assert.ok(answer.checks.length); assert.ok(answer.checks.every(row => !('output' in row)));
          observed = true;
          return reply;
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.ok(observed);
});

test('the plan session is told that later-stage refusals are not blockers', async t => {
  const f = fixture(t); let planPrompt = '';
  await runQueue({ ...f.config, leaves: ['A'], maxAccepted: 1 }, { host: f.host,
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Create proposal.md')) planPrompt = prompt;
        return inner.startAction(prompt);
      } };
    } });
  assert.match(planPrompt, /not a blocker/u);
  assert.match(planPrompt, /outcome_report with outcome ready/u);
});

test('state inside primary checkout is rejected before effects', async t => {
  const f = fixture(t);
  await assert.rejects(runQueue({ ...f.config, stateDirectory: join(f.root, '.git/state') },
    { host: f.host, createAdapter: scripted }), /outside the primary/u);
  assert.equal(f.records.length, 0);
});


test('implementation review repairs an in-scope finding and preserves immutable evidence', async t => {
  const f = fixture(t); let injected = false;
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: scripted, afterEffect: async (kind, work) => {
      if (kind === 'implementation' && !injected) {
        injected = true; writeFileSync(join((work as Work).path, 'src/a/result.mjs'),
          'export function next(n) { if (typeof n !== "number") throw new TypeError(); return n + 1; }\n');
      }
    } });
  assert.equal(result.status, 'exhausted');
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.ok(state.completed.A.reviews.some((row: ReviewRecord) => row.outcome === 'changes-required'));
  assert.equal(state.completed.A.review.outcome, 'accepted');
});

test('acceptance validates historical output and rejects altered receipt provenance', async t => {
  const f = fixture(t);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'exhausted');
  const integrator = join(f.base, 'integrator');
  writeFileSync(join(integrator, 'src/a/result.mjs'), 'export const laterVersion = true;\n');
  git(integrator, 'add', '.'); git(integrator, 'commit', '-m', 'feat(fixture-tools): later independent change');
  git(integrator, 'push', 'origin', `HEAD:${f.project.target}`);
  const same = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted });
  assert.equal(same.status, 'exhausted'); assert.equal(f.records.length, 1);
  const path = join(integrator, f.project.receipts, 'A.json');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n');
  git(integrator, 'add', '.'); git(integrator, 'commit', '-m', 'test(fixture-tools): alter receipt');
  git(integrator, 'push', 'origin', `HEAD:${f.project.target}`);
  await assert.rejects(runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted }), /provenance/u);
});

test(`${process.env.OUTCOME_TEST_HARNESS ?? 'codex'}: real portable copy accepts a second project without source edits`, {
  skip: process.env.LIVE_OUTCOME_PORTABLE !== '1', timeout: 600000,
}, async t => {
  const f = fixture(t, { second: true }); realHarness(f.config); const distribution = join(f.base, 'portable');
  cpSync('src', distribution, { recursive: true });
  const { runQueue: copied } = await import(pathToFileURL(join(distribution, 'runner.ts')).href);
  const portable = withPassingOpenspec(copied);
  const result = await portable({ ...f.config, leaves: ['A'] }, { host: f.host });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(f.records[0].state, 'MERGED');
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  t.diagnostic(JSON.stringify({ harness: f.config.harness, model: f.config.model, effort: f.config.effort, result, target: f.project.target, queue: f.project.queue,
    checks: state.completed.A.checks, fixture: f.base }));
});


test('standalone CLI keeps raw startup errors in private diagnostics', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/outcome-runner.ts', import.meta.url)),
    join(f.base, 'missing-config')], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(f.base, 'cli-ledger') } });
  assert.equal(child.status, 4);
  const result = JSON.parse(child.stdout); assert.equal(result.reason, 'startup-or-run-failed');
  const diagnostic = JSON.parse(readFileSync(result.diagnostics, 'utf8'));
  assert.match(diagnostic.message, /ENOENT/u);
  t.after(() => rmSync(join(result.diagnostics, '..'), { recursive: true, force: true }));
});

test('nested project tests really execute and failures cannot become successful checks', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'intentional.test.mjs'), 'throw new Error("Expected scoped test failure");\n');
  assert.throws(() => command(f.root, process.execPath, ['--test', 'intentional.test.mjs']), /failed/u);
  writeFileSync(join(f.root, 'intentional.test.mjs'), 'import assert from "node:assert/strict"; assert.equal(1,1);\n');
  assert.match(command(f.root, process.execPath, ['--test', 'intentional.test.mjs']), /pass 1/u);
});

for (const fault of ['closed', 'missing', 'changed-head']) {
  test(`external PR ${fault} blocks acceptance without another PR or merge`, async t => {
    const f = fixture(t); const create = f.host.create; const find = f.host.find;
    let created = false; let merged = false;
    f.host.create = work => {
      created = true; const pr = create(work);
      if (fault === 'closed') pr.state = 'CLOSED';
      if (fault === 'changed-head') pr.headRefOid = '0'.repeat(40);
      return pr;
    };
    f.host.find = branch => fault === 'missing' && created ? null : find(branch);
    f.host.merge = () => { merged = true; throw new Error('Unexpected merge'); };
    const result = await runQueue({ ...f.config, leaves: ['A'] },
      { host: f.host, createAdapter: scripted });
    assert.equal(result.status, 'incomplete'); assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.remaining, ['A']); assert.equal(f.records.length, 1);
    assert.equal(merged, false);
    const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
    assert.match(state.blocked.A.reason, fault === 'closed' ? /closed/u :
      fault === 'missing' ? /PR missing/u : /head or target changed/u);
    assert.equal(git(f.root, 'ls-tree', '-r', '--name-only', 'origin/proposal', '--',
      'docs/work-queue/receipts/A.json'), '');
  });
}

test('published PR and receipt omit private review and check output', async t => {
  const f = fixture(t); const create = f.host.create; let body!: string;
  const marker = 'May I ask for your permission?';
  f.host.create = (work, path) => { body = readFileSync(path!, 'utf8'); return create(work); };
  const adapter = (options: ScriptedOptions) => scripted({ ...options, handleTool: (name, input) => {
    if (name === 'outcome_report') input = { ...input, summary: marker };
    if (name === 'backlog_tool' && input.operation === 'write_file' &&
        input.input!.path.endsWith('result.test.mjs')) {
      input = { ...input, input: { ...input.input!,
        content: input.input!.content! + `console.log(${JSON.stringify(marker)});\n` } };
    }
    return options.handleTool(name, input);
  } });
  const result = await runQueue({ ...f.config, leaves: ['A'] },
    { host: f.host, createAdapter: adapter });
  assert.equal(result.status, 'exhausted');
  const receipt = git(f.root, 'show', 'origin/proposal:docs/work-queue/receipts/A.json');
  assert.ok(!body.includes(marker), 'PR body must not publish private text');
  assert.ok(!receipt.includes(marker), 'Receipt must not publish private text');
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.completed.A.review.summary, marker);
  assert.ok(state.completed.A.checks.some((check: CheckRecord) => check.output!.includes(marker)));
  assert.equal(JSON.parse(receipt).review.accepted, true);
  assert.ok(body.includes('scripted-unit-session'));
});

test('rejected model change after completion preserves released ownership for a fresh invocation', async t => {
  const f = fixture(t);
  const config = { ...f.config, leaves: ['A'] };
  assert.equal((await runQueue(config, { host: f.host, createAdapter: scripted })).status, 'exhausted');
  const ownerPath = invocationLockFiles(realpathSync(f.root), f.config.stateDirectory).ownership;
  const before = readFileSync(ownerPath, 'utf8');
  const stateBefore = readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8');
  assert.equal(JSON.parse(before).released, true);
  await assert.rejects(runQueue({ ...config, model: 'claude-sonnet-5-5' },
    { host: f.host, createAdapter: scripted }), /incompatible/u);
  assert.equal(readFileSync(ownerPath, 'utf8'), before);
  assert.equal(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'), stateBefore);
  const result = await runQueue({ ...f.config, leaves: ['B'], invocation: 'fresh',
    stateDirectory: join(f.base, 'fresh-state') }, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'exhausted'); assert.deepEqual(result.accepted, ['B']);
  assert.equal(f.records.length, 2);
});

function machine(f: Fixture, name: string) {
  const home = join(f.base, name); mkdirSync(home);
  const root = join(home, 'project'); git(home, 'clone', join(f.base, 'origin.git'), root);
  git(root, 'config', 'user.name', `Fixture ${name}`); git(root, 'config', 'user.email', 'machine@example.invalid');
  return { ...f.config, root, stateDirectory: join(home, 'state') };
}

function advanceTarget(f: Fixture, path: string, name: string) {
  const clone = join(f.base, `advance-${name}`); git(f.base, 'clone', '-b', f.project.target, join(f.base, 'origin.git'), clone);
  git(clone, 'config', 'user.name', 'Fixture Advance'); git(clone, 'config', 'user.email', 'advance@example.invalid');
  mkdirSync(join(clone, path, '..'), { recursive: true }); writeFileSync(join(clone, path), `${name}\n`);
  git(clone, 'add', '.'); git(clone, 'commit', '-m', `test(fixture-tools): advance ${name}`);
  git(clone, 'push', 'origin', `HEAD:${f.project.target}`);
}

const ledgerCommits = (f: Fixture) => git(join(f.base, 'origin.git'), 'rev-list', '--count', 'work-queue-claims-proposal');
const claimAt = (f: Fixture, id: string) => JSON.parse(git(join(f.base, 'origin.git'), 'show', `work-queue-claims-proposal:${id}.json`));
const blockedReason = (result: RunResult) => JSON.parse(readFileSync(result.blockers!.A.diagnostics!, 'utf8')).blocked.A.reason;

test('two machines take different tasks and integrate each other results', async t => {
  const f = fixture(t); const first = machine(f, 'one'); const second = machine(f, 'two');
  let parallel!: RunResult;
  const result = await runQueue({ ...first, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => {
      if (kind !== 'claim') return;
      assert.equal(claimAt(f, 'A').branch.startsWith('outcome/A-'), true);
      parallel = await runQueue({ ...second, leaves: ['A', 'D'] }, { host: f.host, createAdapter: scripted });
    } });
  // The second machine accepts D, then waits for the first machine's claim of A until its first poll cancels it.
  assert.equal(parallel.status, 'cancelled', JSON.stringify(parallel));
  assert.deepEqual(parallel.accepted, ['D']); assert.equal(parallel.blockers!.A.kind, 'waiting-for-claim');
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(f.records.filter(pr => pr.branch!.startsWith('outcome/A-')).length, 1);
  assert.equal(git(first.root, 'status', '--porcelain'), '');
});

test('a foreign claim on another task does not block a task with overlapping scopes', async t => {
  const f = fixture(t); const other = machine(f, 'other');
  const overlapping = structuredClone(f.queue);
  overlapping.tasks.find(task => task.id === 'D')!.scopes = ['src/d', 'src/a/nested'];
  const ledger = new ClaimLedger(other.root, 'proposal');
  assert.equal(ledger.acquire(ledger.pull(), { version: 1, id: 'A', scopes: ['src/a'], claimant: 'foreign', host: 'other' }, 'chore: claim A'), true);
  writeFileSync(join(f.root, f.project.queue), JSON.stringify(overlapping));
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'test(fixture-tools): overlap scopes');
  git(f.root, 'push', 'origin', 'HEAD:proposal');
  const result = await runQueue({ ...f.config, leaves: ['D'], authority: { ...f.config.authority,
    tasks: { D: hash(overlapping.tasks.find(task => task.id === 'D')) } } }, { host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['D']); assert.equal(f.records.length, 1);
});

test('a lost claim race is not forced and the winner stays recorded', t => {
  const f = fixture(t); const one = machine(f, 'one'); const two = machine(f, 'two');
  const winner = new ClaimLedger(one.root, 'proposal'); const loser = new ClaimLedger(two.root, 'proposal');
  const claim = (id: string, claimant: string) => ({ version: 1, id, scopes: [`src/${id}`], claimant, host: claimant });
  const stale = loser.pull(); const fresh = winner.pull();
  assert.equal(winner.acquire(fresh, claim('A', 'winner'), 'chore: claim A'), true);
  assert.equal(loser.acquire(stale, claim('A', 'loser'), 'chore: claim A'), false);
  assert.equal(claimAt(f, 'A').claimant, 'winner');
  const retried = loser.pull();
  assert.equal(retried.claims.get('A')!.claimant, 'winner');
  assert.equal(loser.acquire(retried, claim('B', 'loser'), 'chore: claim B'), true);
  assert.equal(claimAt(f, 'A').claimant, 'winner'); assert.equal(claimAt(f, 'B').claimant, 'loser');
});

test('a claim that cannot be pushed stops the run before any work', async t => {
  const f = fixture(t); const hook = join(f.base, 'origin.git', 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const adapter = () => { throw new Error('Worker must not start'); };
  await assert.rejects(runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: adapter }), /git/u);
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(join(f.base, 'origin.git'), 'for-each-ref', 'refs/heads/work-queue-claims-proposal'), '');
});

test('restart keeps the existing claim without another ledger commit', async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted, afterEffect: async kind => {
    if (kind === 'claim') throw Object.assign(new Error('Interrupted'), { interrupted: true });
  } }), /Interrupted/u);
  assert.equal(ledgerCommits(f), '1');
  assert.equal((await runQueue(config, { host: f.host, createAdapter: scripted })).status, 'exhausted');
  assert.equal(ledgerCommits(f), '1');
});

test('a claim lost after push is resumed by the same durable claimant', async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  const store = new RunStore(config.stateDirectory, invocationIdentity({ ...config, coverage: 85, root: realpathSync(f.root),
    leaves: ['A'] }), { repositoryRoot: f.root });
  store.update({ claimant: 'durable' }); store.close();
  const ledger = new ClaimLedger(f.root, 'proposal');
  ledger.acquire(ledger.pull(), { version: 1, id: 'A', scopes: ['src/a'], claimant: 'durable', host: 'h',
    taskHash: hash(f.queue.tasks[0]), claimedAt: '2026-01-01T00:00:00Z',
    branch: `outcome/A-${hash({ invocation: config.invocation, id: 'A', authority: config.authority.reference }).slice(0, 12)}` }, 'chore: claim A');
  assert.equal((await runQueue(config, { host: f.host, createAdapter: scripted })).status, 'exhausted');
  assert.equal(ledgerCommits(f), '1');
});

test('an unrelated target advance before publish is merged and rechecked', async t => {
  const f = fixture(t);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => { if (kind === 'implementation') advanceTarget(f, 'unrelated/one.txt', 'one'); } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(git(f.root, 'show', 'origin/proposal:unrelated/one.txt'));
});

test('an unrelated target advance before merge returns to publish', async t => {
  const f = fixture(t); const find = f.host.find;
  f.host.find = branch => {
    const pr = find(branch);
    if (pr) pr.headRefOid = git(join(f.base, 'origin.git'), 'rev-parse', `refs/heads/${branch}`);
    return pr;
  };
  let advanced = false;
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => {
      if (kind === 'pr' && !advanced) { advanced = true; advanceTarget(f, 'unrelated/two.txt', 'two'); }
    } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(f.records.length, 1);
});

test('a target advance inside the outcome scope to a file the task did not change is merged without reviews', async t => {
  const f = fixture(t);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => { if (kind === 'implementation') advanceTarget(f, 'src/a/foreign.txt', 'scope'); } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(f.records.length, 1);
  assert.equal(git(f.root, 'show', 'origin/proposal:src/a/foreign.txt'), 'scope');
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.completed.A.integrations, undefined);
});

test('coverage startup failures are private, exit 4 and allocate nothing', async t => {
  const f = fixture(t);
  const { root: _root, stateDirectory: _state, ...invocation } = f.config;
  const path = join(f.base, 'invocation.json');
  const cases: { coverage?: unknown; args?: string[]; project?: Project; message: RegExp }[] = [
    ...[0, 101, 85.5, 'abc', '90', null, true].map(coverage => ({ coverage, message: /Invalid coverage/u })),
    ...['0', '101', '85.5', 'abc', '85oops', 'Infinity'].map(value =>
      ({ args: [`--coverage=${value}`], message: /Invalid coverage/u })),
    ...[['--coverage='], ['--coverage=90', '--coverage=91']].map(args => ({ args, message: /coverage/u })),
    ...[
      { checks: [] },
      { checks: [{ command: 'node', args: ['--test'] }] },
      { checks: [{ command: 'node', args: ['--test'] }], planningCheck: { command: 'node', args: ['{coverage}'] } },
      { checks: [{ command: 'node', args: ['--test'] }], setup: [{ command: 'node', args: ['{coverage}'] }] },
      { checks: [{ command: '{coverage}', args: [] }] },
    ].map(patch => ({ project: { ...f.project, ...patch }, message: /A coverage gate check is required/u })),
  ];
  for (const entry of cases) {
    const { args = [], message, ...patch } = entry;
    writeFileSync(path, JSON.stringify({ ...invocation, ...patch }));
    let output = '';
    assert.equal(await main(path, runQueue, line => { output += line; },
      { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'private-state') }, args }), 4);
    const diagnostic = JSON.parse(output).diagnostics as string;
    assert.match(JSON.parse(readFileSync(diagnostic, 'utf8')).message, message);
    assert.ok(!output.includes('Invalid coverage'));
    assert.ok(!output.includes('coverage gate check'));
    rmSync(join(diagnostic, '..'), { recursive: true, force: true });
    assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
    assert.equal(existsSync(join(f.base, 'private-state')), false);
    assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(git(join(f.base, 'origin.git'), 'for-each-ref', 'refs/heads/work-queue-claims-proposal'), '');
  }
  for (const coverage of [0, 101, 85.5, 'abc', '90', null, true, NaN, Infinity]) {
    await assert.rejects(runQueue({ ...f.config, coverage } as RunConfig), /Invalid coverage/u);
  }
  await assert.rejects(runQueue({ ...f.config, project: { ...f.project, checks: [{ command: 'node', args: [] }] } }),
    /A coverage gate check is required/u);
  assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
});

test('coverage is expanded in every check execution and stated across purposes and repair', async t => {
  const f = fixture(t); const prompts: string[] = []; let repair = false;
  const marker = '{coverage}:{coverage}:{change}:{target}:{scope}';
  const expected = '92:92:counter-a:proposal:src/a';
  f.project.checks.push({ command: 'node', args: ['-e',
    `if (process.argv[1] !== ${JSON.stringify(expected)}) process.exit(1); console.log(process.argv[1]);`, marker] });
  const result = await runQueue({ ...f.config, leaves: ['A'], coverage: 92 }, { host: f.host,
    createAdapter: options => {
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes('Review actual implementation') && !repair) {
          repair = true;
          await options.handleTool('outcome_report', { outcome: 'changes-required', summary: 'Exercise repair', findings: ['Recheck implementation.'] }, {} as ToolContext);
          return { threadId: 'coverage-review', events: [], text: '' } as unknown as WorkerReply;
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(repair); assert.ok(prompts.length >= 7);
  for (const prompt of prompts) assert.match(prompt, /Resolved coverage threshold: 92%\./u);
  for (const stage of ['Inspect current files', 'Create proposal.md', 'Implement all approved', 'Review actual implementation']) {
    assert.ok(prompts.some(prompt => prompt.includes(stage)));
  }
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  for (const records of [state.completed.A.checks, state.completed.A.finalChecks]) {
    assert.ok(records.some((check: CheckRecord) => check.args.includes('--test-coverage-lines=92')));
    assert.ok(records.some((check: CheckRecord) => check.args.includes(expected) && check.output!.includes(expected)));
    assert.ok(records.every((check: CheckRecord) => !check.args.some(arg => arg.includes('{coverage}'))));
  }
});

test('coverage restart preserves frozen state and ownership and accepts equivalent default', async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted, afterEffect: async kind => {
    if (kind === 'claim') throw Object.assign(new Error('Interrupted'), { interrupted: true });
  } }), /Interrupted/u);
  const statePath = join(config.stateDirectory, 'state.json');
  const ownerPath = invocationLockFiles(realpathSync(f.root), config.stateDirectory).ownership;
  const state = readFileSync(statePath, 'utf8'); const owner = readFileSync(ownerPath, 'utf8');
  const { root: _root, stateDirectory: _state, ...invocation } = config;
  const path = join(f.base, 'invocation.json'); writeFileSync(path, JSON.stringify({ ...invocation, coverage: 90 }));
  let output = '';
  assert.equal(await main(path, candidate => runQueue({ ...candidate, stateDirectory: config.stateDirectory },
    { host: f.host, createAdapter: scripted }), line => { output += line; }, { cwd: f.root }), 4);
  const diagnostic = JSON.parse(output).diagnostics as string;
  // The ownership file of the same state directory leaves identity compatibility to the run store.
  assert.match(readFileSync(diagnostic, 'utf8'), /Run state is incompatible/u);
  rmSync(join(diagnostic, '..'), { recursive: true, force: true });
  assert.equal(readFileSync(statePath, 'utf8'), state);
  assert.equal(readFileSync(ownerPath, 'utf8'), owner);
  const prompts: string[] = [];
  assert.equal((await runQueue({ ...config, coverage: 85 }, { host: f.host, createAdapter: options => {
    const inner = scripted(options as ScriptedOptions);
    return { ...inner, async startAction(prompt: string) { prompts.push(prompt); return inner.startAction(prompt); } };
  } })).status, 'exhausted');
  assert.ok(prompts.length);
  for (const prompt of prompts) assert.match(prompt, /Resolved coverage threshold: 85%\./u);
});

for (const scenario of ['converges', 'final', 'exhausts', 'foreign', 'moves', 'missing-ref', 'read-failure',
  'target-race', 'local-mutation', 'target-during-wait', 'closed', 'missing-pr'] as const) {
  test(`runner stale head: ${scenario}`, async t => {
    const f = fixture(t);
    const previousHead = git(f.root, 'rev-parse', 'HEAD');
    const find = f.host.find; const merge = f.host.merge;
    let published = false; let views = 0; let merges = 0; let delays = 0;
    let oldHead = ''; let waitSnapshot = ''; let reset = false;
    const snapshot = () => {
      const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
      return JSON.stringify({ refs: git(join(f.base, 'origin.git'), 'show-ref'),
        head: git(state.current.path, 'rev-parse', 'HEAD'), checks: state.current.finalChecks,
        prs: f.records.length });
    };
    f.host.find = branch => {
      const pr = find(branch);
      if (!pr || !published) return pr;
      const stage = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8')).current.stage;
      if (stage !== 'merge') return pr;
      // After the merge, a lookup recovers PR metadata for acceptance; it is not a merge view.
      if (merges) return pr;
      const actual = scenario === 'missing-ref' ? oldHead : git(join(f.base, 'origin.git'), 'rev-parse', `refs/heads/${branch}`);
      // The first merge view observes the advanced target before the new publish.
      if (scenario === 'target-race' && actual === oldHead) return { ...pr };
      views += 1;
      if (scenario === 'missing-pr' && views === 2) return null;
      const convergeAt = scenario === 'final' ? 100 : 4;
      const headRefOid = scenario === 'exhausts' || views < convergeAt ? (scenario === 'target-race' ? oldHead : previousHead) : actual;
      pr.headRefOid = actual;
      return { ...pr, headRefOid, state: scenario === 'closed' && views === 2 ? 'CLOSED' : pr.state };
    };
    f.host.merge = (pr, head) => {
      merges += 1;
      assert.equal(head, git(join(f.base, 'origin.git'), 'rev-parse', `refs/heads/${pr.branch}`));
      merge(pr, head);
    };
    const pending = runQueue({ ...f.config, leaves: ['A'] }, {
      host: f.host, createAdapter: scripted,
      afterEffect: async kind => {
        if (kind !== 'pr') return;
        published = true; oldHead = f.records[0].headRefOid;
        if (scenario === 'target-race') advanceTarget(f, 'unrelated/stale.txt', 'race');
        if (scenario === 'foreign') git(join(f.base, 'origin.git'), 'update-ref',
          `refs/heads/${f.records[0].branch}`, git(f.root, 'rev-parse', 'HEAD'));
        if (scenario === 'missing-ref') git(join(f.base, 'origin.git'), 'update-ref', '-d',
          `refs/heads/${f.records[0].branch}`);
      },
      mergePolling: { views: scenario === 'final' ? undefined : 5, delay: async ms => {
        assert.equal(ms, 3000); delays += 1;
        if (waitSnapshot && !reset) assert.equal(snapshot(), waitSnapshot);
        waitSnapshot = snapshot(); reset = false;
        const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
        if (scenario === 'moves') {
          git(join(f.base, 'origin.git'), 'update-ref', `refs/heads/${f.records[0].branch}`,
            git(f.root, 'rev-parse', 'HEAD')); reset = true;
        }
        if (scenario === 'local-mutation') {
          git(state.current.path, 'commit', '--allow-empty', '-m', 'foreign local change'); reset = true;
        }
        if (scenario === 'read-failure') {
          git(state.current.path, 'remote', 'set-url', 'origin', join(f.base, 'absent.git')); reset = true;
        }
        if (scenario === 'target-during-wait' && delays === 1) {
          advanceTarget(f, 'unrelated/during.txt', 'during'); reset = true;
        }
      } },
    });
    if (scenario === 'read-failure') {
      // The unavailable remote also stops the controller's next target refresh.
      await assert.rejects(pending, /git fetch/u);
      const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
      assert.match(state.blocked.A.reason, /git fetch/u);
      assert.equal(merges, 0);
      return;
    }
    const result = await pending;
    const success = ['converges', 'final', 'target-race', 'target-during-wait'].includes(scenario);
    assert.equal(result.status, success ? 'exhausted' : 'incomplete', JSON.stringify(result));
    assert.equal(merges, success ? 1 : 0);
    assert.equal(f.records.length, 1);
    if (scenario === 'final') { assert.equal(views, 100); assert.equal(delays, 99); }
    if (scenario === 'exhausts') { assert.equal(views, 5); assert.equal(delays, 4); }
    if (scenario === 'converges' || scenario === 'target-race') { assert.equal(views, 4); assert.equal(delays, 3); }
    if (!success && !['closed', 'missing-pr', 'read-failure'].includes(scenario)) {
      assert.equal(blockedReason(result), 'Checked head or target changed');
    }
  });
}

for (const boundary of ['claim', 'merge']) test(`completion timing includes downtime after ${boundary} and stays frozen`, async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  const start = Date.parse('2026-01-01T00:00:00Z');
  const statePath = join(f.config.stateDirectory, 'state.json');
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted, now: () => start,
    afterEffect: async kind => {
      if (kind === boundary) throw Object.assign(new Error('Interrupted'), { interrupted: true });
    } }), /Interrupted/u);
  assert.equal(state().current.claimedAt, new Date(start).toISOString());
  // Model unfinished work written by an older runner. Restore its time from the owned ledger.
  const legacy = state(); delete legacy.current.claimedAt;
  writeFileSync(statePath, JSON.stringify(legacy));
  const events: RunEvent[] = [];
  const result = await runQueue(config, { host: f.host, createAdapter: scripted, now: () => start + 4325999,
    report: event => {
      events.push(event);
      if (event.status === 'accepted') {
        assert.equal(state().current, null);
        assert.equal(state().completed.A.acceptedAt, new Date(start + 4325999).toISOString());
        assert.equal(state().completed.A.completion.summary, event.summary);
      }
    } });
  const expected = { summary: 'The counter now increments finite numbers. Invalid inputs are rejected. ' +
    'The task took 1h 12m 5s from claim to acceptance and has complexity grade E.', durationSeconds: 4325, grade: 'E' };
  assert.deepEqual(result.accepted, ['A']);
  assert.deepEqual(result.completions, { A: expected });
  assert.deepEqual(events, [{ status: 'accepted', id: 'A', ...expected }]);
  assert.equal(state().completed.A.claimedAt, new Date(start).toISOString());
  const repeatEvents: RunEvent[] = [];
  const repeat = await runQueue(config, { host: f.host, createAdapter: scripted,
    now: () => start + 999999999, report: event => repeatEvents.push(event) });
  assert.deepEqual(repeat, result); assert.deepEqual(repeatEvents, []);
});

for (const invalid of ['missing', 'grade']) test(`accepted implementation review refuses ${invalid} completion before receipt`, async t => {
  const f = fixture(t);
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: options => scripted({ ...options, handleTool: async (name, input) => {
      if (name === 'outcome_report' && input.completion) {
        input = { ...input };
        if (invalid === 'missing') delete input.completion;
        else input.completion = { summary: 'Changed behavior. Added tests.', grade: 'F' } as unknown as ToolInput['completion'];
      }
      return options.handleTool(name, input, { threadId: 'test' });
    } }) });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.accepted, []); assert.deepEqual(result.completions, {});
  assert.equal(f.records.length, 0);
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.blocked.A.work.stage, 'work');
  assert.match(state.blocked.A.reason, /Invalid private report/u);
  assert.equal(existsSync(join(state.blocked.A.work.path, f.project.receipts, 'A.json')), false);
});

test('report schema, optional reports and review prompts enforce the completion contract', async t => {
  const f = fixture(t); let reviewed = false;
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: options => {
      const schema = options.tools.find(tool => tool.name === 'outcome_report')!.inputSchema as {
        required: string[]; properties: { completion: { required: string[]; properties: { grade: { enum: string[] } } } };
      };
      assert.ok(!schema.required.includes('completion'));
      assert.deepEqual(schema.properties.completion.required, ['summary', 'grade']);
      assert.deepEqual(schema.properties.completion.properties.grade.enum, ['A', 'B', 'C', 'D', 'E']);
      const inner = scripted(options as ScriptedOptions);
      return { ...inner, async startAction(prompt: string) {
        if (prompt.includes('Review actual implementation')) {
          assert.match(prompt, /two or three English sentences/u);
          assert.match(prompt, /whole-task complexity: A \(most complex\), B, C, D, E \(easiest\)/u);
          assert.match(prompt, /not correctness, quality or execution speed/u);
          const call = (completion: unknown) => options.handleTool('outcome_report',
            { outcome: 'accepted', summary: 'Private diagnostic summary', findings: [], completion } as ToolInput,
            { threadId: 'test' });
          for (const completion of [null, [], 3, {}, { summary: 'Text' }, { grade: 'A' },
            { summary: 3, grade: 'A' }, { summary: '  ', grade: 'A' }, { summary: 'Text', grade: 'F' }]) {
            await assert.rejects(call(completion), /Invalid private report/u);
          }
          for (const grade of ['A', 'B', 'C', 'D', 'E']) {
            await call({ summary: 'Valid change summary. Tests cover it.', grade });
          }
          // Nonaccepted implementation reviews can omit completion.
          await options.handleTool('outcome_report', { outcome: 'changes-required', summary: 'Private diagnostic',
            findings: ['Repair this.'] }, { threadId: 'test' });
          reviewed = true;
        } else if (prompt.includes('Review planning artifacts')) {
          // Supplied malformed completion is invalid even when optional.
          await assert.rejects(options.handleTool('outcome_report', { outcome: 'accepted', summary: 'Planning',
            findings: [], completion: null } as unknown as ToolInput, { threadId: 'test' }), /Invalid private report/u);
        }
        return inner.startAction(prompt);
      } };
    } });
  assert.equal(result.status, 'exhausted'); assert.ok(reviewed);
  assert.match(result.completions.A.summary, /^The counter now/u);
  assert.ok(!JSON.stringify(result).includes('Private diagnostic'));
});

test('claim-to-state gap reuses the matching ledger claim time', async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  const start = Date.parse('2026-01-01T00:00:00Z');
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted, now: () => start,
    afterEffect: async kind => {
      if (kind === 'claim') throw Object.assign(new Error('Interrupted'), { interrupted: true });
    } }), /Interrupted/u);
  const path = join(f.config.stateDirectory, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.current = null;
  writeFileSync(path, JSON.stringify(state));
  const result = await runQueue(config, { host: f.host, createAdapter: scripted, now: () => start + 10000 });
  assert.equal(result.status, 'exhausted'); assert.equal(result.completions.A.durationSeconds, 10);
});

test('unrecoverable old claim time stays private and cannot invent completion', async t => {
  const f = fixture(t); const config = { ...f.config, leaves: ['A'] };
  await assert.rejects(runQueue(config, { host: f.host, createAdapter: scripted,
    afterEffect: async kind => {
      if (kind === 'claim') throw Object.assign(new Error('Interrupted'), { interrupted: true });
    } }), /Interrupted/u);
  const path = join(f.config.stateDirectory, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')); delete state.current.claimedAt;
  writeFileSync(path, JSON.stringify(state));
  const pull = ClaimLedger.prototype.pull;
  try {
    ClaimLedger.prototype.pull = function () {
      const snapshot = pull.call(this);
      delete snapshot.claims.get('A')!.claimedAt;
      return snapshot;
    };
    const result = await runQueue(config, { host: f.host, createAdapter: scripted });
    assert.equal(result.status, 'incomplete'); assert.deepEqual(result.completions, {});
    assert.ok(!JSON.stringify(result).includes('Cannot recover'));
    const blocked = JSON.parse(readFileSync(path, 'utf8')).blocked.A;
    assert.match(blocked.reason, /Cannot recover original claim timestamp/u);
  } finally { ClaimLedger.prototype.pull = pull; }
});

test('multiple task completions survive cancellation and later exhausted results', async t => {
  const f = fixture(t); const events: RunEvent[] = []; let milliseconds = 0;
  const first = await runQueue(f.config, { host: f.host, createAdapter: scripted,
    now: () => Date.parse('2026-01-01') + (milliseconds += 1000), report: event => {
      events.push(event);
      if (event.status === 'accepted' && event.id === 'B') process.emit('SIGINT');
    } });
  assert.equal(first.status, 'cancelled'); assert.deepEqual(first.accepted, ['A', 'B']);
  assert.deepEqual(Object.keys(first.completions), ['A', 'B']);
  for (const event of events.filter(event => event.status === 'accepted')) {
    const { status, id, ...completion } = event;
    assert.deepEqual(first.completions[id], completion);
  }
  const resumed = await runQueue(f.config, { host: f.host, createAdapter: scripted });
  assert.equal(resumed.status, 'exhausted');
  assert.deepEqual(Object.keys(resumed.completions), ['A', 'B', 'C', 'D']);
  assert.deepEqual(resumed.completions.A, first.completions.A);
  assert.deepEqual(resumed.completions.B, first.completions.B);
});

test('public completion uses the final review after repair and preserves three sentences', async t => {
  const f = fixture(t); let implementationReviews = 0;
  const summary = 'The counter increments finite numbers. Invalid inputs now throw. Tests exercise the behavior.';
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { host: f.host,
    createAdapter: options => scripted({ ...options, handleTool: async (name, input) => {
      if (name === 'outcome_report' && input.outcome === 'accepted') {
        input = { ...input, summary: 'Private top-level review information' };
        if (input.completion) {
          implementationReviews += 1;
          if (implementationReviews === 1) input = { ...input, outcome: 'changes-required',
            findings: ['Private repair details'], completion: { summary: 'Obsolete summary. Needs repair.', grade: 'A' } };
          else input.completion = { summary, grade: 'D' };
        } else input.completion = { summary: 'Planning only. Do not publish.', grade: 'C' };
      }
      return options.handleTool(name, input, { threadId: 'test' });
    } }) });
  assert.equal(result.status, 'exhausted'); assert.equal(implementationReviews, 2);
  assert.match(result.completions.A.summary, new RegExp('^' + summary.replaceAll('.', '\\.')));
  assert.equal(result.completions.A.summary.split('.').filter(part => part.trim()).length, 4);
  assert.equal(result.completions.A.grade, 'D');
  assert.ok(!JSON.stringify(result).includes('Private'));
  assert.ok(!JSON.stringify(result).includes('Planning only'));
  const receipt = JSON.parse(git(f.root, 'show', `origin/${f.project.target}:${f.project.receipts}/A.json`));
  for (const key of ['completion', 'summary', 'durationSeconds', 'grade', 'claimedAt', 'acceptedAt']) {
    assert.ok(!(key in receipt));
  }
  assert.ok(!('completion' in receipt.review));
});

test('C: ledger records accepted and blocked work with durable repair metrics and allowlisted final evidence', async t => {
  const f = fixture(t); const env = { XDG_STATE_HOME: join(f.base, 'ledger-state') };
  const { root: _root, stateDirectory: _state, ...invocation } = { ...f.config, leaves: ['A', 'D'] };
  const path = join(f.base, 'ledger-invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const stdout: RunEvent[] = []; let planningReviews = 0; let implementationReviews = 0;
  const create = f.host.create;
  f.host.create = work => ({ ...create(work), url: 'https://example.org/pull/1' });
  const code = await ledgerMain(path, (config, options) => runQueue({ ...config, stateDirectory: f.config.stateDirectory }, {
    ...options, host: f.host, createAdapter: adapterOptions => {
      let prompt = '';
      const adapter = scripted({ ...adapterOptions, handleTool: async (name, input) => {
        if (name === 'outcome_report' && input.outcome === 'accepted') {
          if (prompt.includes('Review planning artifacts') && ++planningReviews === 1 ||
              prompt.includes('Review actual implementation') && ++implementationReviews === 1) {
            input = { ...input, outcome: 'changes-required', summary: 'SECRET_PRIVATE_REPORT', findings: ['SECRET_FINDING'] };
          }
        }
        return adapterOptions.handleTool(name, input, { threadId: 'ledger-fixture' });
      } });
      return { ...adapter, async startAction(text) {
        prompt = text;
        adapterOptions.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
        adapterOptions.onUsage?.({ inputTokens: 4, outputTokens: 5, totalTokens: 9 });
        if (text.includes('Task D;')) throw new Error('SECRET_WORKER_FAILURE');
        return adapter.startAction(text);
      } };
    },
  }), line => stdout.push(JSON.parse(line)), { cwd: f.root, env });
  assert.equal(code, 3);
  const record = JSON.parse(readFileSync(ledgerPath(env), 'utf8')) as RunStatistics;
  assert.equal(record.status, 'incomplete'); assert.deepEqual(record.settings.leaves, { value: ['A', 'D'], source: 'invocation-json' });
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.deepEqual(record.tasks.map(task => [task.id, task.outcome]), [['A', 'accepted'], ['D', 'blocked']]);
  const [accepted, blocked] = record.tasks;
  assert.equal(accepted.lastStage, 'merge'); assert.equal(accepted.blockingReason, null);
  assert.equal(accepted.durationSeconds, state.completed.A.completion.durationSeconds);
  assert.equal(accepted.completionSummary, state.completed.A.completion.summary);
  assert.equal(accepted.complexityGrade, state.completed.A.completion.grade);
  assert.deepEqual(accepted.workerSessions, { investigate: 1, plan: 2, work: 2, review: 4 });
  assert.equal(accepted.planningReviewRounds, 2); assert.equal(accepted.implementationReviewRounds, 2);
  assert.deepEqual(accepted.planningFindingsPerRound, [1, 0]);
  assert.deepEqual(accepted.implementationFindingsPerRound, [1, 0]);
  assert.equal(accepted.finalChecks.length, f.project.checks.length);
  assert.ok(accepted.finalChecks.every(check => check.outcome === 'passed' && !('output' in check)));
  assert.deepEqual(accepted.pr, { number: 1, url: 'https://example.org/pull/1' });
  // Eleven sessions: investigation, two plans, two planning reviews, two works, two implementation reviews,
  // one documentation session and one documentation review.
  assert.deepEqual(accepted.tokenUsage, { inputTokens: 44, outputTokens: 55, totalTokens: 99 });
  assert.equal(blocked.lastStage, 'investigate'); assert.equal(blocked.blockingReason, 'operation-incomplete');
  assert.equal(blocked.durationSeconds, null); assert.equal(blocked.complexityGrade, null); assert.equal(blocked.completionSummary, null);
  assert.equal(blocked.workerSessions.investigate, 1); assert.equal(state.blocked.D.work.sessions, undefined);
  assert.deepEqual(record.tokenUsage, { inputTokens: 48, outputTokens: 60, totalTokens: 108 });
  assert.ok(!JSON.stringify(record).includes('SECRET_')); assert.ok(!JSON.stringify(record).includes('Private text'));
  assert.equal(stdout.at(-1)!.status, 'incomplete');
});

test('C: final gate failure persists the actual failed command without private output or fabricated passes', async t => {
  const f = fixture(t); const statistics = new Statistics();
  const counter = join(f.base, 'check-count');
  const privateOutput = join(f.base, 'private-output'); writeFileSync(privateOutput, 'SECRET_CHECK_OUTPUT');
  // The check passes in the work session, after it and after documentation, then fails in the final gate.
  const script = "const f=require('node:fs'),p=process.argv[1];const n=f.existsSync(p)?Number(f.readFileSync(p)):0;" +
    "f.writeFileSync(p,String(n+1));if(n>=3){console.log(f.readFileSync(process.argv[2],'utf8'));process.exit(1)}";
  f.project.checks.push({ command: 'node', args: ['-e', script, counter, privateOutput] });
  const result = await runQueue({ ...f.config, leaves: ['A'] }, { statistics, host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'incomplete'); const record = statistics.finish('incomplete', 3);
  const task = record.tasks[0];
  assert.equal(task.outcome, 'blocked'); assert.equal(task.lastStage, 'publish');
  assert.equal(task.finalChecks.length, 3);
  assert.deepEqual(task.finalChecks.at(-1), { command: 'node', args: ['-e', script, counter, privateOutput], outcome: 'failed' });
  // The executable/arguments are intentional metadata; captured check output is not.
  assert.ok(task.finalChecks.every(check => !('output' in check))); assert.equal(task.pr, null);
  assert.ok(!JSON.stringify(record).includes('SECRET_CHECK_OUTPUT'));
});

test('C: foreign task claims are distinguished from dependent pending leaves', async t => {
  const f = fixture(t); const statistics = new Statistics();
  const claims = new ClaimLedger(f.root, f.project.target);
  for (const id of ['A', 'D']) {
    claims.acquire(claims.pull(), { version: 1, id, scopes: [`src/${id.toLowerCase()}`], claimant: 'foreign',
      host: 'fixture' }, `chore: claim ${id}`);
  }
  // Every remaining task waits for a foreign claim or a dependency, so the run waits until its first poll cancels it.
  const result = await runQueue(f.config, {
    statistics, host: f.host, createAdapter: () => { throw new Error('No worker expected'); },
  });
  assert.equal(result.status, 'cancelled');
  const record = statistics.finish('incomplete', 3);
  assert.deepEqual(record.tasks.map(task => [task.id, task.outcome]),
    [['A', 'claimed-elsewhere'], ['B', 'not-started'], ['C', 'not-started'], ['D', 'claimed-elsewhere']]);
  assert.ok(record.tasks.every(task => task.lastStage === null));
});

test('C: an acceptance limit records selected pending leaves and excludes baseline receipts on restart', async t => {
  const f = fixture(t); const first = new Statistics();
  const result = await runQueue({ ...f.config, maxAccepted: 1 }, { statistics: first, host: f.host, createAdapter: scripted });
  assert.equal(result.status, 'limit-reached');
  assert.deepEqual(first.finish('limit-reached', 0).tasks.map(task => [task.id, task.outcome]),
    [['A', 'accepted'], ['B', 'not-started'], ['C', 'not-started'], ['D', 'not-started']]);
  const baseline = new Statistics();
  const other = machine(f, 'baseline-ledger');
  const again = await runQueue({ ...other, leaves: ['A'] }, { statistics: baseline, host: f.host, createAdapter: scripted });
  assert.equal(again.status, 'exhausted'); assert.deepEqual(baseline.finish('exhausted', 0).tasks, []);
});

test('B: resumed execution preserves selection provenance, original claim duration and durable task history', async t => {
  const f = fixture(t); const env = { XDG_STATE_HOME: join(f.base, 'ledger-resume') };
  const { root: _root, stateDirectory: _state, harness: _harness, model: _model, effort: _effort, ...invocation } = f.config;
  const path = join(f.base, 'ledger-resume.json');
  writeFileSync(path, JSON.stringify({ ...invocation, leaves: ['A'] }));
  const create = f.host.create;
  f.host.create = work => { const pr = create(work); pr.url = 'https://example.org/pull/' + pr.number; return pr; };
  const answers = ['claude', '', 'high', '92']; let prompts = 0;
  const start = Date.parse('2026-01-01T00:00:00Z');
  const execute = (resume: boolean) => ledgerMain(path, (config, options) => runQueue({
    ...config, stateDirectory: f.config.stateDirectory,
  }, { ...options, now: () => start + (resume ? 10000 : 0), host: f.host,
    selection: { ...passingSelection, interactive: true, say: () => {}, ask: async () => {
      prompts++; assert.ok(!resume, 'saved selection must suppress prompts'); return answers.shift()!;
    } },
    createAdapter: options => {
      const adapter = scripted(options);
      return { ...adapter, async startAction(prompt: string) {
        options.onUsage?.({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
        return adapter.startAction(prompt);
      } };
    },
    afterEffect: async kind => {
      if (!resume && kind === 'pr') throw Object.assign(new Error('SECRET_INTERRUPTION'), { interrupted: true });
    },
  }), line => {
    const result = JSON.parse(line);
    if (result.diagnostics) t.after(() => rmSync(join(result.diagnostics, '..'), { recursive: true, force: true }));
  }, { cwd: f.root, env });
  assert.equal(await execute(false), 4); assert.equal(prompts, 4);
  const statePath = join(f.config.stateDirectory, 'state.json');
  const firstState = JSON.parse(readFileSync(statePath, 'utf8')); const hashBefore = firstState.identityHash;
  assert.equal(await execute(true), 0); assert.equal(prompts, 4);
  const rows = readFileSync(ledgerPath(env), 'utf8').trim().split('\n').map(line => JSON.parse(line) as RunStatistics);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].runId, rows[1].runId);
  assert.deepEqual(rows[1].settings, rows[0].settings);
  assert.equal(rows[1].settings.harness.source, 'interactive-answer');
  assert.equal(rows[1].settings.model.source, 'default');
  assert.equal(rows[1].settings.effort.source, 'interactive-answer');
  assert.equal(rows[1].settings.coverage.source, 'interactive-answer');
  assert.equal(rows[1].tasks[0].outcome, 'accepted');
  assert.equal(rows[1].tasks[0].durationSeconds, 10);
  const last = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(last.identityHash, hashBefore); assert.deepEqual(last.identity.authority, firstState.identity.authority);
  assert.deepEqual(rows[1].tasks[0].workerSessions, rows[0].tasks[0].workerSessions);
  assert.deepEqual(rows[1].tasks[0].planningFindingsPerRound, [0]);
  assert.deepEqual(rows[1].tasks[0].implementationFindingsPerRound, [0]);
  // Seven sessions run before the interruption, including the documentation session and its review.
  assert.deepEqual(rows[0].tokenUsage, { inputTokens: 14, outputTokens: 21, totalTokens: 35 });
  assert.equal(rows[1].tokenUsage, null); assert.equal(rows[1].tasks[0].tokenUsage, null);
  assert.deepEqual(rows[1].tasks[0].finalChecks, last.completed.A.finalChecks.map(
    ({ command, args, outcome }: CheckRecord) => ({ command, args, outcome })));
  assert.equal(rows[1].tasks[0].completionSummary, last.completed.A.completion.summary);
  assert.equal(rows[1].tasks[0].complexityGrade, last.completed.A.completion.grade);
  // A legacy state without statistics-only provenance remains compatible.
  delete last.statisticsSources; writeFileSync(statePath, JSON.stringify(last));
  assert.equal(await execute(true), 0);
  const legacy = JSON.parse(readFileSync(ledgerPath(env), 'utf8').trim().split('\n').at(-1)!) as RunStatistics;
  assert.equal(legacy.settings.harness.source, 'default');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).identityHash, hashBefore);
});

for (const phase of ['preflight', 'selection', 'work'] as const) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test('B: ' + signal + ' during ' + phase + ' cancels once and cleans handlers', { timeout: 20000 }, async t => {
      const f = fixture(t); const xdg = join(f.base, 'child-ledger');
      const { root: _root, stateDirectory: _state, harness: _harness, model: _model, effort: _effort, ...invocation } = f.config;
      const path = join(f.base, 'child-invocation.json'); writeFileSync(path, JSON.stringify({ ...invocation, leaves: ['A'] }));
      const child = fork(fileURLToPath(new URL('./support/statistics-child.ts', import.meta.url)), [path, f.root, phase], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'NODE_OPTIONS'].includes(key))), XDG_STATE_HOME: xdg },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let done: { code: number; closes: number; handlersClean: boolean } | undefined; let stderr = '';
      child.stdout!.resume(); child.stderr!.on('data', chunk => { stderr += chunk; });
      child.on('message', (message: { type: string; code: number; closes: number; handlersClean: boolean }) => {
        if (message.type === 'ready') child.kill(signal); else if (message.type === 'done') done = message;
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
        child.once('exit', (code, signal) => resolve({ code, signal })));
      assert.deepEqual(exit, { code: 3, signal: null }, stderr);
      assert.ok((done as { handlersClean: boolean } | undefined)?.handlersClean);
      if (phase === 'work') assert.ok((done as { closes: number } | undefined)!.closes > 0);
      const bytes = readFileSync(ledgerPath({ XDG_STATE_HOME: xdg }), 'utf8');
      const lines = bytes.trim().split('\n'); assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]) as RunStatistics;
      assert.equal(record.status, 'cancelled'); assert.equal(record.exitCode, 3); assert.equal(record.failureReason, null);
      assert.ok(!bytes.includes('SECRET_'));
      if (phase === 'work') {
        assert.equal(record.tasks.length, 1); assert.equal(record.tasks[0].outcome, 'blocked');
        assert.equal(record.tasks[0].lastStage, 'investigate'); assert.equal(record.tasks[0].blockingReason, 'cancelled');
        assert.equal(record.tasks[0].workerSessions.investigate, 1); assert.equal(record.tasks[0].durationSeconds, null);
      } else {
        assert.deepEqual(record.tasks, []); assert.deepEqual(record.settings.leaves, { value: null, source: null });
      }
    });
  }
}

test('A: repeated cancellation races worker rejection and cleanup without duplicate ledger writes', { timeout: 20000 }, async t => {
  const f = fixture(t); const xdg = join(f.base, 'racing-ledger');
  const { root: _root, stateDirectory: _state, ...invocation } = f.config;
  const path = join(f.base, 'racing-invocation.json'); writeFileSync(path, JSON.stringify({ ...invocation, leaves: ['A'] }));
  const child = fork(fileURLToPath(new URL('./support/statistics-child.ts', import.meta.url)), [path, f.root, 'race'], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'NODE_OPTIONS'].includes(key))), XDG_STATE_HOME: xdg },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdout!.resume(); let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  let clean = false;
  child.on('message', (message: { type: string; handlersClean?: boolean }) => {
    if (message.type === 'ready') child.send('race'); else if (message.type === 'done') clean = message.handlersClean!;
  });
  const code = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  assert.equal(code, 3, stderr); assert.ok(clean);
  const lines = readFileSync(ledgerPath({ XDG_STATE_HOME: xdg }), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); const record = JSON.parse(lines[0]) as RunStatistics;
  assert.equal(record.status, 'cancelled'); assert.equal(record.tasks[0].blockingReason, 'cancelled');
  assert.equal(record.tasks[0].lastStage, 'investigate'); assert.ok(!lines[0].includes('SECRET_'));
});

test('C: ledger retains an existing closed PR while refusing creation and merge', async t => {
  const f = fixture(t); const env = { XDG_STATE_HOME: join(f.base, 'closed-pr-ledger') };
  const { root: _root, stateDirectory: _state, ...invocation } = { ...f.config, leaves: ['A'] };
  const path = join(f.base, 'closed-pr-invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const pr: PullRequest = { number: 42, url: 'https://example.org/pull/42', state: 'CLOSED',
    headRefOid: '0'.repeat(40), baseRefName: f.project.target };
  f.host.find = () => pr;
  f.host.create = () => { assert.fail('Existing closed PR must not create another PR'); };
  f.host.merge = () => { assert.fail('Closed PR must not merge'); };
  const code = await ledgerMain(path, (config, options) => runQueue({
    ...config, stateDirectory: f.config.stateDirectory,
  }, { ...options, host: f.host, createAdapter: scripted }), () => {}, { cwd: f.root, env });
  assert.equal(code, 3);
  const lines = readFileSync(ledgerPath(env), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]) as RunStatistics;
  assert.equal(record.status, 'incomplete'); assert.equal(record.tasks.length, 1);
  assert.equal(record.tasks[0].outcome, 'blocked'); assert.equal(record.tasks[0].lastStage, 'pr');
  assert.deepEqual(record.tasks[0].pr, { number: pr.number, url: pr.url });
  const state = JSON.parse(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'));
  assert.match(state.blocked.A.reason, /closed/u);
  assert.equal(f.records.length, 0);
});

for (const boundary of ['pr', 'merge'] as const) test(`B: ledger recovers the legacy PR URL after interruption at ${boundary}`, async t => {
  const f = fixture(t); const env = { XDG_STATE_HOME: join(f.base, 'legacy-pr-ledger') };
  const { root: _root, stateDirectory: _state, ...invocation } = { ...f.config, leaves: ['A'] };
  const path = join(f.base, 'legacy-pr-invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const create = f.host.create;
  f.host.create = work => { const pr = create(work); pr.url = 'https://example.org/pull/' + pr.number; return pr; };
  const execute = (resume: boolean) => ledgerMain(path, (config, options) => runQueue({
    ...config, stateDirectory: f.config.stateDirectory,
  }, { ...options, host: f.host,
    createAdapter: resume ? () => { throw new Error('Merge recovery must not start a worker'); } : scripted,
    afterEffect: async kind => {
      if (!resume && kind === boundary) throw Object.assign(new Error('Fixture interruption'), { interrupted: true });
    },
  }), line => {
    const result = JSON.parse(line);
    if (result.diagnostics) t.after(() => rmSync(join(result.diagnostics, '..'), { recursive: true, force: true }));
  }, { cwd: f.root, env });
  assert.equal(await execute(false), 4);
  const statePath = join(f.config.stateDirectory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.current.stage, boundary === 'merge' ? 'merge' : 'pr');
  assert.equal(f.records[0].state, boundary === 'merge' ? 'MERGED' : 'OPEN');
  const identityHash = state.identityHash;
  state.current.stage = 'merge'; delete state.current.pr.url;
  writeFileSync(statePath, JSON.stringify(state));
  let recoveredPrLookups = 0;
  if (boundary === 'merge') {
    const find = f.host.find;
    f.host.find = branch => {
      recoveredPrLookups++;
      assert.equal(branch, state.current.branch);
      return find(branch);
    };
    f.host.create = () => { assert.fail('Receipt recovery must not create another PR'); };
    f.host.merge = () => { assert.fail('Receipt recovery must not merge again'); };
  }
  assert.equal(await execute(true), 0);
  if (boundary === 'merge') assert.equal(recoveredPrLookups, 1);
  const rows = readFileSync(ledgerPath(env), 'utf8').trim().split('\n').map(line => JSON.parse(line) as RunStatistics);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].runId, rows[1].runId);
  assert.equal(rows[1].status, 'exhausted'); assert.equal(rows[1].tasks.length, 1);
  assert.equal(rows[1].tasks[0].outcome, 'accepted'); assert.equal(rows[1].tasks[0].lastStage, 'merge');
  assert.deepEqual(rows[1].tasks[0].pr, { number: 1, url: 'https://example.org/pull/1' });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'MERGED');
  const finished = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(finished.current, null);
  assert.equal(finished.identityHash, identityHash);
  assert.equal(finished.completed.A.pr.number, f.records[0].number);
  assert.equal(finished.completed.A.pr.url, f.records[0].url);
});
