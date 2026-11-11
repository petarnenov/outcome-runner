import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NON_OUTCOME_STATUSES, RUN_OUTCOME_MOODS, RUN_STATUSES, TASK_EVENT_MOODS, TASK_EVENT_STATUSES,
  runMascot, runOutcome, shortReason, taskMascot } from '../src/mascot-events.ts';
import { parseFlags } from '../src/cli.ts';

test('E: accepted is happy and merged, blocked with a short reason is angry', () => {
  assert.deepEqual(taskMascot({ status: 'accepted', id: 'OR-1' }), { mood: 'happy', caption: 'OR-1 merged' });
  assert.deepEqual(taskMascot({ status: 'blocked', id: 'OR-1' }, { reason: 'Worker plan incomplete' }),
    { mood: 'angry', caption: 'OR-1 blocked: Worker plan incomplete' });
});

test('E: every run outcome has its mood and caption', () => {
  const cases: [string, number, object, string, string][] = [
    ['exhausted', 0, { accepted: ['A', 'B'], remaining: [] }, 'celebrating', 'exhausted: 2 accepted, 0 remaining'],
    ['limit-reached', 0, { accepted: ['A'], remaining: ['B'] }, 'content', 'limit-reached: 1 accepted, 1 remaining'],
    ['incomplete', 3, { accepted: [], remaining: ['A'], claimedElsewhere: { A: {} } }, 'sleepy', 'incomplete: 0 accepted, 1 remaining'],
    ['incomplete', 3, { accepted: [], remaining: ['A'], blockers: { A: { reason: 'x' } } }, 'sad', 'incomplete: 0 accepted, 1 remaining'],
    ['cancelled', 3, { accepted: ['A'], remaining: ['B', 'C'] }, 'startled', 'cancelled: 1 accepted, 2 remaining'],
    ['unavailable', 4, { status: 'unavailable', reason: 'r', diagnostics: '/d' }, 'dizzy', 'unavailable: 0 accepted, 0 remaining'],
    // Late signal: the stdout line says exhausted but the final sticky status is cancelled.
    ['cancelled', 3, { status: 'exhausted', accepted: ['A'], remaining: [] }, 'startled', 'cancelled: 1 accepted, 0 remaining'],
  ];
  for (const [status, code, line, mood, caption] of cases) {
    assert.deepEqual(runMascot({ status, code, line }), { mood, caption }, `${status}/${code}`);
  }
  assert.equal(runOutcome('exhausted', 4), 'unavailable');
  assert.deepEqual(runMascot({ status: 'unavailable', code: 4 }), { mood: 'dizzy', caption: 'unavailable: 0 accepted, 0 remaining' });
});

test('D: a long blocked reason is collapsed and truncated to exactly 60 characters', () => {
  const reason = 'Implementation checks\n  or review   remain unresolved after four attempts\tin the work stage loop';
  const shown = taskMascot({ status: 'blocked', id: 'OR-1' }, { reason })!;
  assert.equal(shown.mood, 'angry');
  const text = shown.caption.slice('OR-1 blocked: '.length);
  assert.equal([...text].length, 60);
  assert.ok(text.endsWith('…'));
  assert.equal(text, reason.replace(/\s+/gu, ' ').slice(0, 59) + '…');
  assert.ok(!shown.caption.includes('\n'));
  assert.equal(shortReason('x'.repeat(60)), 'x'.repeat(60));
  for (const detail of [undefined, {}, { reason: '' }, { reason: ' \n ' }]) {
    assert.deepEqual(taskMascot({ status: 'blocked', id: 'OR-1' }, detail), { mood: 'angry', caption: 'OR-1 blocked' });
  }
});

test('D: unknown statuses give no mascot and empty blockers count as none', () => {
  assert.equal(taskMascot({ status: 'recorded', id: 'A' }), undefined);
  assert.equal(runMascot({ status: 'recorded', code: 0, line: {} }), undefined);
  assert.equal(runOutcome('incomplete', 3, {}), 'incomplete-waiting');
  assert.equal(runOutcome('incomplete', 3, null), 'incomplete-waiting');
  assert.equal(runMascot({ status: 'exhausted', code: 0, line: null })!.caption, 'exhausted: 0 accepted, 0 remaining');
});

test('C: every status literal the runner and CLI can produce has exactly one mood', () => {
  const literals = new Set<string>();
  const sources = ['src/runner.ts', 'src/cli.ts'].map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  for (const source of sources) {
    for (const [, expression] of source.matchAll(/\bstatus:\s*([^,}\n]+)/gu)) {
      for (const [, literal] of expression.matchAll(/'([^']+)'/gu)) literals.add(literal);
    }
  }
  // The ternary `config.maxAccepted ? 'incomplete' : 'exhausted'` contributes both branches.
  for (const expected of ['exhausted', 'incomplete', 'limit-reached', 'cancelled', 'unavailable', 'accepted', 'blocked', 'recorded']) {
    assert.ok(literals.has(expected), expected);
  }
  const tasks: readonly string[] = TASK_EVENT_STATUSES; const runs: readonly string[] = RUN_STATUSES;
  const excluded: readonly string[] = NON_OUTCOME_STATUSES;
  for (const literal of literals) {
    const lists = [tasks, runs, excluded].filter(list => list.includes(literal));
    assert.equal(lists.length, 1, `status ${literal} must be in exactly one list`);
  }
  for (const status of tasks) {
    assert.ok(Object.hasOwn(TASK_EVENT_MOODS, status), status);
    assert.ok(taskMascot({ status, id: 'A' }));
  }
  for (const status of runs) {
    const code = status === 'unavailable' ? 4 : status === 'exhausted' || status === 'limit-reached' ? 0 : 3;
    for (const blockers of [undefined, { A: {} }]) {
      const outcome = runOutcome(status, code, blockers);
      assert.ok(outcome && Object.hasOwn(RUN_OUTCOME_MOODS, outcome), status);
    }
  }
  assert.equal(RUN_OUTCOME_MOODS[runOutcome('incomplete', 3, { A: {} })!], 'sad');
  assert.equal(RUN_OUTCOME_MOODS[runOutcome('incomplete', 3)!], 'sleepy');
  assert.deepEqual([...excluded], ['recorded']);
  assert.ok(excluded.every(status => !tasks.includes(status) && !runs.includes(status)));
  // The exclusion is only the outcome_report tool acknowledgement.
  const [runner, cli] = sources;
  assert.equal(cli.includes("'recorded'"), false);
  assert.equal(runner.split("'recorded'").length - 1, 1);
  assert.ok(runner.includes("result = input as WorkerReport; return { status: 'recorded' }"));
});

test('C: --no-mascot is accepted once in any position and refused when repeated or valued', () => {
  assert.deepEqual(parseFlags(['--model=m', '--no-mascot', '--effort=high']), { model: 'm', noMascot: true, effort: 'high' });
  assert.deepEqual(parseFlags(['--no-mascot', '--harness=codex', '--coverage=90']),
    { noMascot: true, harness: 'codex', coverage: '90' });
  assert.deepEqual(parseFlags(['--coverage=90', '--no-mascot']), { coverage: '90', noMascot: true });
  for (const args of [['--no-mascot', '--no-mascot'], ['--no-mascot=1'], ['--model=m', '--no-mascot=']]) {
    assert.throws(() => parseFlags(args), /--no-mascot, each at most once; rejected/u);
  }
});
