import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { CheckRecord, RunConfig, Work } from '../src/model.ts';
import { IntegrationFailure, conflictMarkers, explainUnfinished } from '../src/runner.ts';
import type { PullRequestHost, RunEvent, RunOptions } from '../src/runner.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { RESULT_TEST, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

// Every run uses the Git fixture of runnerFixture (a bare origin and an integrator clone), scripted adapters and the
// scripted pull request host. The target advances by committing in the integrator clone and pushing origin/main.

const RESOLVED = 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n' +
  '// Resolved with the advanced target.\n';
const RESOLVED_TEXT = '# Resolved with the advanced target\n';
const FOREIGN = 'export function next(n) { return n + 1; }\n';
const SUBJECT = 'chore(fixture): integrate main into A';
const isPostMergeReview = (prompt: string) => prompt.includes('Review actual implementation') &&
  prompt.includes('review the merged result');
const isResolution = (prompt: string) => prompt.includes('Resolve the merge conflicts');
const isSendBack = (prompt: string) => prompt.includes('Address the rejection of the merged result');

interface Scenario { f: RunnerFixture; config: RunConfig; lines: string[]; setupLog: string; prompts: string[] }

/** One task A whose setup command appends the worktree HEAD to a log outside the worktree. */
function scenario(t: TestContext): Scenario {
  const f = runnerFixture(t, { ids: ['A'] });
  const setupLog = join(f.base, 'setup.log');
  const script = "const{execFileSync}=require('node:child_process');" +
    "require('node:fs').appendFileSync(process.argv[1],execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}))";
  const config = f.config('one', { project: { ...f.project, setup: [{ command: 'node', args: ['-e', script, setupLog] }] } });
  return { f, config, lines: [], setupLog, prompts: [] };
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
  /** `write` resolves every conflicting path, `ready` reports ready without writing, `fail` fails the session. */
  resolution?: 'write' | 'ready' | 'fail';
  /** The implementation review after the merge reports changes-required. */
  rejectMerged?: boolean;
  onPrompt?: (prompt: string) => void | Promise<void>;
}

/** scriptedWorker plus a resolution session that writes through handleTool and an optional rejecting review. */
function worker(s: Scenario, script: WorkerScript = {}) {
  const scripted = scriptedWorker();
  return (options: HarnessOptions): HarnessAdapter => {
    const inner = scripted(options);
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
    const reply = { threadId: 'fixture', events: [], text: '' } as unknown as WorkerReply;
    return { ...inner, async startAction(prompt: string) {
      s.prompts.push(prompt);
      await script.onPrompt?.(prompt);
      if (isResolution(prompt)) {
        if (script.resolution === 'fail') throw new Error('Scripted resolution failure');
        if (script.resolution !== 'ready') {
          for (const path of JSON.parse(/in these paths: (\[.*?\])\. Keep/u.exec(prompt)![1]) as string[]) {
            const before = await call('backlog_tool', { operation: 'read_file', input: { path } } as ToolInput);
            assert.ok(conflictMarkers(before.content));
            await call('backlog_tool', { operation: 'write_file', input: { path, expectedHash: before.hash,
              content: path === 'src/a/result.mjs' ? RESOLVED : RESOLVED_TEXT } } as ToolInput);
          }
        }
        await call('outcome_report', { outcome: 'ready', summary: 'Resolved', findings: [] } as ToolInput);
        return reply;
      }
      if (script.rejectMerged && isPostMergeReview(prompt)) {
        await call('outcome_report', { outcome: 'changes-required', summary: 'Rejected',
          findings: ['The merged result needs repair.'] } as ToolInput);
        return reply;
      }
      return inner.startAction(prompt);
    } };
  };
}

const run = (s: Scenario, extra: RunOptions = {}, script: WorkerScript = {}) =>
  s.f.run(s.config, { steps: line => s.lines.push(line), createAdapter: worker(s, script), ...extra });
