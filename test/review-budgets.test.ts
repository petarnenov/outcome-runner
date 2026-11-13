import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import type { BudgetExhaustion, RetryRecord, ReviewRecord, RunConfig, Work } from '../src/model.ts';
import { BudgetExhausted, CHECK_ATTEMPTS, REVIEW_ROUNDS, budgetMessage, budgetOf, explainUnfinished, runQueue }
  from '../src/runner.ts';
import type { RunOptions, RunResult } from '../src/runner.ts';
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
/** The number of commits on the claims ledger branch of origin; 0 before the first claim. */
const claimCommits = (f: RunnerFixture): number =>
  git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/work-queue-claims-main') ?
    Number(git(f.remote, 'rev-list', '--count', 'work-queue-claims-main')) : 0;

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

/** Asserts the blocker of a budget-exhausted task and that its blocked entry in state.json has the same budget. */
function assertBudgetBlock(result: RunResult, config: RunConfig, budget: BudgetExhaustion, stage = budget.stage) {
  const state = readState(config);
  assert.equal(state.blocked.A.reason, budgetMessage(budget));
  assert.deepEqual(state.blocked.A.budget, budget);
  assert.deepEqual(result.blockers?.A, { kind: 'blocked', stage,
    reason: budget.exhausted === 'reviews' ? 'review-budget-exhausted' : 'check-budget-exhausted',
    diagnostics: join(config.stateDirectory, 'state.json'), budget });
  return state;
}

const REVIEWS_RAN_OUT = exhaustion('work', 'reviews', 4, 0);

/** The 5.7 run: every implementation review of `s` rejects until A is blocked with an exhausted review budget. */
async function reviewsRanOut(f: RunnerFixture, config: RunConfig, s: Scripted) {
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(s.count('review'), 4); assert.equal(s.count('work'), 4);
  const state = assertBudgetBlock(result, config, REVIEWS_RAN_OUT);
  assert.equal(state.blocked.A.reason,
    'Implementation review budget exhausted: 4 of 4 review rounds and 0 of 4 check attempts used');
  assert.equal(state.blocked.A.work.stage, 'work');
  assert.equal(state.retries, undefined);
  return state;
}

/** Asserts a refusal with reason `retry-not-blocked` that names `tasks`. */
const retryNotBlocked = (tasks: string[]) => (error: Error & { reason?: string; details?: unknown }) => {
  assert.equal(error.reason, 'retry-not-blocked');
  assert.deepEqual(error.details, { tasks });
  return true;
};

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

// 5.7 (C) (required)
test('C: reviews ran out: four rejected implementation reviews block with review-budget-exhausted', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: () => true } }); const config = f.config();
  const state = await reviewsRanOut(f, config, s);
  assert.deepEqual(state.blocked.A.work.budget.work, { reviews: 4, checks: 0 });
  assert.equal(s.count('document'), 0);
});

// 5.8 (C) (required)
test('C: checks ran out: four failing check runs block with check-budget-exhausted and no review', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ failingWork: () => true }); const config = f.config();
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const budget = { stage: 'work', exhausted: 'checks', reviews: { used: 0, limit: 4 }, checks: { used: 4, limit: 4 } } as const;
  const state = assertBudgetBlock(result, config, budget);
  assert.equal(state.blocked.A.reason,
    'Implementation check budget exhausted: 0 of 4 review rounds and 4 of 4 check attempts used');
  assert.deepEqual(result.blockers!.A.budget, budget); assert.deepEqual(state.blocked.A.budget, budget);
  assert.equal(state.blocked.A.work.budget.work.checks, 4);
  assert.equal(s.count('work'), 4); assert.equal(s.count('review'), 0);
});

