import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { CommandSpec, RunConfig, Work } from '../src/model.ts';
import { explainUnfinished, outsideManifest } from '../src/runner.ts';
import type { RunOptions } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { RESULT_TEST, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

// Every run uses the Git fixture of runnerFixture (a bare origin and an integrator clone), scripted adapters and the
// scripted pull request host. The target advances inside the task scope src/a from afterEffect('archive'), so the
// task enters the integrate stage with a clean merge.

const SUBJECT = 'chore(fixture): integrate main into A';
const FIX_SUBJECT = 'fix(fixture): address the integration findings of A';
const FINDING = 'The merged result needs src/a/fixed.md.';
const MARKER = 'broken.md present';
const DIRECTORY = 'openspec/changes/counter-a';
const isSendBack = (prompt: string) => prompt.includes('Address the rejection of the merged result');
const isPostMergeReview = (prompt: string) => prompt.includes('Review actual implementation') &&
  prompt.includes('review the merged result');
const isPostMergeDocumentationReview = (prompt: string) => prompt.includes('Review the documentation changes') &&
  prompt.includes('review the merged result');

interface Scenario { f: RunnerFixture; config: RunConfig; lines: string[]; prompts: string[]; refused: string[] }

/** One task A with a setup command; `extraCheck` adds a product check after the fixture checks. */
function scenario(t: TestContext, extraCheck?: CommandSpec): Scenario {
  const f = runnerFixture(t, { ids: ['A'] });
  const project = { ...f.project, setup: [{ command: 'node', args: ['-e', ''] }],
    checks: [...f.project.checks, ...(extraCheck ? [extraCheck] : [])] };
  return { f, config: f.config('one', { project }), lines: [], prompts: [], refused: [] };
}

/** Commits `content` at `path` on origin/main through the integrator clone and returns the new target. */
function advance(f: RunnerFixture, path: string, content: string): string {
  const clone = f.integrator;
  git(clone, 'fetch', '-q', 'origin'); git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');
  mkdirSync(dirname(join(clone, path)), { recursive: true }); writeFileSync(join(clone, path), content);
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', `test(fixture): advance ${path}`);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return git(clone, 'rev-parse', 'HEAD');
}

interface WorkerScript {
  /** The implementation review of the merged result rejects until src/a/fixed.md exists, or always. */
  review?: 'until-fixed' | 'always';
  /** The documentation review of the merged result rejects until src/a/fixed.md exists. */
  documentation?: 'until-fixed';
  /**
   * The send-back session: `write` writes src/a/fixed.md, `delete` deletes src/a/broken.md, `outside` first tries to
   * write the old change directory's tasks.md and then writes src/a/fixed.md.
   */
  sendBack?: 'write' | 'delete' | 'outside';
}

/** scriptedWorker plus scripted reviews of the merged result and a scripted send-back session. */
function worker(s: Scenario, script: WorkerScript) {
  const scripted = scriptedWorker();
  return (options: HarnessOptions): HarnessAdapter => {
    const inner = scripted(options);
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
    const reply = { threadId: 'fixture', events: [], text: '' } as unknown as WorkerReply;
    const fixed = () => existsSync(join(options.cwd, 'src/a/fixed.md'));
    const write = async (path: string, content: string) => {
      const before = await call('backlog_tool', { operation: 'read_file', input: { path } } as ToolInput);
      await call('backlog_tool', { operation: 'write_file', input: { path, content, expectedHash: before.hash } } as ToolInput);
    };
    const reject = async () => {
      await call('outcome_report', { outcome: 'changes-required', summary: 'Rejected', findings: [FINDING] } as ToolInput);
      return reply;
    };
    return { ...inner, async startAction(prompt: string) {
      s.prompts.push(prompt);
      if (isSendBack(prompt)) {
        if (script.sendBack === 'outside') {
          try { await write(`${DIRECTORY}/tasks.md`, '# Tasks\n'); }
          catch (error) { s.refused.push((error as Error).message); }
        }
        if (script.sendBack === 'delete') {
          const before = await call('backlog_tool', { operation: 'read_file', input: { path: 'src/a/broken.md' } } as ToolInput);
          await call('backlog_tool', { operation: 'delete_file',
            input: { path: 'src/a/broken.md', expectedHash: before.hash } } as ToolInput);
        } else if (script.sendBack) await write('src/a/fixed.md', '# Fixed\n');
        await call('outcome_report', { outcome: 'ready', summary: 'Repaired', findings: [] } as ToolInput);
        return reply;
      }
      if (isPostMergeReview(prompt) && (script.review === 'always' || script.review === 'until-fixed' && !fixed())) {
        return reject();
      }
      if (isPostMergeDocumentationReview(prompt) && script.documentation === 'until-fixed' && !fixed()) return reject();
      return inner.startAction(prompt);
    } };
  };
}

const run = (s: Scenario, script: WorkerScript, extra: RunOptions = {}) =>
  s.f.run(s.config, { steps: line => s.lines.push(line), createAdapter: worker(s, script), ...extra });
const at = (lines: string[], text: string, from = 0) => lines.findIndex((line, index) => index >= from && line.includes(text));
interface TargetFile { path: string; content: string }
/** A file the task also writes, with the same content: the advance merges cleanly inside the guarded paths. */
const TASK_FILE: TargetFile = { path: 'src/a/result.test.mjs', content: RESULT_TEST };
/** Runs task A with an advance of `file` right after the archive. */
const advanced = (s: Scenario, script: WorkerScript, file = TASK_FILE, extra: RunOptions = {}) =>
  run(s, script, { ...extra, afterEffect: async (kind, subject) => {
    if (kind === 'archive') advance(s.f, file.path, file.content);
    await extra.afterEffect?.(kind, subject);
  } });
function commits(f: RunnerFixture, subject: string, revision = 'origin/main'): string[] {
  git(f.root, 'fetch', '-q', 'origin');
  return git(f.root, 'log', '--format=%H %s', revision).split('\n').filter(line => line.endsWith(` ${subject}`))
    .map(line => line.split(' ')[0]);
}

/** The task was merged and accepted with exactly one integration that kept an accepted send-back record. */
function assertAccepted(s: Scenario, cause: string): Work {
  const state = s.f.state();
  assert.deepEqual(state.blocked ?? {}, {});
  assert.equal(s.f.records.length, 1); assert.equal(s.f.records[0].state, 'MERGED');
  const completed = state.completed.A as Work;
  assert.equal(completed.integrations!.length, 1);
  const sendBack = completed.integrations![0].sendBack!;
  assert.equal(sendBack.cause, cause); assert.equal(sendBack.session, 'finished'); assert.equal(sendBack.outcome, 'accepted');
  assert.equal(s.prompts.filter(isSendBack).length, 1);
  assert.equal(commits(s.f, SUBJECT).length, 1);
  return completed;
}

/** The prompts of the reviews of the merged result that ran after the send-back session. */
const reviewsAfterSendBack = (s: Scenario) => {
  const prompts = s.prompts.slice(s.prompts.findIndex(isSendBack));
  return { review: prompts.filter(isPostMergeReview).length,
    documentation: prompts.filter(isPostMergeDocumentationReview).length };
};

const section = (readme: string, heading: string): string => {
  const start = readme.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const level = heading.split(' ')[0];
  const next = readme.slice(start + heading.length + 2).search(new RegExp(`\\n#{1,${level.length}} `, 'u'));
  return readme.slice(start, next < 0 ? undefined : start + heading.length + 2 + next);
};

// 4.1 (E) (required)
test('E: README describes the send-back session and target-integration-rejected', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const target = section(readme, '## When the target advances during a run');
  assert.ok(target.includes('send-back session'));
  assert.ok(target.includes('After the send-back session the checks and both reviews run again.'));
  const row = target.split('\n').find(line => line.startsWith('| `target-integration-rejected` |'));
  assert.ok(row?.includes('still rejected after the one send-back session'), row);
  const budgets = section(readme, '### Review and check budgets');
  assert.ok(!budgets.includes('they block on their first failure as before'));
  assert.ok(budgets.includes('send-back session'));
  const steps = section(readme, '## Step lines');
  assert.ok(steps.includes('`send-back`'));
  assert.ok(steps.includes('blocked: stopped at send-back'));
});

