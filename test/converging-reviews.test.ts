import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { DEFAULT_BUDGETS, hash, resolveBudgets, validateConfig } from '../src/model.ts';
import type { BudgetExhaustion, BudgetSettings, RetryRecord, RunConfig, TaskBudget, Work } from '../src/model.ts';
import { EXHAUSTIVE_REVIEW, budgetExhaustion, budgetMessage, documentationReviewPrompt, earlierFindingsPrompt,
  implementationReviewPrompt, planningReviewPrompt, runQueue } from '../src/runner.ts';
import type { RunResult } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput } from '../src/harness-adapter.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const EARLIER = 'Findings reported by the earlier review rounds of this stage';
const CLAIMS = 'work-queue-claims-main';

/** Asserts that `fn` throws `invalid-budget` naming `setting` and `value`. */
const refusedAs = (fn: () => unknown, setting: string, value: unknown, label: string) =>
  assert.throws(fn, (error: Error & { reason?: string; details?: { setting?: string; value?: unknown } }) => {
    assert.equal(error.reason, 'invalid-budget', label);
    assert.equal(error.details?.setting, setting, label);
    assert.deepEqual(error.details?.value, value, label);
    assert.ok(error.message.includes(setting), label);
    return true;
  }, label);

// Runner tests: runnerFixture with scripted adapters wrapping scriptedWorker, as in test/review-budgets.test.ts.
// Prompts are read from what the scripted adapter receives; each kind is numbered from 1 across every run of a script.

type Kind = 'investigate' | 'plan' | 'planReview' | 'work' | 'review' | 'document' | 'documentReview';
type Review = 'planReview' | 'review' | 'documentReview';
const kindOf = (prompt: string): Kind | undefined => prompt.includes('Inspect current files') ? 'investigate' :
  prompt.includes('Create proposal.md') ? 'plan' : prompt.includes('Review planning artifacts') ? 'planReview' :
  prompt.includes('Implement all approved') ? 'work' : prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation') ? 'documentReview' :
  prompt.includes('Review actual implementation') ? 'review' : undefined;

interface Script {
  /** Review sessions (by their number) that return changes-required with the finding `Fix <kind> <n>`. */
  reject?: Partial<Record<Review, (n: number) => boolean>>;
  /** Implementation sessions that write a result.mjs whose next(1) !== 2, so checks.mjs fails. */
  failingWork?: (n: number) => boolean;
  /** Planning sessions that omit specs/counter/spec.md, so the planning check (the packet) fails. */
  incompletePlan?: (n: number) => boolean;
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
    })({ ...options, handleTool });
  };
  const of = (kind: Kind) => prompts.filter(entry => entry.kind === kind).map(entry => entry.prompt);
  return { prompts, createAdapter, of, count: (kind: Kind) => of(kind).length };
}

const readState = (config: RunConfig) => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
const receiptOf = (f: RunnerFixture, id = 'A') => JSON.parse(git(f.remote, 'show', `main:evidence/results/${id}.json`));
const withBudgets = (f: RunnerFixture, budgets?: BudgetSettings) => f.config('one', budgets ? { budgets } : {});
const exhaustion = (stage: BudgetExhaustion['stage'], exhausted: BudgetExhaustion['exhausted'],
  reviews: [number, number], checks: [number, number]): BudgetExhaustion => ({ stage, exhausted,
  reviews: { used: reviews[0], limit: reviews[1] }, checks: { used: checks[0], limit: checks[1] } });

/** Asserts the blocker of a budget-exhausted task A and that its blocked entry in state.json has the same budget. */
function assertBudgetBlock(result: RunResult, config: RunConfig, budget: BudgetExhaustion) {
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const state = readState(config);
  assert.equal(state.blocked.A.reason, budgetMessage(budget));
  assert.deepEqual(state.blocked.A.budget, budget);
  assert.deepEqual(result.blockers?.A, { kind: 'blocked', stage: budget.stage,
    reason: budget.exhausted === 'reviews' ? 'review-budget-exhausted' : 'check-budget-exhausted',
    diagnostics: join(config.stateDirectory, 'state.json'), budget });
  return state;
}

/** Every implementation review of `s` rejects until A is blocked at 4 of 4 implementation reviews (default limits). */
async function blockedAtFourReviews(f: RunnerFixture, s: ReturnType<typeof scripted>) {
  const config = withBudgets(f);
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assertBudgetBlock(result, config, exhaustion('work', 'reviews', [4, 4], [0, 4]));
  assert.equal(s.count('review'), 4); assert.equal(s.count('work'), 4);
}

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
  const config = { ...f.config('one', { coverage: 85 }), leaves: ['A'] };
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

// Grade D

// 4.6 (D) (required)
const CLI_REFUSALS: [unknown, string, number][] = [[{ plan: { reviews: 0 } }, 'budgets.plan.reviews', 0],
  [{ document: { checks: 1 } }, 'budgets.document.checks', 1]];