// 5.9 (C) (required)
test('C: planning check failures use the planning check budget and the task proceeds to the work stage', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ incompletePlan: n => n <= 2 }); const config = f.config();
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const completed = readState(config).completed.A as Work;
  assert.deepEqual(completed.budget!.plan, { checks: 2, reviews: 1 });
  assert.deepEqual(completed.budget!.work, { checks: 0, reviews: 1 });
  assert.equal(s.count('plan'), 3); assert.equal(s.count('planReview'), 1); assert.equal(s.count('work'), 1);
});

// 5.10 (C) (required)
test('C: --retry of a task that is not blocked is refused before any claim, session or budget change', async t => {
  // (a) Nothing is blocked yet.
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const s = scripted(); const config = f.config();
  await assert.rejects(f.run(config, { createAdapter: s.createAdapter, retry: ['B'] }), retryNotBlocked(['B']));
  assert.equal(claimCommits(f), 0); assert.equal(s.prompts.length, 0);
  assert.equal(readState(config).retries, undefined);
  const cli = invocationFile(f);
  const refused = await throughMain(t, f, cli.path, cli.env, ['--retry', 'B'], s.createAdapter);
  assert.equal(refused.code, 4);
  assert.equal(refused.lines.length, 1); assert.equal(refused.lines[0].reason, 'retry-not-blocked');
  assert.deepEqual(JSON.parse(readFileSync(refused.lines[0].diagnostics, 'utf8')).details, { tasks: ['B'] });
  assert.equal(claimCommits(f), 0); assert.equal(s.prompts.length, 0);
  assert.equal(readState(cli.config).retries, undefined);
  // (b) A mixed list: A is blocked with an exhausted budget, B is not blocked.
  const g = runnerFixture(t, { ids: ['A', 'B'] });
  const r = scripted({ reject: { review: () => true } }); const leaves = g.config('one', { leaves: ['A'] });
  await reviewsRanOut(g, leaves, r);
  const before = readState(leaves); const claims = claimCommits(g); const prompts = r.prompts.length;
  assert.equal(before.blocked.A.work.retries, undefined);
  await assert.rejects(g.run(leaves, { createAdapter: r.createAdapter, retry: ['A', 'B'] }), retryNotBlocked(['B']));
  const after = readState(leaves);
  assert.deepEqual(after.blocked.A, before.blocked.A);
  assert.deepEqual(after.blocked.A.work.budget, before.blocked.A.work.budget);
  assert.equal(after.blocked.A.work.retries, undefined);
  assert.equal(after.retries, undefined);
  assert.equal(claimCommits(g), claims); assert.equal(r.prompts.length, prompts);
});

// 5.11 (C) (coverage-only): not needed, coverage reached.

// 5.12 (B) (required)
test('B: failing check runs use check attempts and never review rounds', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ failingWork: n => n <= 2, reject: { review: n => n <= 3 } }); const config = f.config();
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(s.count('work'), 6); assert.equal(s.count('review'), 4);
  // No review session follows the two failing check runs: the first review comes after the third implementation.
  const kinds = s.prompts.map(entry => entry.kind).filter(kind => kind === 'work' || kind === 'review');
  assert.deepEqual(kinds, ['work', 'work', 'work', 'review', 'work', 'review', 'work', 'review', 'work', 'review']);
  const completed = readState(config).completed.A as Work;
  assert.deepEqual(completed.budget!.work, { checks: 2, reviews: 4 });
});

// 5.13 (B) (required), updated by converging-reviews 4.14 to the planning default of 6 review rounds.
test('B: a restart without --retry continues the planning review count', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { planReview: n => n !== 3 }, fail: { planReview: n => n === 3 } });
  const config = f.config();
  const first = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(first.status, 'incomplete', JSON.stringify(first));
  assert.equal(first.blockers!.A.reason, 'operation-incomplete');
  const blocked = readState(config).blocked.A;
  assert.equal(blocked.reason, 'Scripted worker failure'); assert.equal(blocked.budget, undefined);
  assert.equal(blocked.work.budget.plan.reviews, 3);
  assert.equal(s.count('planReview'), 3);
  const second = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(second.status, 'incomplete', JSON.stringify(second));
  // The restart without --retry and without budgets starts exactly three more planning reviews.
  assert.equal(s.count('planReview'), 6);
  const state = assertBudgetBlock(second, config, { stage: 'plan', exhausted: 'reviews',
    reviews: { used: 6, limit: 6 }, checks: { used: 0, limit: 4 } });
  assert.equal(state.blocked.A.work.budget.plan.reviews, 6);
  assert.equal(state.retries, undefined);
  assert.equal(s.count('work'), 0);
});

