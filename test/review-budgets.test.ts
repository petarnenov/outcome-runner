import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import type { BudgetExhaustion, ReviewRecord, RunConfig, Work } from '../src/model.ts';
import { BudgetExhausted, CHECK_ATTEMPTS, REVIEW_ROUNDS, budgetMessage, budgetOf, explainUnfinished, runQueue }
  from '../src/runner.ts';
import type { RunOptions } from '../src/runner.ts';
import { main, parseFlags } from '../src/cli.ts';
import { resolveRunPaths } from '../src/run-paths.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput } from '../src/harness-adapter.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const exhaustion = (stage: BudgetExhaustion['stage'], exhausted: BudgetExhaustion['exhausted'], reviews: number,
  checks: number): BudgetExhaustion => ({ stage, exhausted, reviews: { used: reviews, limit: REVIEW_ROUNDS },
  checks: { used: checks, limit: CHECK_ATTEMPTS[stage] } });

// 5.1 (E) (required)
test('E: budgetMessage names the stage, the exhausted budget and both counts', () => {
  assert.equal(REVIEW_ROUNDS, 4);
  assert.deepEqual(CHECK_ATTEMPTS, { plan: 4, work: 4, document: 0 });
  assert.equal(budgetMessage(exhaustion('work', 'reviews', 4, 0)),
    'Implementation review budget exhausted: 4 of 4 review rounds and 0 of 4 check attempts used');
  assert.equal(budgetMessage(exhaustion('plan', 'checks', 1, 4)),
    'Planning check budget exhausted: 1 of 4 review rounds and 4 of 4 check attempts used');
  assert.equal(budgetMessage(exhaustion('document', 'reviews', 4, 0)),
    'Documentation review budget exhausted: 4 of 4 review rounds and 0 of 0 check attempts used');
  const budget = exhaustion('work', 'checks', 0, 4);
  const error = new BudgetExhausted(budget);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'BudgetExhausted');
  assert.equal(error.message, budgetMessage(budget));
  assert.deepEqual(error.budget, budget); assert.notEqual(error.budget, budget);
});

// 5.2 (E) (required)
test('E: budgetOf derives legacy review counts with zero checks and keeps a recorded budget', () => {
  const review = { reviewer: 'claude:fixture', outcome: 'changes-required', summary: 'Review', findings: ['x'] } as ReviewRecord;
  const legacy = { planningReviews: [review, review], reviews: [review, review, review], documentationReviews: [review] };
  assert.deepEqual(budgetOf(legacy), { plan: { reviews: 2, checks: 0 }, work: { reviews: 3, checks: 0 },
    document: { reviews: 1, checks: 0 } });
  assert.deepEqual(budgetOf({}), { plan: { reviews: 0, checks: 0 }, work: { reviews: 0, checks: 0 },
    document: { reviews: 0, checks: 0 } });
  const budget = { plan: { reviews: 1, checks: 2 }, work: { reviews: 0, checks: 3 }, document: { reviews: 0, checks: 0 } };
  assert.equal(budgetOf({ ...legacy, budget } as Pick<Work, 'budget'>), budget);
});

// 5.3 (E) (required)
test('E: explainUnfinished maps an exhausted budget to its blocker reason and copies the budget', () => {
  const reviews = exhaustion('work', 'reviews', 4, 0); const checks = exhaustion('plan', 'checks', 1, 4);
  const blockers = explainUnfinished({ ids: ['A', 'B', 'C'], remaining: ['A', 'B', 'C'],
    tasks: ['A', 'B', 'C'].map(id => ({ id, dependencies: [], scopes: [`src/${id.toLowerCase()}`] })),
    completed: {}, done: [], baselineDone: [], foreignClaims: [], statePath: '/state/state.json',
    blocked: { A: { reason: budgetMessage(reviews), budget: reviews, work: { stage: 'work', scopes: ['src/a'] } },
      B: { reason: budgetMessage(checks), budget: checks, work: { stage: 'plan', scopes: ['src/b'] } },
      C: { reason: 'Scripted worker failure', work: { stage: 'investigate', scopes: ['src/c'] } } } });
  assert.deepEqual(blockers.A, { kind: 'blocked', stage: 'work', reason: 'review-budget-exhausted',
    diagnostics: '/state/state.json', budget: reviews });
  assert.notEqual(blockers.A.budget, reviews);
  assert.deepEqual(blockers.B, { kind: 'blocked', stage: 'plan', reason: 'check-budget-exhausted',
    diagnostics: '/state/state.json', budget: checks });
  assert.deepEqual(blockers.C, { kind: 'blocked', stage: 'investigate', reason: 'operation-incomplete',
    diagnostics: '/state/state.json' });
});

