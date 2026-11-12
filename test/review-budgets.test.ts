import test from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetExhaustion, ReviewRecord, Work } from '../src/model.ts';
import { BudgetExhausted, CHECK_ATTEMPTS, REVIEW_ROUNDS, budgetMessage, budgetOf, explainUnfinished }
  from '../src/runner.ts';
import { parseFlags } from '../src/cli.ts';

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
