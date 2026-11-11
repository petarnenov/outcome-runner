import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { Project, PullRequest, Queue, RunConfig, Work } from '../src/model.ts';
import { runQueue } from '../src/runner.ts';
import type { RunOptions } from '../src/runner.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { planTestInstructions, planningReviewTestInstructions, workTestInstructions,
  implementationReviewTestInstructions } from '../src/test-grading.ts';
import { preparedTestFramework } from './support/prepared-test-framework.ts';
import { scriptedArchive } from './support/scripted-archive.ts';

const fragments = [planTestInstructions, planningReviewTestInstructions, workTestInstructions,
  implementationReviewTestInstructions];
const percentages = (text: string) => text.match(/\d+%/gu) ?? [];

// E: each fragment names the given threshold as a percentage.
test('graded fragments state the given threshold as a percentage', () => {
  for (const fragment of fragments) {
    assert.ok(fragment(90).includes('90%'));
    assert.ok(fragment(85).includes('85%'));
    assert.ok(fragment(1).includes('1%'));
  }
});

// C: fragments are deterministic and mention no other percentage.
test('graded fragments are deterministic and mention only the given threshold', () => {
  for (const fragment of fragments) {
    for (const coverage of [1, 85, 90, 100]) {
      assert.equal(fragment(coverage), fragment(coverage));
      const found = percentages(fragment(coverage));
      assert.ok(found.length);
      assert.ok(found.every(value => value === `${coverage}%`), `${found}`);
    }
  }
});

test('README describes the graded test workflow', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('## Graded test planning'));
  const section = readme.slice(readme.indexOf('## Graded test planning'));
  for (const text of ['A (most complex)', 'E (easiest)', 'from E to A', '(required)', '(coverage-only)',
    'grade by grade', 'run_checks', 'resolved coverage threshold', 'not needed: coverage reached',
    'planning review', 'implementation review', 'changes-required']) {
    assert.ok(section.includes(text), `README graded section mentions ${text}`);
  }
});

const passingOptions: RunOptions = { openspec: { probe: () => ({ status: 0 }), configPresent: () => true },
  selection: { interactive: false, probe: harness => ({ harness, available: true, version: 'scripted' }) },
  testFramework: preparedTestFramework, mergePolling: { delay: async () => {} }, runCommand: scriptedArchive() };

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'graded-test-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git'); const root = join(base, 'project');
  mkdirSync(root); git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'integration');
  git(root, 'config', 'user.name', 'Fixture Worker'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const project: Project = { queue: 'docs/work-queue/queue.json', changes: 'openspec/changes',
    receipts: 'docs/work-queue/receipts', target: 'proposal', repository: 'fixture', commitScope: 'fixture-tools',
    planningCheck: { command: 'node', args: ['-e', 'process.exit(0)', '{change}'] },
    checks: [{ command: 'node', args: ['checks.mjs'] },
      { command: 'node', args: ['--test', '--experimental-test-coverage', '--test-coverage-lines={coverage}', '{scope}/*.test.mjs'] }] };
  const queue: Queue = { version: 1, tasks: [{ id: 'A', priority: 0, title: 'Implement finite counter A',
    change: 'counter-a', scopes: ['src/a'], dependencies: [],
    criteria: ['Create src/a/result.mjs exporting next(n) that returns n + 1 for finite numbers.'] }] };
  mkdirSync(join(root, 'docs/work-queue'), { recursive: true });
  writeFileSync(join(root, project.queue), JSON.stringify(queue));
  mkdirSync(join(root, 'openspec'), { recursive: true });
  writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  mkdirSync(join(root, 'src/a'), { recursive: true });
  writeFileSync(join(root, 'src/a/requirements.md'), queue.tasks[0].criteria.join('\n'));
  writeFileSync(join(root, 'checks.mjs'), "import assert from 'node:assert/strict';\nimport {existsSync} from 'node:fs';\n" +
    "if (existsSync('src/a/result.mjs')) { const {next} = await import('./src/a/result.mjs'); assert.equal(next(1), 2); }\n");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test(fixture-tools): define outcomes');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', `HEAD:${project.target}`);
  const integrator = join(base, 'integrator'); git(base, 'clone', remote, integrator);
  git(integrator, 'config', 'user.name', 'Fixture Integrator'); git(integrator, 'config', 'user.email', 'integrator@example.invalid');
  const records: PullRequest[] = [];
  const host = { find: (branch: string) => records.find(pr => pr.branch === branch) ?? null,
    create(work: Work) { const pr = { number: records.length + 1, branch: work.branch, state: 'OPEN',
      headRefOid: git(work.path, 'rev-parse', 'HEAD') } as PullRequest; records.push(pr); return pr; },
    merge(pr: PullRequest, head: string) {
      git(integrator, 'fetch', 'origin'); git(integrator, 'checkout', '-B', project.target, `origin/${project.target}`);
      git(integrator, 'merge', '--no-ff', head, '-m', `feat(fixture-tools): accept ${pr.number}`);
      git(integrator, 'push', 'origin', `HEAD:${project.target}`); pr.state = 'MERGED';
    } };
  const config: RunConfig = { root, harness: 'claude', model: 'claude-opus-5-5', effort: 'medium',
    stateDirectory: join(base, 'state'), invocation: 'graded', project, leaves: ['A'],
    authority: { reference: 'fixture-owner-off', instruction: 'OFF implement these exact outcomes and normally merge.',
      target: project.target, tasks: { A: hash(queue.tasks[0]) } } };
  return { config, host };
}

