import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGETS, hash, resolveBudgets, validateConfig } from '../src/model.ts';
import type { RunConfig, TaskBudget } from '../src/model.ts';
import { EXHAUSTIVE_REVIEW, budgetExhaustion, budgetMessage, documentationReviewPrompt, earlierFindingsPrompt,
  implementationReviewPrompt, planningReviewPrompt } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import { runnerFixture } from './support/runner-fixture.ts';

const EARLIER = 'Findings reported by the earlier review rounds of this stage';

/** Asserts that `fn` throws `invalid-budget` naming `setting` and `value`. */
const refusedAs = (fn: () => unknown, setting: string, value: unknown, label: string) =>
  assert.throws(fn, (error: Error & { reason?: string; details?: { setting?: string; value?: unknown } }) => {
    assert.equal(error.reason, 'invalid-budget', label);
    assert.equal(error.details?.setting, setting, label);
    assert.deepEqual(error.details?.value, value, label);
    assert.ok(error.message.includes(setting), label);
    return true;
  }, label);

// Grade E

// 4.1 (E) (required)
test('E (required): resolveBudgets without a setting is a copy of the defaults and replaces only given values', () => {
  const defaults = resolveBudgets(undefined);
  assert.deepEqual(defaults, { plan: { reviews: 6, checks: 4 }, work: { reviews: 4, checks: 4 },
    document: { reviews: 4, checks: 0 } });
  assert.deepEqual(DEFAULT_BUDGETS, defaults);
  assert.ok(Object.isFrozen(DEFAULT_BUDGETS) && Object.isFrozen(DEFAULT_BUDGETS.plan) &&
    Object.isFrozen(DEFAULT_BUDGETS.work) && Object.isFrozen(DEFAULT_BUDGETS.document));
  assert.notEqual(defaults, DEFAULT_BUDGETS); assert.notEqual(defaults.plan, DEFAULT_BUDGETS.plan);
  defaults.plan.reviews = 1;
  assert.equal(DEFAULT_BUDGETS.plan.reviews, 6); assert.equal(resolveBudgets(undefined).plan.reviews, 6);
  assert.deepEqual(resolveBudgets({ work: { reviews: 7 } }), { plan: { reviews: 6, checks: 4 },
    work: { reviews: 7, checks: 4 }, document: { reviews: 4, checks: 0 } });
  assert.deepEqual(resolveBudgets({}), resolveBudgets(undefined));
  assert.deepEqual(resolveBudgets({ plan: { reviews: 1, checks: 12 }, work: { reviews: 12, checks: 1 },
    document: { reviews: 12 } }), { plan: { reviews: 1, checks: 12 }, work: { reviews: 12, checks: 1 },
    document: { reviews: 12, checks: 0 } });
  assert.deepEqual(resolveBudgets({ document: { reviews: 1 } }).document, { reviews: 1, checks: 0 });
});

// 4.2 (E) (required)
test('E (required): invalid budgets and budget shapes are refused naming the field', () => {
  const cases: [unknown, string, unknown][] = [
    ...[0, 13, 2.5, '4', null].map(value => [{ plan: { reviews: value } }, 'budgets.plan.reviews', value] as
      [unknown, string, unknown]),
    [{ work: { checks: 0 } }, 'budgets.work.checks', 0],
    [{ document: { checks: 1 } }, 'budgets.document.checks', 1],
    [{ review: { reviews: 2 } }, 'budgets.review', { reviews: 2 }],
    [{ work: { rounds: 2 } }, 'budgets.work.rounds', 2],
    [{ plan: 5 }, 'budgets.plan', 5],
    [{ plan: [] }, 'budgets.plan', []],
    [{ document: null }, 'budgets.document', null],
    [[], 'budgets', []],
    [null, 'budgets', null],
    [4, 'budgets', 4],
  ];
  for (const [budgets, setting, value] of cases) {
    const label = JSON.stringify(budgets);
    refusedAs(() => resolveBudgets(budgets), setting, value, label);
    refusedAs(() => validateConfig({ budgets } as unknown as RunConfig), setting, value, `validateConfig ${label}`);
  }
});