// 5.4 (E) (required)
test('E: --retry takes one separate task id per occurrence and refuses invalid forms', () => {
  assert.deepEqual(parseFlags(['--retry', 'A', '--retry', 'B']).retry, ['A', 'B']);
  assert.deepEqual(parseFlags(['--no-mascot', '--retry', 'A', '--model=claude-sonnet-5-5']),
    { noMascot: true, retry: ['A'], model: 'claude-sonnet-5-5' });
  assert.equal(parseFlags([]).retry, undefined);
  for (const args of [['--retry'], ['--retry', '--no-mascot'], ['--retry', 'A', '--retry', 'A'], ['--retry=A'],
    ['--retry', '']]) {
    assert.throws(() => parseFlags(args), /--retry <task id>/u, JSON.stringify(args));
  }
});

// Runner tests: runnerFixture with scripted adapters wrapping scriptedWorker. Session counts come from the prompts
// the adapter receives; each kind is numbered from 1 across every run that shares one script.

type Kind = 'investigate' | 'plan' | 'planReview' | 'work' | 'review' | 'document' | 'documentReview';
type Review = 'planReview' | 'review' | 'documentReview';
const kindOf = (prompt: string): Kind | undefined => prompt.includes('Inspect current files') ? 'investigate' :
  prompt.includes('Create proposal.md') ? 'plan' : prompt.includes('Review planning artifacts') ? 'planReview' :
  prompt.includes('Implement all approved') ? 'work' : prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation') ? 'documentReview' :
  prompt.includes('Review actual implementation') ? 'review' : undefined;

interface Script {
  /** Review sessions (by their number) that return changes-required with a finding. */
  reject?: Partial<Record<Review, (n: number) => boolean>>;
  /** Implementation sessions that write a result.mjs whose next(1) !== 2, so checks.mjs fails. */
  failingWork?: (n: number) => boolean;
  /** Planning sessions that omit specs/counter/spec.md, so the planning check (the packet) fails. */
  incompletePlan?: (n: number) => boolean;
  /** Sessions that fail after they started. */
  fail?: Partial<Record<Kind, (n: number) => boolean>>;
}

function scripted(script: Script = {}) {
  const prompts: { kind: Kind; prompt: string }[] = [];
  const createAdapter = (options: HarnessOptions): HarnessAdapter => {
    let kind: Kind | undefined; let number = 0;
    const handleTool: HarnessOptions['handleTool'] = async (name, input, context) => {
      let next: ToolInput = input;
      const path = String(input.input?.path ?? '');
      if (name === 'backlog_tool' && input.operation === 'write_file') {
        if (kind === 'plan' && script.incompletePlan?.(number) && path.endsWith('/specs/counter/spec.md')) {
          return { status: 'skipped' };
        }
        if (kind === 'work' && script.failingWork?.(number) && path.endsWith('/result.mjs')) {
          next = { ...input, input: { ...input.input!, content: 'export function next(n) { return n + 2; }\n' } };
        }
      }
      if (name === 'outcome_report' && (kind === 'planReview' || kind === 'review' || kind === 'documentReview') &&
          script.reject?.[kind]?.(number)) {
        next = { outcome: 'changes-required', summary: 'Scripted rejection', findings: [`Fix ${kind} ${number}`] };
      }
      return options.handleTool(name, next, context);
    };
    return scriptedWorker({
      onSession: (_options, prompt) => {
        kind = kindOf(prompt);
        if (!kind) return;
        prompts.push({ kind, prompt });
        number = prompts.filter(entry => entry.kind === kind).length;
      },
      fail: () => !!kind && !!script.fail?.[kind]?.(number),
    })({ ...options, handleTool });
  };
  return { prompts, createAdapter, count: (kind: Kind) => prompts.filter(entry => entry.kind === kind).length };
}
type Scripted = ReturnType<typeof scripted>;