type Kind = 'investigate' | 'plan' | 'planningReview' | 'work' | 'implementationReview' | 'document' | 'documentReview';
const kindOf = (prompt: string): Kind => prompt.includes('Inspect current files') ? 'investigate' :
  prompt.includes('Create proposal.md') ? 'plan' : prompt.includes('Review planning artifacts') ? 'planningReview' :
  prompt.includes('Implement all approved') ? 'work' : prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation changes') ? 'documentReview' : 'implementationReview';

// A scripted adapter records every prompt; it never starts a real harness.
function recorder(prompts: { kind: Kind; prompt: string }[], { rejectFirstPlanningReview = false } = {}) {
  let planningReviews = 0;
  return (options: HarnessOptions): HarnessAdapter => {
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'graded' }) as Promise<any>;
    const write = async (path: string, content: string) => {
      const before = await call('backlog_tool', { operation: 'read_file', input: { path } as BrokerInput });
      await call('backlog_tool', { operation: 'write_file', input: { path, content, expectedHash: before.hash } as BrokerInput });
    };
    return { probe: () => ({ status: 'interface-ready' }), close() {}, async startAction(prompt: string) {
      const kind = kindOf(prompt); prompts.push({ kind, prompt });
      const directory = 'openspec/changes/counter-a';
      const result: ToolInput = { outcome: 'ready', summary: 'Scripted graded adapter', findings: [] };
      if (kind === 'investigate') result.inspected = ['src/a/requirements.md'];
      else if (kind === 'plan') {
        await write(`${directory}/proposal.md`, '# Proposal\n\nImplement the finite counter.\n');
        await write(`${directory}/design.md`, '# Design\n\nAdd one to finite input.\n');
        await write(`${directory}/tasks.md`, '# Tasks\n\n## Tests (graded, listed from E to A)\n\n' +
          '- [ ] 1.1 [E] (required) next(1) returns 2.\n');
        await write(`${directory}/specs/finite-counter/spec.md`, '## ADDED Requirements\n\n' +
          '### Requirement: Finite increment\nThe function SHALL increment finite numbers.\n\n' +
          '#### Scenario: Finite input\n- **WHEN** input is one\n- **THEN** the result is two\n');
      } else if (kind === 'work') {
        await write('src/a/result.mjs', 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n');
        await write('src/a/result.test.mjs', "import assert from 'node:assert/strict'; import {next} from './result.mjs'; assert.equal(next(1), 2);\n");
        await call('backlog_tool', { operation: 'run_checks', input: {} as BrokerInput });
      } else if (kind === 'planningReview' && rejectFirstPlanningReview && ++planningReviews === 1) {
        result.outcome = 'changes-required'; result.findings = ['Grade every planned test.'];
      } else {
        result.outcome = 'accepted';
        if (kind === 'implementationReview') {
          result.completion = { summary: 'The counter increments finite numbers. Tests cover it.', grade: 'E' };
        }
      }
      await call('outcome_report', result);
      return { threadId: 'graded-session', events: [], text: '' } as unknown as WorkerReply;
    } };
  };
}

const byKind = (prompts: { kind: Kind; prompt: string }[], kind: Kind) =>
  prompts.filter(entry => entry.kind === kind).map(entry => entry.prompt);
const instructions = (prompt: string) => prompt.slice(0, prompt.indexOf('Address private findings'));

function assertPlan(prompt: string, coverage: number) {
  assert.ok(prompt.includes('tasks.md must contain a test section'));
  assert.ok(prompt.includes('every planned test has a complexity grade from A (most complex), B, C, D, E (easiest)'));
  assert.ok(prompt.includes('the tests are listed from E to A'));
  assert.ok(prompt.includes('Mark each planned test (required) when a source criterion or spec scenario demands it, ' +
    'otherwise (coverage-only)'));
  assert.ok(prompt.includes(`until the coverage gate passes at ${coverage}%`));
}