const sessions = (work: Work, purpose: string) => (work.sessions ?? []).filter(item => item.purpose === purpose).length;
const at = (lines: string[], text: string, from = 0) => lines.findIndex((line, index) => index >= from && line.includes(text));
const passing = (rows: CheckRecord[] | undefined) => !!rows?.length && rows.every(row => row.outcome === 'passed');
function integrationCommits(f: RunnerFixture, revision = 'origin/main'): string[] {
  git(f.root, 'fetch', '-q', 'origin');
  return git(f.root, 'log', '--format=%H %s', revision).split('\n').filter(line => line.endsWith(` ${SUBJECT}`))
    .map(line => line.split(' ')[0]);
}

/** The setup and product checks and both reviews follow the line at `start` and precede the next push. */
function assertRecheckedBeforePush(lines: string[], start: number): void {
  assert.ok(start >= 0, 'start line');
  const push = at(lines, ' A push: ', start);
  assert.ok(push > start, 'a push follows');
  const setup = at(lines, ' A setup: ', start); const check = at(lines, ' A check: ', start);
  const review = at(lines, ' A review: ', start); const documentation = at(lines, ' A documentation review: ', start);
  for (const index of [setup, check, review, documentation]) assert.ok(index > start && index < push, lines.join(''));
  assert.ok(setup < check && check < review && review < documentation);
}

// 4.1 (E) (required)
test('E: explainUnfinished keeps the integration reasons and the conflicting paths', () => {
  const input = { remaining: ['A'], ids: ['A'], tasks: [{ id: 'A', dependencies: [], scopes: ['src/a'] }], completed: {},
    done: [], baselineDone: [], foreignClaims: [], statePath: '/state/state.json' };
  const work = { stage: 'integrate' as const, scopes: ['src/a'] };
  assert.deepEqual(explainUnfinished({ ...input, blocked: { A: { reason: 'target-conflict-unresolved',
    paths: ['src/a/result.mjs'], work } } }).A, { kind: 'blocked', stage: 'integrate',
    reason: 'target-conflict-unresolved', diagnostics: '/state/state.json', paths: ['src/a/result.mjs'] });
  assert.deepEqual(explainUnfinished({ ...input, blocked: { A: { reason: 'target-integration-rejected', work } } }).A,
    { kind: 'blocked', stage: 'integrate', reason: 'target-integration-rejected', diagnostics: '/state/state.json' });
  const other = explainUnfinished({ ...input, blocked: { A: { reason: 'Archive command failed',
    paths: ['src/a/result.mjs'], work } } }).A;
  assert.equal(other.reason, 'operation-incomplete'); assert.equal(other.paths, undefined);
  const failure = new IntegrationFailure('target-conflict-unresolved', ['src/a/result.mjs']);
  assert.equal(failure.message, 'target-conflict-unresolved'); assert.deepEqual(failure.paths, ['src/a/result.mjs']);
});

// 4.2 (E) (coverage-only)
test('E: conflictMarkers finds Git conflict markers and ignores Markdown underlines', () => {
  assert.equal(conflictMarkers('<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> 1234567\n'), true);
  assert.equal(conflictMarkers('kept\n>>>>>>> theirs\n'), true);
  assert.equal(conflictMarkers('export const value = 1;\n'), false);
  assert.equal(conflictMarkers('Title\n=======\n\nText with <<<<<<<inline markers.\n'), false);
});

test('E: README describes what happens when the target advances during a run', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('## When the target advances during a run');
  assert.ok(start >= 0);
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  for (const text of ['outside', 'new base', 'target-conflict-unresolved', 'target-integration-rejected', 'restart',
    'one worker session']) assert.ok(section.includes(text), text);
});