// 4.2 (E) (coverage-only)
test('E: explainUnfinished reports target-integration-rejected without paths for a sent-back integration', () => {
  const work = { stage: 'integrate' as const, scopes: ['src/a'], integration: { target: 't', previousBase: 'b',
    conflicts: [], outcome: 'clean' as const, step: 'review' as const, sendBack: { cause: 'review' as const,
      findings: [FINDING], session: 'finished' as const, outcome: 'rejected' as const,
      rejection: { cause: 'review' as const, findings: [FINDING] } } } };
  const blockers = explainUnfinished({ remaining: ['A'], ids: ['A'], tasks: [{ id: 'A', dependencies: [], scopes: ['src/a'] }],
    completed: {}, done: [], baselineDone: [], foreignClaims: [], statePath: '/state/state.json',
    blocked: { A: { reason: 'target-integration-rejected', work } } });
  assert.deepEqual(blockers.A, { kind: 'blocked', stage: 'integrate', reason: 'target-integration-rejected',
    diagnostics: '/state/state.json' });
});

// 4.3 (D) (required)
test('D: an accepted send-back is logged and the merged result is checked and reviewed again before the push', async t => {
  const s = scenario(t);
  const result = await advanced(s, { review: 'until-fixed', sendBack: 'write' });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const requested = at(s.lines, ' A send-back: the implementation review did not accept the merged result; sending it back');
  const started = at(s.lines, ' A implementation: starting the send-back session of the merged result', requested);
  const committed = at(s.lines, ' A commit: committing the send-back result', started);
  const accepted = at(s.lines, ' A send-back: the merged result was accepted after the send-back session', committed);
  assert.ok(requested >= 0 && started > requested && committed > started && accepted > committed, s.lines.join(''));
  const push = at(s.lines, ' A push: ', committed);
  assert.ok(push > accepted, s.lines.join(''));
  const setup = at(s.lines, ' A setup: ', committed); const check = at(s.lines, ' A check: ', committed);
  const review = at(s.lines, ' A review: ', committed);
  const documentation = at(s.lines, ' A documentation review: ', committed);
  for (const index of [setup, check, review, documentation]) assert.ok(index > committed && index < push, s.lines.join(''));
  assert.ok(setup < check && check < review && review < documentation && documentation < accepted);
});