function assertPlanningReview(prompt: string, coverage: number) {
  assert.ok(prompt.includes('report changes-required when a planned test in the tasks.md test section lacks a grade'));
  assert.ok(prompt.includes('when the tests are not listed from E to A'));
  assert.ok(prompt.includes('a test demanded by a source criterion or spec scenario is not marked (required)'));
  assert.ok(prompt.includes(`coverage gate is ${coverage}%`));
  assert.ok(!prompt.includes('coverage gate did not pass'));
  assert.ok(!prompt.includes('harder grade was written'));
}

function assertWork(prompt: string, coverage: number) {
  assert.ok(prompt.includes('write tests grade by grade starting with E'));
  assert.ok(prompt.includes('Call run_checks after each grade'));
  assert.ok(prompt.includes(`continue with the next harder grade until the coverage gate passes at ${coverage}%`));
  assert.ok(prompt.includes('Tests marked (required) are always written, whatever the coverage'));
  assert.ok(prompt.includes('applies only to (coverage-only) tests'));
  assert.ok(prompt.includes('Coverage-only grades left unwritten because the threshold was reached stay unchecked in ' +
    'tasks.md with the note `not needed: coverage reached`'));
  assert.ok(prompt.includes('Implement all approved OpenSpec scenarios and every test marked (required) within product scope'));
  assert.ok(!prompt.includes('Implement all approved OpenSpec scenarios and tests'));
}

function assertImplementationReview(prompt: string, coverage: number) {
  assert.ok(prompt.includes(`report changes-required when the coverage gate did not pass at ${coverage}%`));
  assert.ok(prompt.includes('when a harder grade was written while an easier planned grade is still unchecked without ' +
    'the note `not needed: coverage reached`'));
  assert.ok(prompt.includes('when a test marked (required) is unwritten or carries that note'));
  assert.ok(prompt.includes('completion.summary'));
  assert.ok(prompt.includes('completion.grade for whole-task complexity: A (most complex), B, C, D, E (easiest)'));
}

// E, D, D, C, B, A: a resolved threshold of 90 reaches every graded prompt, also after replanning and a work retry.
test('scripted prompts carry graded instructions at a non-default threshold through retries', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = []; let broken = false;
  const result = await runQueue({ ...f.config, coverage: 90 }, { ...passingOptions, host: f.host,
    createAdapter: recorder(prompts, { rejectFirstPlanningReview: true }),
    afterEffect: async (kind, work) => {
      if (kind === 'implementation' && !broken) {
        broken = true; writeFileSync(join((work as Work).path, 'src/a/result.mjs'), 'invalid syntax!');
      }
    } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.ok(broken);
  for (const kind of ['investigate', 'plan', 'planningReview', 'work', 'implementationReview', 'document',
    'documentReview'] as Kind[]) {
    assert.ok(byKind(prompts, kind).length, kind);
  }
  for (const { prompt } of prompts) {
    assert.match(prompt, /Resolved coverage threshold: 90%\./u);
    assert.ok(!prompt.includes('85%'));
    assert.ok(percentages(prompt).every(value => value === '90%'));
  }
  byKind(prompts, 'plan').forEach(prompt => assertPlan(prompt, 90));
  byKind(prompts, 'planningReview').forEach(prompt => assertPlanningReview(prompt, 90));
  byKind(prompts, 'work').forEach(prompt => assertWork(prompt, 90));
  byKind(prompts, 'implementationReview').forEach(prompt => assertImplementationReview(prompt, 90));
  for (const kind of ['plan', 'work'] as Kind[]) {
    const retried = byKind(prompts, kind);
    assert.ok(retried.length >= 2, `${kind} was retried`);
    assert.ok(new Set(retried.map(instructions)).size === 1, `${kind} retries keep the same instructions`);
  }
  assert.equal(new Set(byKind(prompts, 'planningReview')).size, 1);
});

// B: the default threshold appears in every worker prompt, including investigation.
test('scripted prompts state the default 85% threshold in every purpose', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = [];
  const result = await runQueue(f.config, { ...passingOptions, host: f.host, createAdapter: recorder(prompts) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(byKind(prompts, 'investigate').length);
  for (const { prompt } of prompts) {
    assert.match(prompt, /Resolved coverage threshold: 85%\./u);
    assert.ok(percentages(prompt).every(value => value === '85%'));
  }
  byKind(prompts, 'plan').forEach(prompt => assertPlan(prompt, 85));
  byKind(prompts, 'planningReview').forEach(prompt => assertPlanningReview(prompt, 85));
  byKind(prompts, 'work').forEach(prompt => assertWork(prompt, 85));
  byKind(prompts, 'implementationReview').forEach(prompt => assertImplementationReview(prompt, 85));
  for (const kind of ['plan', 'planningReview', 'work', 'implementationReview', 'document', 'documentReview'] as Kind[]) {
    assert.equal(byKind(prompts, kind).length, 1, kind);
  }
});