// 5.14 (B) (required)
test('B: a restart of an exhausted task blocks again without any session', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: () => true } }); const config = f.config();
  await reviewsRanOut(f, config, s);
  const prompts = s.prompts.length; const claims = claimCommits(f);
  const again = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(again.status, 'incomplete', JSON.stringify(again));
  const state = assertBudgetBlock(again, config, REVIEWS_RAN_OUT);
  assert.deepEqual(state.blocked.A.work.budget.work, { reviews: 4, checks: 0 });
  assert.equal(s.prompts.length, prompts);
  assert.ok(!s.prompts.slice(prompts).some(entry => entry.prompt.includes('Task A;')));
  assert.equal(claimCommits(f), claims);
});

// 5.15 (B) (coverage-only): not needed, coverage reached.

/**
 * 5.16: in its own fixture, repeats the 5.7 run, then makes exactly one retry run of A, through `runQueue` or
 * through `main` with `--retry A`, and checks the new session, acceptance, retry record and receipt.
 */
async function retriedOnce(t: TestContext, through: 'runQueue' | 'main') {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: n => n <= 4 } });
  const cli = invocationFile(f); const config = cli.config;
  const blocked = (await reviewsRanOut(f, config, s)).blocked.A;
  let result: RunResult;
  if (through === 'main') {
    const { code, lines } = await throughMain(t, f, cli.path, cli.env, ['--retry', 'A'], s.createAdapter);
    assert.equal(code, 0, JSON.stringify(lines));
    result = lines.at(-1);
  } else {
    result = await f.run(config, { createAdapter: s.createAdapter, retry: ['A'] });
  }
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  // The retry starts one new implementation session and one review, which accepts.
  assert.equal(s.count('work'), 5); assert.equal(s.count('review'), 5);
  const state = readState(config);
  assert.equal(state.retries.length, 1);
  const record = state.retries[0] as RetryRecord;
  assert.equal(record.task, 'A'); assert.equal(record.stage, 'work');
  assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.equal(record.previous.work.reviews, 4);
  assert.deepEqual(record.previous, blocked.work.budget);
  assert.deepEqual(record.exhausted, blocked.budget);
  assert.deepEqual(record.exhausted, REVIEWS_RAN_OUT);
  const completed = state.completed.A as Work;
  assert.equal(completed.retries!.length, 1);
  assert.deepEqual(completed.retries, [record]);
  assert.deepEqual(completed.budget!.work, { reviews: 1, checks: 0 });
  assert.deepEqual(receiptOf(f).retries, [record]);
  return { f, s, config };
}

// 5.16 (A) (required)
test('A: --retry grants one new budget through runQueue, records it once and is refused afterwards', async t => {
  const { f, s, config } = await retriedOnce(t, 'runQueue');
  const prompts = s.prompts.length;
  await assert.rejects(f.run(config, { createAdapter: s.createAdapter, retry: ['A'] }), retryNotBlocked(['A']));
  assert.equal(readState(config).retries.length, 1);
  assert.equal(s.prompts.length, prompts);
});

test('A: --retry A through main grants one new budget and records it in state and receipt', async t => {
  await retriedOnce(t, 'main');
});

// 5.17 (A) (coverage-only): not needed, coverage reached.
// 5.18 (A) (coverage-only): not needed, coverage reached.