for (const [budgets, setting, value] of CLI_REFUSALS) {
  test(`D (required): ${setting} ${value} is refused through the CLI with exit code 4 and invalid-budget`, async t => {
    const f = runnerFixture(t, { ids: ['A'] });
    const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
    const file = join(f.base, 'invocation.json');
    writeFileSync(file, JSON.stringify({ ...invocation, budgets }));
    const xdg = join(f.base, 'xdg'); const lines: string[] = [];
    const code = await main(file, (config, options) => runQueue(config, f.options(config, options)),
      line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: xdg, OUTCOME_RUNNER_MASCOT: '0' },
        mascot: async () => {} });
    assert.equal(code, 4);
    const line = JSON.parse(lines.at(-1)!);
    assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'invalid-budget');
    const diagnostics = JSON.parse(readFileSync(line.diagnostics, 'utf8'));
    rmSync(dirname(line.diagnostics), { recursive: true, force: true });
    assert.equal(diagnostics.reason, 'invalid-budget');
    assert.deepEqual(diagnostics.details, { setting, value });
    assert.equal(existsSync(join(xdg, 'outcome-runner')), false);
  });
}

// 4.7 (D) (required)
test('D (required): a refused budget leaves no lock, state, ownership file, claim, worktree or prompt', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = withBudgets(f, { work: { checks: 13 } });
  let preflights = 0; let sessions = 0;
  await assert.rejects(f.run(config, {
    openspec: { probe: () => { preflights += 1; return { status: 0 }; }, configPresent: () => { preflights += 1; return true; } },
    createAdapter: () => { sessions += 1; throw new Error('No session expected'); } }),
  (error: Error & { reason?: string; details?: unknown }) => {
    assert.equal(error.reason, 'invalid-budget');
    assert.deepEqual(error.details, { setting: 'budgets.work.checks', value: 13 });
    return true;
  });
  assert.equal(preflights, 0); assert.equal(sessions, 0);
  assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
  assert.equal(existsSync(config.stateDirectory), false);
  assert.equal(existsSync(join(config.stateDirectory, 'state.json')), false);
  assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${CLAIMS}`), '');
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(existsSync(f.outcomes), false);
});

// 4.8 (D) (coverage-only): not needed, coverage reached.

// Grade C

// 4.9 (C) (required)
test('C (required): the planning, implementation and documentation review prompts of a run are exhaustive', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted(); const config = withBudgets(f);
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  for (const kind of ['planReview', 'review', 'documentReview'] as Kind[]) {
    assert.equal(s.count(kind), 1, kind);
    const [prompt] = s.of(kind);
    assert.ok(prompt.includes(EXHAUSTIVE_REVIEW), kind);
    assert.ok(prompt.includes('Report every finding you can find in this round, not only the first ones'), kind);
    assert.ok(prompt.includes('report accepted only with zero findings'), kind);
    assert.ok(!prompt.includes(EARLIER), kind);
  }
});

// 4.10 (C) (required)
test('C (required): the second review round of each stage lists the findings of the earlier rounds of that stage', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { planReview: n => n === 1, review: n => n === 1, documentReview: n => n === 1 } });
  const config = withBudgets(f);
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  const findings: Record<Review, string> = { planReview: 'Fix planReview 1', review: 'Fix review 1',
    documentReview: 'Fix documentReview 1' };
  for (const kind of Object.keys(findings) as Review[]) {
    const [first, second] = s.of(kind);
    assert.equal(s.count(kind), 2, kind);
    assert.ok(!first.includes(EARLIER), kind);
    assert.ok(second.includes(EARLIER), kind);
    assert.ok(second.includes(`[{"round":1,"findings":["${findings[kind]}"]}]`), kind);
    assert.ok(second.includes('Check first that each of them was resolved'), kind);
    assert.ok(second.includes('you may also report new findings'), kind);
    for (const other of (Object.keys(findings) as Review[]).filter(item => item !== kind)) {
      assert.ok(!second.includes(findings[other]), `${kind} lists no finding of ${other}`);
    }
  }
});

// 4.11 (C) (required)
test('C (required): a plan is accepted in its fifth review round with the default limits', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { planReview: n => n <= 4 } }); const config = withBudgets(f);
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(s.count('planReview'), 5); assert.equal(s.count('work'), 1);
  assert.equal((readState(config).completed.A as Work).budget!.plan.reviews, 5);
  // The fifth planning review lists the findings of the four earlier rounds.
  assert.ok(s.of('planReview')[4].includes(JSON.stringify([1, 2, 3, 4].map(round =>
    ({ round, findings: [`Fix planReview ${round}`] })))));
});

// 4.12 (C) (required)
test('C (required): a configured planning review limit blocks after that many rejected reviews', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { planReview: () => true } }); const config = withBudgets(f, { plan: { reviews: 2 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  const state = assertBudgetBlock(result, config, exhaustion('plan', 'reviews', [2, 2], [0, 4]));
  assert.equal(state.blocked.A.work.stage, 'plan');
  assert.equal(s.count('planReview'), 2); assert.equal(s.count('work'), 0);
});

test('C (required): a configured planning check limit blocks after that many failing planning checks', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ incompletePlan: () => true }); const config = withBudgets(f, { plan: { checks: 1 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assertBudgetBlock(result, config, exhaustion('plan', 'checks', [0, 6], [1, 1]));
  assert.equal(s.count('plan'), 1); assert.equal(s.count('planReview'), 0);
});

// 4.13 (C) (required)
test('C (required): a configured implementation review limit blocks with the limit in the private reason', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: () => true } }); const config = withBudgets(f, { work: { reviews: 2 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  const state = assertBudgetBlock(result, config, exhaustion('work', 'reviews', [2, 2], [0, 4]));
  assert.equal(state.blocked.A.reason,
    'Implementation review budget exhausted: 2 of 2 review rounds and 0 of 4 check attempts used');
  assert.equal(s.count('review'), 2); assert.equal(s.count('work'), 2);
});

test('C (required): a configured implementation check limit blocks after that many failing check runs', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ failingWork: () => true }); const config = withBudgets(f, { work: { checks: 2 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assertBudgetBlock(result, config, exhaustion('work', 'checks', [0, 4], [2, 2]));
  assert.equal(s.count('work'), 2); assert.equal(s.count('review'), 0);
});

// Grade B

// 4.14 (B) (required): the update of 5.13 lives in test/review-budgets.test.ts.

// 4.15 (B) (required)
test('B (required): a configured documentation review limit blocks in the document stage', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { documentReview: () => true } });
  const config = withBudgets(f, { document: { reviews: 1 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  const state = assertBudgetBlock(result, config, exhaustion('document', 'reviews', [1, 1], [0, 0]));
  assert.equal(state.blocked.A.work.stage, 'document');
  assert.equal(s.count('documentReview'), 1); assert.equal(s.count('document'), 1);
});

// 4.16 (B) (required)
test('B (required): a restart with a limit not above the used count blocks again without any session', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: () => true } });
  await blockedAtFourReviews(f, s);
  const prompts = s.prompts.length;
  const config = withBudgets(f, { work: { reviews: 3 } });
  const again = await f.run(config, { createAdapter: s.createAdapter });
  const state = assertBudgetBlock(again, config, exhaustion('work', 'reviews', [4, 3], [0, 4]));
  assert.equal(state.blocked.A.reason,
    'Implementation review budget exhausted: 4 of 3 review rounds and 0 of 4 check attempts used');
  assert.deepEqual(state.blocked.A.work.budget.work, { reviews: 4, checks: 0 });
  assert.equal(s.prompts.length, prompts);
  assert.equal(state.retries, undefined);
});

// Grade A

// 4.17 (A) (required)
test('A (required): a restart with a raised implementation review limit resumes the task without --retry', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: n => n <= 4 } });
  await blockedAtFourReviews(f, s);
  const config = withBudgets(f, { work: { reviews: 6 } });
  const result = await f.run(config, { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  // One new implementation session and one review, which accepts.
  assert.equal(s.count('work'), 5); assert.equal(s.count('review'), 5);
  assert.ok(s.of('review')[4].includes(JSON.stringify([1, 2, 3, 4].map(round =>
    ({ round, findings: [`Fix review ${round}`] })))));
  const state = readState(config);
  const completed = state.completed.A as Work;
  assert.equal(completed.budget!.work.reviews, 5);
  assert.equal(state.retries, undefined);
  assert.equal(completed.retries, undefined);
  assert.ok(!Object.hasOwn(receiptOf(f), 'retries'));
});

// 4.18 (A) (required)
test('A (required): --retry with configured limits grants a fresh budget and records the exhausted limit', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = scripted({ reject: { review: n => n <= 2 } });
  const config = withBudgets(f, { work: { reviews: 2 } });
  const first = await f.run(config, { createAdapter: s.createAdapter });
  const exhausted = exhaustion('work', 'reviews', [2, 2], [0, 4]);
  assertBudgetBlock(first, config, exhausted);
  const result = await f.run(config, { createAdapter: s.createAdapter, retry: ['A'] });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(s.count('review'), 3);
  const state = readState(config);
  const completed = state.completed.A as Work;
  assert.equal(completed.budget!.work.reviews, 1);
  assert.equal(state.retries.length, 1);
  const record = state.retries[0] as RetryRecord;
  assert.deepEqual(record.exhausted!.reviews, { used: 2, limit: 2 });
  assert.deepEqual(record.exhausted, exhausted);
  assert.deepEqual(completed.retries, [record]);
});

// 4.19 (A) (coverage-only): not needed, coverage reached.