// 4.3 (D) (required)
for (const path of ['docs/other.md', 'src/a/notes.md']) test(`D: a target advance of ${path}, which the task did not ` +
  'change, is still merged, set up and finally checked without new reviews', async t => {
  const plain = scenario(t);
  assert.equal((await run(plain)).status, 'exhausted');
  const baseline = plain.f.state().completed.A as Work;
  const s = scenario(t); let base = '';
  const result = await run(s, { afterEffect: async (kind, subject) => {
    if (kind === 'archive') { base = (subject as Work).base; advance(s.f, path, '# Other\n'); }
  } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const completed = s.f.state().completed.A as Work;
  const [merge] = integrationCommits(s.f);
  assert.ok(merge, 'the branch contains the integrate merge');
  assert.equal(completed.integrations, undefined);
  assert.equal(completed.base, base);
  assert.equal(sessions(completed, 'review'), sessions(baseline, 'review'));
  assert.equal(sessions(completed, 'document-review'), sessions(baseline, 'document-review'));
  assert.ok(readFileSync(s.setupLog, 'utf8').split('\n').includes(merge));
  const integrate = at(s.lines, ' A integrate: ');
  assert.ok(integrate >= 0 && at(s.lines, ' A setup: ', integrate) > integrate);
  assert.ok(passing(completed.finalChecks));
  git(s.f.root, 'merge-base', '--is-ancestor', merge, completed.head!);
});

// 4.4 (C) (required)
test('C: a clean in-scope advance before publish is merged, re-checked, re-reviewed and receipted for the new base', async t => {
  const plain = scenario(t);
  assert.equal((await run(plain)).status, 'exhausted');
  const baseline = plain.f.state().completed.A as Work;
  const s = scenario(t); let base = ''; let target = '';
  const result = await run(s, { afterEffect: async (kind, subject) => {
    if (kind === 'archive') { base = (subject as Work).base; target = advance(s.f, 'src/a/result.test.mjs', RESULT_TEST); }
  } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const state = s.f.state();
  assert.deepEqual(state.blocked ?? {}, {});
  const completed = state.completed.A as Work;
  assert.equal(completed.integrations!.length, 1);
  assert.deepEqual(completed.integrations![0], { target, previousBase: base, conflicts: [], outcome: 'clean',
    step: 'document-review' });
  assert.equal(completed.base, target);
  assertRecheckedBeforePush(s.lines, at(s.lines, ' A integrate: '));
  const [merge] = integrationCommits(s.f);
  assert.ok(readFileSync(s.setupLog, 'utf8').split('\n').includes(merge));
  assert.ok(passing(completed.checks)); assert.ok(passing(completed.documentationChecks));
  assert.equal(sessions(completed, 'review'), sessions(baseline, 'review') + 1);
  assert.equal(sessions(completed, 'document-review'), sessions(baseline, 'document-review') + 1);
  const receipt = receiptAt(s.f.root, 'origin/main', 'evidence/results/A.json', hash(s.f.queue.tasks[0]), null)!;
  assert.ok(receipt);
  assert.equal(receipt.base, target);
  assert.equal(receipt.review.reviewer, completed.review!.reviewer);
  assert.ok(!receipt.manifest.some(entry => entry.path === 'evidence/results/A.json'));
  assert.equal(git(s.f.root, 'show', 'origin/main:src/a/result.test.mjs'), RESULT_TEST.trimEnd());
});

// 4.5 (C) (required)
test('C: an earlier acceptance is not reused when the review after a clean merge rejects it', async t => {
  const s = scenario(t);
  const result = await run(s, { afterEffect: async kind => {
    if (kind === 'archive') advance(s.f, 'src/a/result.test.mjs', RESULT_TEST);
  } }, { rejectMerged: true });
  assert.equal(result.status, 'incomplete');
  const blocked = s.f.state().blocked.A;
  assert.equal(blocked.reason, 'target-integration-rejected');
  assert.equal(blocked.paths, undefined);
  assert.equal(result.blockers!.A.reason, 'target-integration-rejected');
  assert.equal(blocked.work.review, undefined);
  assert.equal(blocked.work.head, undefined); assert.equal(blocked.work.testedTarget, undefined);
  assert.equal(git(s.f.remote, 'for-each-ref', `refs/heads/${blocked.work.branch}`), '');
  assert.equal(s.f.records.length, 0);
  assert.deepEqual(integrationCommits(s.f), []);
  // The rejected clean merge got exactly one send-back session before it blocked.
  assert.equal(s.prompts.filter(isSendBack).length, 1);
});

// 4.6 (C) (required)
for (const moment of ['pr', 'wait'] as const) {
  test(`C: an in-scope advance ${moment === 'pr' ? 'before merge' : 'while waiting for checks'} updates the same pull request`, async t => {
    const s = scenario(t); let advanced = false; let target = '';
    const host = s.f.hostFor('main');
    const wrapped: PullRequestHost = { ...host, find: branch => {
      if (moment === 'wait' && !advanced && s.f.state().current?.stage === 'merge') {
        advanced = true; target = advance(s.f, 'src/a/result.test.mjs', RESULT_TEST);
      }
      return host.find(branch);
    } };
    const result = await run(s, { host: wrapped, afterEffect: async kind => {
      if (moment === 'pr' && kind === 'pr' && !advanced) {
        advanced = true; target = advance(s.f, 'src/a/result.test.mjs', RESULT_TEST);
      }
    } });
    assert.equal(result.status, 'exhausted', JSON.stringify(result));
    assert.equal(s.f.records.length, 1); assert.equal(s.f.records[0].state, 'MERGED');
    const completed = s.f.state().completed.A as Work;
    assert.equal(completed.integrations![0].target, target);
    const integrate = at(s.lines, ' A integrate: ');
    assert.ok(at(s.lines, ' A push: ') < integrate);
    assertRecheckedBeforePush(s.lines, integrate);
    assert.equal(git(s.f.root, 'show', 'origin/main:src/a/result.test.mjs'), RESULT_TEST.trimEnd());
  });
}

// 4.7 (B) (required)
test('B: a conflicting in-scope advance is resolved by the worker, re-checked, re-reviewed and merged', async t => {
  const s = scenario(t); let base = ''; let target = '';
  const result = await run(s, { afterEffect: async (kind, subject) => {
    if (kind === 'archive') { base = (subject as Work).base; target = advance(s.f, 'src/a/result.mjs', FOREIGN); }
  } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const resolutions = s.prompts.filter(isResolution);
  assert.equal(resolutions.length, 1); assert.ok(resolutions[0].includes('src/a/result.mjs'));
  const completed = s.f.state().completed.A as Work;
  assert.deepEqual(completed.integrations, [{ target, previousBase: base, conflicts: ['src/a/result.mjs'],
    outcome: 'conflict', step: 'document-review' }]);
  assertRecheckedBeforePush(s.lines, at(s.lines, ' A implementation: starting the conflict resolution session'));
  assert.equal(git(s.f.root, 'show', 'origin/main:src/a/result.mjs') + '\n', RESOLVED);
  assert.equal(integrationCommits(s.f).length, 1);
});

// 4.8 (B) (required)
for (const failure of ['fails', 'markers'] as const) {
  test(`B: an unresolved conflict blocks with its paths when the resolution ${failure === 'fails' ? 'session fails' :
    'leaves markers'}`, async t => {
    const s = scenario(t); const reports: { event: RunEvent; detail?: { reason?: string } }[] = [];
    const result = await run(s, { report: (event, detail) => reports.push({ event, detail }),
      afterEffect: async kind => { if (kind === 'archive') advance(s.f, 'src/a/result.mjs', FOREIGN); } },
    { resolution: failure === 'fails' ? 'fail' : 'ready' });
    assert.equal(result.status, 'incomplete');
    const blocked = s.f.state().blocked.A;
    assert.equal(blocked.reason, 'target-conflict-unresolved');
    assert.deepEqual(blocked.paths, ['src/a/result.mjs']);
    assert.equal(result.blockers!.A.kind, 'blocked');
    assert.equal(result.blockers!.A.reason, 'target-conflict-unresolved');
    assert.deepEqual(result.blockers!.A.paths, ['src/a/result.mjs']);
    const report = reports.find(entry => entry.event.status === 'blocked');
    assert.equal(report?.detail?.reason, 'target-conflict-unresolved');
    assert.equal(s.f.records.length, 0);
    assert.equal(s.prompts.filter(isResolution).length, 1);
    assert.equal(s.prompts.filter(isSendBack).length, 0);
  });
}

test('B: a resolved conflict still rejected after its send-back blocks with target-integration-rejected', async t => {
  const s = scenario(t);
  const result = await run(s, { afterEffect: async kind => { if (kind === 'archive') advance(s.f, 'src/a/result.mjs', FOREIGN); } },
    { resolution: 'write', rejectMerged: true });
  assert.equal(result.status, 'incomplete');
  assert.equal(s.f.state().blocked.A.reason, 'target-integration-rejected');
  assert.equal(result.blockers!.A.reason, 'target-integration-rejected');
  assert.equal(result.blockers!.A.paths, undefined);
  assert.equal(s.prompts.filter(isResolution).length, 1);
  assert.equal(s.prompts.filter(isSendBack).length, 1);
  assert.equal(s.f.records.length, 0);
});

// 4.9 (B) (required)
test('B: a conflict outside the task scopes is resolved by the session and the task is accepted', async t => {
  const s = scenario(t); let path = '';
  const result = await run(s, { afterEffect: async (kind, subject) => {
    if (kind === 'archive') {
      path = `${(subject as Work).archive!.directory}/tasks.md`;
      advance(s.f, path, '# Foreign tasks\n');
    }
  } }, { resolution: 'write' });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const [integration] = (s.f.state().completed.A as Work).integrations!;
  assert.equal(integration.outcome, 'conflict'); assert.deepEqual(integration.conflicts, [path]);
  assert.equal(s.prompts.filter(isResolution).length, 1);
  assert.equal(git(s.f.root, 'show', `origin/main:${path}`), RESOLVED_TEXT.trimEnd());
});

// 4.10 (A) (required)
for (const boundary of ['integrate', 'review'] as const) {
  test(`A: a cancelled integration resumes at the recorded step after a restart (${boundary})`, async t => {
    const s = scenario(t); const controller = new AbortController(); let base = ''; let target = '';
    let recorded: Work | undefined;
    const first = await run(s, { signal: controller.signal, afterEffect: async (kind, subject) => {
      if (kind === 'archive') { base = (subject as Work).base; target = advance(s.f, 'src/a/result.mjs', FOREIGN); }
      if (kind === 'integrate' && boundary === 'integrate') { recorded = s.f.state().current; controller.abort(); }
    } }, { onPrompt: prompt => {
      if (boundary === 'review' && isPostMergeReview(prompt) && !controller.signal.aborted) {
        controller.abort(); throw new Error('Cancelled during the review');
      }
    } });
    assert.equal(first.status, 'cancelled', JSON.stringify(first));
    if (boundary === 'integrate') {
      assert.equal(recorded!.stage, 'integrate');
      assert.equal(recorded!.base, target);
      assert.deepEqual(recorded!.integration, { target, previousBase: base, conflicts: ['src/a/result.mjs'],
        outcome: 'conflict', step: 'resolve' });
      assert.equal(s.prompts.filter(isResolution).length, 0);
    } else {
      assert.equal(s.f.state().current.integration.step, 'review');
      assert.equal(s.prompts.filter(isResolution).length, 1);
    }
    const before = s.prompts.length; const restartLines = s.lines.length;
    const second = await run(s);
    assert.equal(second.status, 'exhausted', JSON.stringify(second));
    const resumed = s.lines.slice(restartLines).find(line => line.includes(' A '));
    assert.match(resumed!, boundary === 'integrate' ? /A implementation: resuming starting the conflict resolution session/u :
      /A review: resuming starting the implementation review session of the merged result/u);
    const restarted = s.prompts.slice(before);
    assert.equal(restarted.filter(isResolution).length, boundary === 'integrate' ? 1 : 0);
    assert.equal(restarted.filter(isPostMergeReview).length, 1);
    assert.equal(s.prompts.filter(isResolution).length, 1);
    const completed = s.f.state().completed.A as Work;
    assert.equal(completed.base, target);
    assert.equal(completed.integrations!.length, 1);
    assert.equal(integrationCommits(s.f).length, 1);
    assert.equal(git(s.f.root, 'show', 'origin/main:src/a/result.mjs') + '\n', RESOLVED);
  });
}
