import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { git } from '../src/git.ts';
import { LEFTOVER_FILES_REVIEW, LEFTOVER_FILES_WORK } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput } from '../src/harness-adapter.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';

// 4.1 (E) (required)
test('E: the leftover file fragments name delete_file, changes-required, debug tests and findings', () => {
  assert.match(LEFTOVER_FILES_WORK, /delete_file/u);
  assert.match(LEFTOVER_FILES_WORK, /scratch or diagnostic file/u);
  assert.match(LEFTOVER_FILES_WORK, /temporary debug tests/u);
  assert.match(LEFTOVER_FILES_REVIEW, /changes-required/u);
  assert.match(LEFTOVER_FILES_REVIEW, /temporary debug test/u);
  assert.match(LEFTOVER_FILES_REVIEW, /name each such file by path in findings/u);
  // Neither fragment carries a percentage, so the coverage threshold tests stay unaffected.
  assert.doesNotMatch(LEFTOVER_FILES_WORK + LEFTOVER_FILES_REVIEW, /%/u);
});

// 4.2 (E) (required)
test('E: the leftover diagnostic test file is gone and its README check lives in the preflight tests', () => {
  assert.equal(existsSync(new URL('./zz-debug-capture.test.ts', import.meta.url)), false);
  const preflight = readFileSync(new URL('./openspec-preflight.test.ts', import.meta.url), 'utf8');
  assert.ok(preflight.includes("test('README documents the OpenSpec preflight, install offer, layout creation and " +
    "non-interactive refusals'"));
});

// Runner tests: runnerFixture with a scripted adapter wrapping scriptedWorker that records every prompt.

type Kind = 'investigate' | 'plan' | 'planReview' | 'work' | 'review' | 'document' | 'documentReview';
const kindOf = (prompt: string): Kind | undefined => prompt.includes('Inspect current files') ? 'investigate' :
  prompt.includes('Create proposal.md') ? 'plan' : prompt.includes('Review planning artifacts') ? 'planReview' :
  prompt.includes('Implement all approved') ? 'work' : prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation') ? 'documentReview' :
  prompt.includes('Review actual implementation') ? 'review' : undefined;

const LEFTOVER = 'src/a/debug-capture.test.mjs';
const FINDING = `Remove leftover diagnostic file ${LEFTOVER}`;

/**
 * A recording scripted adapter. With `leftover`, the first implementation session also writes a passing debug test,
 * the first implementation review rejects it by name and the implementation session that receives the finding
 * deletes it with delete_file.
 */
function recorded({ leftover = false } = {}) {
  const prompts: { kind: Kind; prompt: string }[] = [];
  const count = (kind: Kind) => prompts.filter(entry => entry.kind === kind).length;
  const createAdapter = (options: HarnessOptions): HarnessAdapter => {
    let kind: Kind | undefined; let number = 0; let prompt = '';
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
    const handleTool: HarnessOptions['handleTool'] = async (name, input, context) => {
      if (leftover && name === 'outcome_report') {
        if (kind === 'work' && number === 1) {
          const before = await call('backlog_tool', { operation: 'read_file', input: { path: LEFTOVER } } as ToolInput);
          await call('backlog_tool', { operation: 'write_file', input: { path: LEFTOVER,
            content: "import assert from 'node:assert/strict'; assert.equal(1 + 1, 2);\n", expectedHash: before.hash } } as ToolInput);
        }
        if (kind === 'work' && prompt.includes(FINDING)) {
          const before = await call('backlog_tool', { operation: 'read_file', input: { path: LEFTOVER } } as ToolInput);
          await call('backlog_tool', { operation: 'delete_file', input: { path: LEFTOVER, expectedHash: before.hash } } as ToolInput);
        }
        if (kind === 'review' && number === 1) {
          return options.handleTool(name, { outcome: 'changes-required', summary: 'Leftover diagnostic file',
            findings: [FINDING] }, context);
        }
      }
      return options.handleTool(name, input, context);
    };
    return scriptedWorker({
      onSession: (_options, text) => {
        kind = kindOf(text); prompt = text;
        if (!kind) return;
        prompts.push({ kind, prompt: text });
        number = count(kind);
      },
    })({ ...options, handleTool });
  };
  return { prompts, count, createAdapter, of: (kind: Kind) => prompts.filter(entry => entry.kind === kind) };
}

// 4.3 (C) (required)
test('C: an accepted run gives the leftover instructions only to implementation sessions and reviews', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = recorded();
  const result = await f.run(f.config(), { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.ok(s.count('work') >= 1); assert.ok(s.count('review') >= 1);
  for (const { prompt } of s.of('work')) {
    assert.ok(prompt.includes(LEFTOVER_FILES_WORK));
    assert.ok(prompt.indexOf('Preserve bound specs.') < prompt.indexOf(LEFTOVER_FILES_WORK));
    assert.ok(prompt.indexOf(LEFTOVER_FILES_WORK) < prompt.indexOf('Address private findings'));
  }
  for (const { prompt } of s.of('review')) assert.ok(prompt.includes(LEFTOVER_FILES_REVIEW));
  for (const kind of ['investigate', 'plan', 'planReview', 'document', 'documentReview'] as const) {
    assert.ok(s.count(kind) >= 1, kind);
    for (const { prompt } of s.of(kind)) {
      assert.ok(!prompt.includes(LEFTOVER_FILES_WORK), kind);
      assert.ok(!prompt.includes(LEFTOVER_FILES_REVIEW), kind);
    }
  }
});

// 4.4 (B) (required)
test('B: a review naming a leftover file sends the task back and the file never reaches the target', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const s = recorded({ leftover: true });
  const result = await f.run(f.config(), { createAdapter: s.createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(s.count('work'), 2); assert.equal(s.count('review'), 2);
  const [first, second] = s.of('work').map(entry => entry.prompt);
  assert.ok(!first.includes(FINDING));
  assert.ok(second.includes(FINDING)); assert.ok(second.includes(LEFTOVER_FILES_WORK));
  const instructions = (prompt: string) => prompt.slice(0, prompt.indexOf('Address private findings'));
  assert.equal(instructions(second), instructions(first));
  const reviews = f.state().completed.A.reviews;
  assert.deepEqual(reviews.map((review: { outcome: string }) => review.outcome), ['changes-required', 'accepted']);
  assert.deepEqual(reviews[0].findings, [FINDING]);
  git(f.root, 'fetch', 'origin', 'main');
  const tree = git(f.root, 'ls-tree', '-r', '--name-only', 'origin/main').split('\n');
  assert.ok(tree.includes('src/a/result.mjs'));
  assert.ok(!tree.includes(LEFTOVER));
});

// 4.5 (A) (coverage-only): not needed, coverage reached.