const readState = (config: RunConfig) => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
const receiptOf = (f: RunnerFixture, id = 'A') => JSON.parse(git(f.remote, 'show', `main:evidence/results/${id}.json`));

/** An invocation file for `main` and the configuration `main` resolves from it. */
function invocationFile(f: RunnerFixture, patch: Partial<RunConfig> = {}) {
  const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', patch);
  const path = join(f.base, 'invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const env = { XDG_STATE_HOME: join(f.base, 'xdg'), OUTCOME_RUNNER_MASCOT: '0' };
  return { path, env, config: resolveRunPaths(invocation, { cwd: f.root, env }) };
}

/** Runs `main` with the fixture options and `createAdapter`; returns the exit code and the parsed stdout lines. */
async function throughMain(t: TestContext, f: RunnerFixture, path: string, env: NodeJS.ProcessEnv, args: string[],
  createAdapter: RunOptions['createAdapter']) {
  const lines: string[] = [];
  const code = await main(path, (config: RunConfig, options: RunOptions) =>
    runQueue(config, f.options(config, { ...options, createAdapter })), line => { lines.push(line); },
  { args, cwd: f.root, env, mascot: () => {} });
  const parsed = lines.map(line => JSON.parse(line));
  for (const line of parsed) if (line.diagnostics) t.after(() => rmSync(join(line.diagnostics, '..'), { recursive: true, force: true }));
  return { code, lines: parsed };
}

// 5.5 (D) (required)
test('D: main passes --retry as a run option, never in the configuration, and refuses an invalid --retry', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const { path, env } = invocationFile(f);
  const seen: { config: RunConfig; options: RunOptions }[] = [];
  const spy = async (config: RunConfig, options: RunOptions) => { seen.push({ config, options }); return { status: 'exhausted' }; };
  assert.equal(await main(path, spy, () => {}, { args: ['--retry', 'A'], cwd: f.root, env, mascot: () => {} }), 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].options.retry, ['A']);
  assert.ok(!Object.hasOwn(seen[0].config, 'retry'));
  assert.equal(await main(path, spy, () => {}, { args: [], cwd: f.root, env, mascot: () => {} }), 0);
  assert.ok(!Object.hasOwn(seen[1].options, 'retry'));
  for (const args of [['--retry'], ['--retry=A'], ['--retry', 'A', '--retry', 'A']]) {
    const lines: string[] = [];
    assert.equal(await main(path, spy, line => { lines.push(line); }, { args, cwd: f.root, env, mascot: () => {} }), 4);
    const line = JSON.parse(lines[0]);
    t.after(() => rmSync(join(line.diagnostics, '..'), { recursive: true, force: true }));
    assert.equal(line.reason, 'startup-or-run-failed');
  }
  assert.equal(seen.length, 2);
});

// 5.6 (D) (required)
test('D: a task accepted without --retry has a receipt without retries and one counted review round', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted(); const config = f.config();
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const completed = readState(config).completed.A as Work;
  assert.deepEqual(completed.budget, { plan: { reviews: 1, checks: 0 }, work: { reviews: 1, checks: 0 },
    document: { reviews: 1, checks: 0 } });
  assert.equal(completed.retries, undefined);
  assert.ok(!Object.hasOwn(receiptOf(f), 'retries'));
  assert.equal(readState(config).retries, undefined);
  assert.equal(s.count('review'), 1);
});