// 4.4 (C) (required)
test('C: a documentation review rejection of the merged result is fixed by the send-back session and accepted', async t => {
  const s = scenario(t);
  const result = await advanced(s, { documentation: 'until-fixed', sendBack: 'write' });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const [sendBack] = s.prompts.filter(isSendBack);
  assert.ok(sendBack.includes(FINDING));
  assertAccepted(s, 'document-review');
  // Both reviews ran before the send-back and both run again after it.
  assert.equal(s.prompts.filter(isPostMergeReview).length, 2);
  assert.equal(s.prompts.filter(isPostMergeDocumentationReview).length, 2);
  assert.deepEqual(reviewsAfterSendBack(s), { review: 1, documentation: 1 });
  assert.equal(git(s.f.root, 'show', 'origin/main:src/a/fixed.md'), '# Fixed');
});

// 4.5 (C) (required)
test('C: an implementation review rejection of the merged result is fixed by the send-back session and accepted', async t => {
  const s = scenario(t);
  const result = await advanced(s, { review: 'until-fixed', sendBack: 'write' });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(s.prompts.filter(isSendBack)[0].includes(FINDING));
  const completed = assertAccepted(s, 'review');
  assert.deepEqual(completed.integrations![0].sendBack!.findings, [FINDING]);
  // The implementation review runs before and after the send-back. The documentation review never started before
  // it, because the implementation review rejected first; after the send-back both reviews run.
  assert.equal(s.prompts.filter(isPostMergeReview).length, 2);
  assert.equal(s.prompts.filter(isPostMergeDocumentationReview).length, 1);
  assert.deepEqual(reviewsAfterSendBack(s), { review: 1, documentation: 1 });
  assert.ok(completed.review?.accepted);
});

// 4.6 (C) (required)
test('C: a failed check on the merged result is fixed by the send-back session with the check output', async t => {
  const script = "if (require('node:fs').existsSync('src/a/broken.md')) { console.error('broken.md present'); process.exit(1); }";
  const s = scenario(t, { command: 'node', args: ['-e', script] });
  const result = await advanced(s, { sendBack: 'delete' }, { path: 'src/a/broken.md', content: '# Advanced\n' });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(s.prompts.filter(isSendBack)[0].includes(MARKER));
  const completed = assertAccepted(s, 'checks');
  assert.ok(completed.integrations![0].sendBack!.findings.some(finding => finding.includes(MARKER)));
  assert.ok(completed.checks!.every(row => row.outcome === 'passed'));
  assert.ok(completed.finalChecks!.every(row => row.outcome === 'passed'));
  assert.deepEqual(reviewsAfterSendBack(s), { review: 1, documentation: 1 });
  assert.equal(git(s.f.root, 'ls-tree', '--name-only', 'origin/main', '--', 'src/a/broken.md'), '');
});