// 4.3 (E) (required)
test('E (required): the three review prompt builders carry the exhaustive review instruction', () => {
  assert.ok(EXHAUSTIVE_REVIEW.includes('Report every finding you can find in this round, not only the first ones'));
  assert.ok(EXHAUSTIVE_REVIEW.includes('report accepted only with zero findings'));
  for (const prompt of [planningReviewPrompt(85, []), implementationReviewPrompt(85, []), documentationReviewPrompt([])]) {
    assert.ok(prompt.includes(EXHAUSTIVE_REVIEW), prompt);
    assert.ok(!prompt.includes(EARLIER), prompt);
  }
  // The existing sentences stay, so prompt matchers keep working.
  assert.ok(planningReviewPrompt(85, []).startsWith('Review planning artifacts'));
  assert.ok(implementationReviewPrompt(85, []).startsWith('Review actual implementation'));
  assert.ok(documentationReviewPrompt([]).startsWith('Review the documentation'));
  assert.equal(documentationReviewPrompt(), documentationReviewPrompt([]));
  assert.equal(implementationReviewPrompt(85), implementationReviewPrompt(85, []));
  assert.equal(planningReviewPrompt(85), planningReviewPrompt(85, []));
});

// 4.4 (E) (required)
test('E (required): the earlier findings text lists the rounds and is added only with earlier reviews', () => {
  assert.equal(earlierFindingsPrompt([]), '');
  const earlier = [{ findings: ['a'] }, { findings: ['b', 'c'] }];
  const text = earlierFindingsPrompt(earlier);
  assert.ok(text.startsWith(EARLIER), text);
  assert.ok(text.includes('[{"round":1,"findings":["a"]},{"round":2,"findings":["b","c"]}]'), text);
  assert.ok(text.includes('Check first that each of them was resolved'), text);
  assert.ok(text.includes('you may also report new findings'), text);
  for (const [without, withEarlier] of [[planningReviewPrompt(85, []), planningReviewPrompt(85, earlier)],
    [implementationReviewPrompt(85, []), implementationReviewPrompt(85, earlier)],
    [documentationReviewPrompt([]), documentationReviewPrompt(earlier)]]) {
    assert.ok(!without.includes(EARLIER));
    assert.equal(withEarlier, `${without} ${text}`);
  }
});

// 4.5 (E) (required)
test('E (required): budgets stay outside the identity and exhaustions name the limits in force', t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'], coverage: 85 });
  const budgets = { plan: { reviews: 8 }, work: { reviews: 2, checks: 5 }, document: { reviews: 3 } };
  assert.deepEqual(invocationIdentity({ ...config, budgets }), invocationIdentity(config));
  assert.equal(hash(invocationIdentity({ ...config, budgets })), hash(invocationIdentity(config)));
  const budget: TaskBudget = { plan: { reviews: 6, checks: 0 }, work: { reviews: 2, checks: 0 },
    document: { reviews: 0, checks: 0 } };
  const limits = resolveBudgets({ work: { reviews: 2 } });
  assert.equal(budgetMessage(budgetExhaustion(budget, 'work', 'reviews', limits)),
    'Implementation review budget exhausted: 2 of 2 review rounds and 0 of 4 check attempts used');
  // Without limits the defaults apply, with 6 planning review rounds.
  assert.deepEqual(budgetExhaustion(budget, 'plan', 'reviews'), { stage: 'plan', exhausted: 'reviews',
    reviews: { used: 6, limit: 6 }, checks: { used: 0, limit: 4 } });
  assert.deepEqual(budgetExhaustion(budget, 'document', 'reviews').checks, { used: 0, limit: 0 });
});