// 4.8 (C) (required)
test('C: the send-back session writes only inside the task scopes', async t => {
  const s = scenario(t); let worktreeHasChange: boolean | undefined;
  const result = await advanced(s, { review: 'until-fixed', sendBack: 'outside' }, TASK_FILE, {
    afterEffect: async (kind, subject) => {
      if (kind === 'send-back') worktreeHasChange = existsSync(join((subject as Work).path, DIRECTORY));
    } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(s.refused.length, 1);
  assert.equal(worktreeHasChange, false);
  const completed = assertAccepted(s, 'review');
  assert.equal(git(s.f.root, 'log', '--format=%H', `${completed.archive!.head}..origin/main`, '--', DIRECTORY), '');
  const [fix] = commits(s.f, FIX_SUBJECT);
  assert.ok(fix, 'the send-back commit was merged');
  assert.equal(git(s.f.root, 'show', '--name-only', '--format=', fix), 'src/a/fixed.md');
  const receipt = receiptAt(s.f.root, 'origin/main', 'evidence/results/A.json', hash(s.f.queue.tasks[0]), null)!;
  assert.deepEqual(outsideManifest(receipt.manifest.map(entry => entry.path), completed), []);
  assert.ok(receipt.manifest.some(entry => entry.path === 'src/a/fixed.md'));
});

// 4.9 (B) (required)
test('B: a merged result still rejected after the send-back blocks with target-integration-rejected', async t => {
  const s = scenario(t);
  const result = await advanced(s, { review: 'always', sendBack: 'write' });
  assert.equal(result.status, 'incomplete');
  const blocked = s.f.state().blocked.A;
  assert.equal(blocked.reason, 'target-integration-rejected');
  assert.equal(blocked.paths, undefined);
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.equal(result.blockers!.A.reason, 'target-integration-rejected');
  assert.equal(result.blockers!.A.paths, undefined);
  const work = blocked.work as Work;
  assert.ok(work.findings!.includes(FINDING));
  const sendBack = work.integration!.sendBack!;
  assert.equal(sendBack.outcome, 'rejected');
  assert.deepEqual(sendBack.rejection, { cause: 'review', findings: [FINDING] });
  assert.equal(s.prompts.filter(isSendBack).length, 1);
  assert.equal(git(s.f.remote, 'for-each-ref', `refs/heads/${work.branch}`), '');
  assert.equal(s.f.records.length, 0);
  assert.deepEqual(commits(s.f, SUBJECT), []);
  const rejected = at(s.lines, ' A send-back: the merged result is still rejected after the send-back session');
  assert.ok(rejected >= 0, s.lines.join(''));
  assert.ok(s.lines[rejected + 1].includes(' A blocked: stopped at send-back'), s.lines.join(''));
});

// 4.10 (B) (coverage-only): not needed: coverage reached

// 4.11 (A) (required)
test('A: a restart after the send-back session commits its result without a second session', async t => {
  const s = scenario(t); const controller = new AbortController(); let recorded: Work | undefined;
  const first = await advanced(s, { review: 'until-fixed', sendBack: 'write' }, TASK_FILE, {
    signal: controller.signal, afterEffect: async kind => {
      if (kind === 'send-back') { recorded = s.f.state().current; controller.abort(); }
    } });
  assert.equal(first.status, 'cancelled', JSON.stringify(first));
  assert.equal(recorded!.stage, 'integrate');
  assert.equal(recorded!.integration!.step, 'send-back');
  assert.deepEqual(recorded!.integration!.sendBack, { cause: 'review', findings: [FINDING], session: 'started' });
  const saved = s.f.state().current as Work;
  assert.equal(saved.integration!.step, 'send-back'); assert.equal(saved.integration!.sendBack!.session, 'started');
  const before = s.prompts.length; const restart = s.lines.length;
  const second = await run(s, { review: 'until-fixed', sendBack: 'write' });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.equal(s.prompts.slice(before).filter(isSendBack).length, 0);
  const lines = s.lines.slice(restart);
  assert.match(lines.find(line => line.includes(' A '))!, /A commit: resuming committing the send-back result/u);
  for (const text of [' A check: ', ' A review: ', ' A documentation review: ']) assert.ok(at(lines, text) >= 0, text);
  assert.equal(s.prompts.slice(before).filter(isPostMergeReview).length, 1);
  assertAccepted(s, 'review');
});

// 4.12 (A) (required)
test('A: a restart before the send-back session starts it once with a resuming line', async t => {
  const s = scenario(t); const controller = new AbortController(); let recorded: Work | undefined;
  const first = await advanced(s, { review: 'until-fixed', sendBack: 'write' }, TASK_FILE, {
    signal: controller.signal, afterEffect: async kind => {
      if (kind === 'send-back-requested') { recorded = s.f.state().current; controller.abort(); }
    } });
  assert.equal(first.status, 'cancelled', JSON.stringify(first));
  assert.equal(recorded!.integration!.step, 'send-back');
  assert.equal(recorded!.integration!.sendBack!.session, 'pending');
  assert.equal(s.prompts.filter(isSendBack).length, 0);
  const restart = s.lines.length;
  const second = await run(s, { review: 'until-fixed', sendBack: 'write' });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  const line = s.lines.slice(restart).find(text => text.includes(' A '))!;
  assert.match(line, /A implementation: resuming starting the send-back session of the merged result/u);
  assertAccepted(s, 'review');
});
