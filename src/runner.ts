import { cancellable, tokenUsage } from './statistics.ts';
import type { Sources, Statistics } from './statistics.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { hash, digest, within, safePath, validateConfig, validateQueue, archiveCommand, isDocumentation,
  specsDirectory } from './model.ts';
import type { CheckRecord, CommandSpec, PullRequest, Purpose, Queue, ReviewRecord, RunConfig, Task, Work,
  WorkerReport, TaskCompletion } from './model.ts';
import { command, git, gitPage, fileAt, receiptAt, GitHubHost, assertOriginHead, MERGE_STATE_VIEWS, MERGE_STATE_POLL_MS } from './git.ts';
import { pageOffset, readPage } from './text-page.ts';
import { RunStore } from './run-store.ts';
import { buildCompletion, validCompletion } from './completion.ts';
import { ClaimLedger } from './claims.ts';
import { CodexFiles, brokerTool } from './codex-files.ts';
import { resolveHarness, createHarness, codexSelection } from './harness.ts';
import { selectHarness } from './harness-selection.ts';
import type { SelectionDeps } from './harness-selection.ts';
import { openspecPreflight } from './openspec-preflight.ts';
import type { PreflightDeps } from './openspec-preflight.ts';
import { testFrameworkPreflight } from './test-framework-preflight.ts';
import type { TestFrameworkDeps } from './test-framework-preflight.ts';
import { planTestInstructions, planningReviewTestInstructions, workTestInstructions,
  implementationReviewTestInstructions } from './test-grading.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolDefinition } from './harness-adapter.ts';

export interface PullRequestHost {
  find(branch: string): PullRequest | null | Promise<PullRequest | null>;
  create(work: Work, body: string): PullRequest | null | Promise<PullRequest | null>;
  merge(pr: PullRequest, head: string): void | Promise<void>;
}

export interface RunEvent { status: string; id: string; summary?: string; durationSeconds?: number; grade?: TaskCompletion['grade'] }

export interface RunResult {
  status: string;
  accepted: string[];
  remaining: string[];
  completions: Record<string, TaskCompletion>;
  blockers?: Record<string, { stage?: Work['stage']; reason: string; diagnostics: string }>;
  claimedElsewhere?: Record<string, { host?: string }>;
}

/** Runs one program with an argument array and no shell in `cwd`; throws on a nonzero exit. */
export type CommandRunner = (cwd: string, program: string, args: string[]) => string;

export interface RunOptions {
  statistics?: Statistics;
  signal?: AbortSignal;
  now?: () => number;
  mergePolling?: import('./git.ts').MergePolling;
  host?: PullRequestHost;
  createAdapter?: (options: HarnessOptions) => HarnessAdapter;
  afterEffect?: (operation: string, subject: Work | PullRequest | null) => Promise<void>;
  /** Reports a task event; `detail` is private (for example the blocked reason) and is never serialized. */
  report?: (event: RunEvent, detail?: { reason?: string }) => void;
  /** Injectable effects of the OpenSpec preflight; omitted fields use the real process, TTY and filesystem. */
  openspec?: Partial<PreflightDeps>;
  /** Injectable prompts, harness probes, Codex reader and recorded state of the harness selection. */
  selection?: Partial<SelectionDeps>;
  /** Injectable session, worktree, prompts, installs, writes and snapshots of the test framework preflight. */
  testFramework?: Partial<TestFrameworkDeps>;
  /** Injectable runner of the archive command; the default executes the program without a shell. */
  runCommand?: CommandRunner;
}

interface CommandFailure extends Error { stderr?: string | Buffer; stdout?: string | Buffer }
interface InterruptedFailure extends Error { interrupted?: boolean }

const failureDetail = (error: unknown): string => {
  const { stderr, message } = error as CommandFailure;
  return String(stderr ?? message).slice(-16000);
};

const checkRecords = (rows: CheckRecord[]) => rows.map(({ command, args, outcome }) => ({ command, args, outcome }));
const reviewRecord = ({ reviewer, outcome }: ReviewRecord) => ({ reviewer, outcome });
const scopesOverlap = (first: string[], second: string[]): boolean => first.some(path =>
  second.some(other => within(path, other) || within(other, path)));
const DOCUMENTATION_ROUNDS = 4;

/** Paths a result manifest may contain: the task scopes and, after the archive, the archived change and its spec files. */
export function manifestScopes(work: Pick<Work, 'scopes' | 'directory' | 'archive'>): string[] {
  return work.archive ? [...work.scopes, work.archive.directory, ...work.archive.specs] : [...work.scopes, work.directory];
}

/** Manifest paths outside the allowed set; any such path blocks the task. */
export const outsideManifest = (paths: string[], work: Pick<Work, 'scopes' | 'directory' | 'archive'>): string[] =>
  paths.filter(path => !manifestScopes(work).some(scope => within(path, scope)));

/** Moves every bound path below `directory` to the same relative path below `archived`. */
export function rekeyBinding(specification: Record<string, string>, directory: string, archived: string): Record<string, string> {
  return Object.fromEntries(Object.entries(specification).map(([path, value]) =>
    [within(path, directory) ? `${archived}${path.slice(directory.length)}` : path, value]));
}

/** The pull request body; it lists only public evidence, the updated documentation and the archived change. */
export function pullRequestBody(work: Work, authority: string): string {
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- none';
  const outside = work.documentation?.outsideScope ?? [];
  return `Outcome: ${work.id}\nOpenSpec change: ${work.change}\n` +
    `Authority: ${authority}\nTested head: ${work.head}\nTarget: ${work.testedTarget}\n` +
    `Checks: ${JSON.stringify(checkRecords(work.finalChecks ?? []))}\n` +
    `Reviews: ${JSON.stringify((work.reviews ?? []).map(reviewRecord))}\n` +
    `Documentation reviews: ${JSON.stringify((work.documentationReviews ?? []).map(reviewRecord))}\n` +
    `Documentation updated:\n${list(work.documentation?.files ?? [])}\n` +
    `Archived change: ${work.archive?.directory ?? 'none'}\n` +
    (outside.length ? `Documentation outside scope:\n${list(outside)}\n` : '');
}

const reportTool: ToolDefinition = { type: 'function', name: 'outcome_report',
  description: 'Return a private structured result to the automatic controller.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { outcome: { type: 'string', enum: ['ready', 'accepted', 'changes-required', 'blocked'] },
      summary: { type: 'string' }, inspected: { type: 'array', items: { type: 'string' } },
      findings: { type: 'array', items: { type: 'string' } },
      completion: { type: 'object', additionalProperties: false,
        properties: { summary: { type: 'string', minLength: 1 },
          grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] } },
        required: ['summary', 'grade'] } }, required: ['outcome', 'summary', 'findings'] } };

export function packet(root: string, directory: string): Record<string, string> {
  const paths = ['proposal.md', 'design.md'];
  const walk = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Specification symlink is forbidden');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) paths.push(child.slice(directory.length + 1));
    }
  };
  walk(`${directory}/specs`);
  if (!paths.some(path => path.startsWith('specs/') && path.endsWith('/spec.md')) ||
      !existsSync(join(root, directory, 'tasks.md'))) throw new Error('Incomplete OpenSpec packet');
  return Object.fromEntries(paths.sort().map(path => {
    const file = `${directory}/${safePath(path)}`;
    if (lstatSync(join(root, file)).isSymbolicLink()) throw new Error('Specification symlink is forbidden');
    const content = readFileSync(join(root, file));
    if (!content.length) throw new Error('Empty OpenSpec artifact');
    return [file, digest(content)];
  }));
}

export async function runQueue(requested: RunConfig, options: RunOptions = {}): Promise<RunResult> {
  // The OpenSpec preflight precedes the harness availability check and selection, harness resolution,
  // the test framework analysis, the lock, claims and worktrees.
  const statistics = options.statistics;
  const signal = options.signal;
  await cancellable(openspecPreflight(requested, { ...options.openspec, signal }), signal);
  // Selected values enter the configuration before it is hashed, so they are frozen exactly like flags.
  // A Codex selection reads Codex once; resolution reuses that read instead of opening another session.
  let sources: Sources = {}; let harnessVersion: string | undefined;
  const { config: selected, codex } = await cancellable(selectHarness(requested, {
    ...options.selection, signal, sources: statistics?.sources,
    onSetting: (key, value, source) => statistics?.setting(key, value, source),
    onResolved: (config, resolvedSources, version) => {
      sources = resolvedSources; harnessVersion = version;
      if (config.harness) statistics?.setting('harness', config.harness, sources.harness ?? 'default');
      if (version !== undefined) statistics?.setting('harnessCliVersion', version, sources.harness ?? 'default');
    },
  }), signal);
  const config = await cancellable(resolveHarness(selected, codex ? async () => codex :
    cwd => codexSelection(cwd, undefined, signal)), signal);
  validateConfig(config);
  statistics?.resolved(config, sources, harnessVersion);
  const { afterEffect = async () => {}, report = () => {}, now = Date.now, runCommand = command } = options;
  const createAdapter = options.createAdapter ?? ((adapterOptions: HarnessOptions) => createHarness(adapterOptions, config));
  // One read-only analysis of origin/<target> with the resolved harness, model and effort precedes the lock and claims.
  await cancellable(testFrameworkPreflight(config, { createAdapter, signal, ...options.testFramework }), signal);
  const root = realpathSync(config.root); const project = config.project;
  const primary = dirname(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
  let stateAncestor = resolve(config.stateDirectory); const missing: string[] = [];
  while (!existsSync(stateAncestor)) { missing.unshift(stateAncestor.split('/').at(-1)!); stateAncestor = dirname(stateAncestor); }
  const statePath = join(realpathSync(stateAncestor), ...missing);
  if (within(statePath, primary)) throw new Error('State must be outside the primary checkout');
  const lockRoot = join(dirname(primary), '.work-queue-locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(lockRoot, `${hash(primary)}.sqlite`));
  let store!: RunStore; let adapter: HarnessAdapter | null | undefined; let stopped = false;
  const ownershipFile = join(lockRoot, `${hash(primary)}-owner.json`);
  const stop = () => {
    stopped = true;
    if (store?.state.current) statistics?.decision(store.state.current, 'blocked', store.state.current, 'cancelled');
    try { adapter?.close(); } catch { /* Cancellation still reaches the guarded CLI finalizer. */ }
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    if (existsSync(ownershipFile)) {
      const previous = JSON.parse(readFileSync(ownershipFile, 'utf8'));
      if (!previous.released && (previous.identity !== hash(config) ||
          previous.stateDirectory !== resolve(config.stateDirectory))) {
        throw new Error('Another durable invocation owns unfinished work in this repository');
      }
    }
    const ownership = { identity: hash(config), stateDirectory: resolve(config.stateDirectory), released: false };
    const release = () => writeFileSync(ownershipFile, JSON.stringify({ ...ownership, released: true }));
    const refresh = () => {
      git(root, 'fetch', 'origin', project.target);
      const target = git(root, 'rev-parse', `origin/${project.target}`);
      const queue = validateQueue(JSON.parse(fileAt(root, target, project.queue).toString()), project);
      return { target, queue };
    };
    const initial = refresh();
    const ids = config.leaves ?? Object.keys(config.authority.tasks);
    if (!ids.length || ids.some(id => !initial.queue.tasks.some(task => task.id === id) ||
        !config.authority.tasks[id])) throw new Error('Selected outcomes lack authority');
    ids.forEach(id => {
      if (hash(initial.queue.tasks.find(task => task.id === id)) !== config.authority.tasks[id]) {
        throw new Error('Task source differs from frozen authority');
      }
    });
    store = new RunStore(config.stateDirectory, { ...config, root, leaves: ids }, { repositoryRoot: root });
    sources = store.state.statisticsSources ?? sources;
    if (!store.state.statisticsSources) store.update({ statisticsSources: sources });
    statistics?.resolved(config, sources, harnessVersion);
    statistics?.setting('leaves', [...ids], sources.leaves ?? 'default');
    writeFileSync(ownershipFile, JSON.stringify(ownership), { mode: 0o600 });
    const host: PullRequestHost = options.host ?? new GitHubHost(root, project);
    const ledger = new ClaimLedger(root, project.target);
    if (!store.state.claimant) store.update({ claimant: randomUUID() });
    const claimant = store.state.claimant!;
    const commitSubject = (type: string, text: string) => `${type}(${project.commitScope ?? 'work-queue'}): ${text}${project.commitSuffix ?? ''}`;
    const save = (fields: Partial<Work>) => {
      const result = store.update({ current: { ...store.state.current, ...fields } as Work });
      statistics?.decision(result.current!, 'blocked', result.current!);
      return result;
    };
    const activeWork = () => store.state.current as Work;
    const rememberPr = (pr: PullRequest) => {
      const previous = activeWork().pr;
      save({ pr: { ...pr, url: pr.url ?? (previous?.number === pr.number ? previous.url : undefined) } });
    };
    const authorized = (queue: Queue, id: string): Task => {
      const task = queue.tasks.find(item => item.id === id);
      if (!task || hash(task) !== config.authority.tasks[id]) throw new Error('Task source differs from frozen authority');
      return task;
    };
    const receiptPath = (id: string) => `${project.receipts}/${id}.json`;
    const accepted = (target: string, task: Task) => receiptAt(root, target, receiptPath(task.id),
      hash(task), null);
    const assertWork = (work: Work): boolean => {
      const { queue } = refresh(); authorized(queue, work.id);
      if (git(work.path, 'branch', '--show-current') !== work.branch) throw new Error('Work branch changed');
      // After the archive the binding follows the files, so integrity checks read the archived change.
      const directory = work.archive?.directory ?? work.directory;
      if (work.specification && hash(packet(work.path, directory)) !== hash(work.specification)) {
        throw new Error('Exact specification changed after authorization');
      }
      return true;
    };
    const checks = (work: Work, definitions: CommandSpec[]): CheckRecord[] => {
      const rows: CheckRecord[] = [];
      const finalGate = definitions === project.checks && activeWork()?.stage === 'publish';
      for (const check of definitions) {
        const args = check.args.map(arg => arg.replaceAll('{change}', work.change)
          .replaceAll('{target}', project.target).replaceAll('{scope}', work.scopes[0])
          .replaceAll('{coverage}', String(config.coverage)));
        try {
          const output = command(work.path, check.command, args);
          rows.push({ command: check.command, args, outcome: 'passed', output: output.slice(-16000) });
        } catch (error) {
          rows.push({ command: check.command, args, outcome: 'failed' });
          if (finalGate) save({ finalChecks: rows });
          throw error;
        }
        if (finalGate) save({ finalChecks: rows });
      }
      return rows;
    };
    const commit = (work: Work): void => {
      git(work.path, 'add', '--', ...work.scopes, work.directory);
      if (git(work.path, 'diff', '--cached', '--name-only')) {
        git(work.path, 'commit', '-m', `feat(${project.commitScope ?? 'work-queue'}): implement ${work.id}${project.commitSuffix ?? ''}`);
      }
    };
    // Only documentation files inside the task scopes enter the documentation commit.
    const commitDocumentation = (work: Work): void => {
      const changed = git(work.path, 'ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard', '--',
        ...work.scopes).split('\0').filter(Boolean);
      const files = [...new Set(changed)].filter(isDocumentation);
      if (files.length) git(work.path, 'add', '-A', '--', ...files);
      if (git(work.path, 'diff', '--cached', '--name-only')) {
        git(work.path, 'commit', '-m', commitSubject('docs', `document ${work.id}`));
      }
    };
    const integrateTarget = (work: Work, target: string): void => {
      if (git(work.path, 'merge-base', target, 'HEAD') === target) return;
      const changed = git(work.path, 'diff', '--name-only', work.base, target).split('\n').filter(Boolean);
      const archive = activeWork().archive;
      // The archived change and the specification files written by the archive belong to the task like its scopes.
      const guarded = [...work.scopes, work.directory, ...(archive ? [archive.directory, ...archive.specs] : [])];
      if (scopesOverlap(changed, guarded)) throw new Error('Target changed outcome scope');
      git(work.path, 'merge', '--no-edit', '-m', commitSubject('chore', `integrate ${project.target} into ${work.id}`), target);
      checks(work, project.setup ?? []);
    };
    const runProductChecks = (work: Work): CheckRecord[] => {
      try { return checks(work, project.checks); }
      catch (error) { throw new Error(failureDetail(error)); }
    };
    const readContext = async (work: Work, files: string[], { section = 'paths', offset: requested }: Partial<BrokerInput>) => {
      const offset = pageOffset(requested);
      if (section === 'paths') {
        return { section, files: files.slice(offset, offset + 200),
          nextOffset: offset + 200 < files.length ? offset + 200 : null,
          history: git(work.path, 'log', '-5', '--oneline') };
      }
      if (section === 'diff') return { section, ...await gitPage(work.path, offset, 'diff', work.base) };
      if (section !== 'findings' && section !== 'checks') throw new Error('Unknown context section');
      return { section, ...await readPage([Buffer.from(JSON.stringify(activeWork()[section] ?? []))], offset) };
    };
    const session = async (work: Work, purpose: Purpose, prompt: string, implementationReview = false): Promise<ReviewRecord> => {
      let result: WorkerReport | undefined;
      const files = git(work.path, 'ls-files', '-z').split('\0').filter(Boolean);
      const instructionPaths = [...new Set(['AGENTS.md', ...[...work.scopes, work.directory].flatMap(path =>
        path.split('/').map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/AGENTS.md`))])];
      // A documentation session writes inside the task scopes, and only documentation files there.
      const writable = purpose === 'plan' ? [work.directory] : purpose === 'work' ?
        [...work.scopes, `${work.directory}/tasks.md`, `${work.directory}/compliance.md`,
          `${work.directory}/verification.md`] : purpose === 'document' ? [...work.scopes] : [];
      const broker = new CodexFiles({ root: work.path,
        scopes: [...files.map(path => ({ path, mode: 'read' })),
          ...instructionPaths.map(path => ({ path, mode: 'read' })), ...work.scopes.map(path => ({ path, mode: 'read' })),
          { path: work.directory, mode: 'read' }, ...writable.map(path => ({ path, mode: 'write' }))],
        store, identity: { id: work.id, operation: work.operation, purpose },
        revalidate: async () => assertWork(activeWork()) });
      signal?.throwIfAborted();
      let usage: ReturnType<Statistics['session']> | undefined;
      adapter = createAdapter({ cwd: work.path, tools: [brokerTool, reportTool], onUsage: value => usage?.(value),
        onHandle: handle => save({ session: { purpose, ...handle } }),
        handleTool: async (name, input) => {
          signal?.throwIfAborted();
          if (name === brokerTool.name && input.operation === 'run_checks') {
            if (!['work', 'review'].includes(purpose) || !activeWork().specification) {
              throw new Error('Product checks require a bound specification');
            }
            assertWork(activeWork()); commit(work);
            const evidence = runProductChecks(work); save({ checks: evidence });
            return { checks: checkRecords(evidence) };
          }
          if (name === brokerTool.name && input.operation === 'context') {
            return readContext(work, files, input.input ?? {});
          }
          if (name === brokerTool.name) {
            try {
              if (purpose === 'document' && ['write_file', 'delete_file'].includes(input.operation ?? '') &&
                  !isDocumentation(String(input.input?.path ?? ''))) {
                throw new Error('Documentation sessions write only documentation files inside the task scopes');
              }
              return await broker.call(name, input);
            }
            catch (error) { save({ lastToolError: { purpose, input, message: (error as Error).message } }); throw error; }
          }
          if (name === reportTool.name) save({ lastReportAttempt: { purpose, input } });
          if (name !== reportTool.name || !input.outcome || !['ready', 'accepted', 'changes-required', 'blocked'].includes(input.outcome) ||
              !input.summary || !Array.isArray(input.findings) ||
              input.findings.some(f => typeof f !== 'string' || !f)) throw new Error('Invalid private report');
          if (Object.hasOwn(input, 'completion') && !validCompletion(input.completion) ||
              implementationReview && input.outcome === 'accepted' && !validCompletion(input.completion)) {
            throw new Error('Invalid private report');
          }
          if (purpose === 'investigate' && !input.inspected?.length) throw new Error('Investigation references required');
          result = input as WorkerReport; return { status: 'recorded' };
        } });
      try {
        if (adapter.probe().status !== 'interface-ready') throw new Error('Selected harness interface unavailable');
      const starts = activeWork().sessionStarts ?? Object.fromEntries(
        (['investigate', 'plan', 'work', 'review', 'document', 'document-review'] as const).map(key =>
          [key, (activeWork().sessions ?? []).filter(session => session.purpose === key).length]));
      save({ sessionStarts: { ...starts, [purpose]: (starts[purpose] ?? 0) + 1 } });
      usage = statistics?.session(work.id);

        const reply = await cancellable(adapter.startAction('OFF. Never ask a person anything. All output is private. ' +
          'Use only backlog_tool operations read_file/write_file/delete_file/context/run_checks and outcome_report. ' +
          'Read files with input {path,offset}; write with {path,content,expectedHash} from the read result; ' +
          'delete a file with {path,expectedHash} from the read result. ' +
          'A read returns one page: repeat it with nextOffset until nextOffset is null. hash covers the whole file. ' +
          'context takes input {section,offset} and pages the same way. section is paths (default, with history), ' +
          'diff, findings or checks. ' +
          'run_checks takes input {} and runs only frozen project checks after specification binding; ' +
          'read their output through the checks section. ' +
          'Read applicable AGENTS.md. Report blockers privately. No shell or approval tools.\n' +
          `Resolved coverage threshold: ${config.coverage}%.\n` + prompt), signal);
        for (const event of reply.events) {
          if (event.type === 'token-usage') usage?.(tokenUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens }));
        }
        save({ sessions: [...(activeWork().sessions ?? []), {
          purpose, threadId: reply.threadId, events: reply.events, privateText: reply.text }] });
        if (!result || result.outcome === 'blocked') throw new Error(`Worker ${purpose} incomplete`);
        return { ...result, reviewer: `${config.harness}:${reply.threadId}` };
      } finally { try { adapter?.close(); } finally { adapter = null; } }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const recovery = Object.values(store.state.blocked ?? {}).map(entry => entry.work).filter(Boolean);
    for (const work of recovery.filter(work => ids.includes(work.id))) statistics?.decision(work, 'blocked', work);
    if (store.state.current) statistics?.decision(store.state.current, 'blocked', store.state.current);
    store.update({ blocked: {} });
    for (;;) {
      await yieldLoop();
      if (signal?.aborted) stopped = true;
      const { target, queue } = refresh();
      const completed = { ...(store.state.completed ?? {}) };
      const done = new Set<string>();
      for (const task of queue.tasks) {
        if (ids.includes(task.id)) authorized(queue, task.id);
        if (accepted(target, task)) done.add(task.id);
      }
      if (!store.state.baselineDone) store.update({ baselineDone: [...done] });
      if (!store.state.current && recovery.length) save(recovery.shift()!);
      const current = store.state.current;
      const recoverClaimTime = (work: Work): string => {
        if (work.claimedAt && Number.isFinite(Date.parse(work.claimedAt))) return work.claimedAt;
        const claim = ledger.pull().claims.get(work.id);
        if (!claim || claim.claimant !== claimant || claim.taskHash !== work.taskHash ||
            claim.branch !== work.branch || hash(claim.scopes) !== hash(work.scopes) ||
            !claim.claimedAt || !Number.isFinite(Date.parse(claim.claimedAt))) {
          throw new Error('Cannot recover original claim timestamp from matching owned ledger claim');
        }
        return claim.claimedAt;
      };
      const resultData = (acceptedIds: string[]) => ({
        accepted: acceptedIds,
        completions: Object.fromEntries(acceptedIds.flatMap(id =>
          completed[id]?.completion ? [[id, completed[id].completion]] : [])) as Record<string, TaskCompletion>,
      });
      if (current && done.has(current.id)) {
        try {
          const claimedAt = recoverClaimTime(current);
          const acceptedAt = new Date(now()).toISOString();
          const completion = buildCompletion(current.review?.completion, claimedAt, acceptedAt);
          let pr = current.pr;
          if (pr && !pr.url) {
            const found = await cancellable(Promise.resolve(host.find(current.branch)), signal);
            if (found?.number === pr.number) pr = { ...pr, url: found.url };
          }
          const finished = { ...current, pr, claimedAt, acceptedAt, completion, acceptedTarget: target };
          store.update({ current: null, completed: { ...completed, [current.id]: finished } });
          completed[current.id] = finished;
          statistics?.decision(finished, 'accepted', finished);
        } catch (error) {
          store.update({ blocked: { ...store.state.blocked, [current.id]: {
            reason: failureDetail(error), work: current } }, current: null });
          const acceptedIds = Object.keys(completed).filter(id => done.has(id) && !store.state.baselineDone!.includes(id));
          return { status: 'incomplete', ...resultData(acceptedIds), remaining: ids.filter(id => !done.has(id)),
            blockers: { [current.id]: { stage: current.stage, reason: 'operation-incomplete', diagnostics: join(store.directory, 'state.json') } } };
        }
        report({ status: 'accepted', id: current.id, ...completed[current.id].completion });
      }
      const newlyAccepted = Object.keys(completed).filter(id => done.has(id) && !store.state.baselineDone!.includes(id));
      const remaining = ids.filter(id => !done.has(id));
      for (const task of queue.tasks.filter(task => remaining.includes(task.id))) {
        if (task.id === store.state.current?.id) statistics?.decision(task, 'blocked', store.state.current!);
        else if (store.state.blocked?.[task.id]) statistics?.decision(task, 'blocked', store.state.blocked[task.id].work);
        else statistics?.decision(task);
      }
      if (config.maxAccepted && newlyAccepted.length >= config.maxAccepted) {
        if (!Object.keys(store.state.blocked!).length && !store.state.current && !recovery.length) release();
        return { status: 'limit-reached', ...resultData(newlyAccepted), remaining };
      }
      if (!remaining.length) {
        release();
        return { status: config.maxAccepted ? 'incomplete' : 'exhausted', ...resultData(newlyAccepted), remaining };
      }
      if (stopped) return { status: 'cancelled', ...resultData(newlyAccepted), remaining };
      let work = store.state.current;
      if (!work) {
        const ledgerSnapshot = ledger.pull();
        const foreignClaims = [...ledgerSnapshot.claims.values()]
          .filter(claim => claim.claimant !== claimant && !done.has(claim.id));
        for (const candidate of queue.tasks.filter(task => remaining.includes(task.id))) {
          if (foreignClaims.some(claim => claim.id === candidate.id || scopesOverlap(claim.scopes, candidate.scopes))) {
            statistics?.decision(candidate, 'claimed-elsewhere');
          }
        }
        const task = queue.tasks.filter(task => remaining.includes(task.id) && !store.state.blocked![task.id] &&
          task.dependencies.every(id => done.has(id)) &&
          !foreignClaims.some(claim => claim.id === task.id || scopesOverlap(claim.scopes, task.scopes)) &&
          !Object.values(store.state.blocked!).some(entry => entry.work && scopesOverlap(entry.work.scopes, task.scopes)))
          .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
        if (!task) return { status: 'incomplete', ...resultData(newlyAccepted), remaining,
          blockers: Object.fromEntries(Object.entries(store.state.blocked!).map(([id, entry]) =>
            [id, { stage: entry.work?.stage, reason: 'operation-incomplete',
              diagnostics: join(store.directory, 'state.json') }])),
          claimedElsewhere: Object.fromEntries(foreignClaims.map(claim => [claim.id, { host: claim.host }])) };
        const operation = hash({ invocation: config.invocation, id: task.id, authority: config.authority.reference });
        const branch = `outcome/${task.id}-${operation.slice(0, 12)}`;
        if (!ledgerSnapshot.claims.has(task.id) && !ledger.acquire(ledgerSnapshot, {
          version: 1, id: task.id, taskHash: hash(task), scopes: task.scopes, claimant,
          host: hostname(), branch, claimedAt: new Date(now()).toISOString(),
        }, commitSubject('chore', `claim ${task.id}`))) continue;
        save({ ...task, taskHash: hash(task), operation, stage: 'claim', base: target, branch,
          path: join(dirname(primary), `${primary.split('/').at(-1)}-outcomes`, operation),
          directory: `${project.changes}/${task.change}` });
        work = activeWork();
      }
      try {
        const claimedAt = recoverClaimTime(work);
        if (work.claimedAt !== claimedAt) save({ claimedAt });
        const prompt = `Task ${work.id}; OpenSpec directory ${work.directory}. ` +
          `Exact source: ${JSON.stringify(authorized(queue, work.id))}\n`;
        if (prompt.length > 65536) throw new Error('Selected outcome prompt is too large');
        if (work.stage === 'claim') {
          if (!existsSync(work.path)) {
            git(root, 'worktree', 'add', '-b', work.branch, work.path, work.base);
            await cancellable(afterEffect('claim', work), signal);
          }
          if (git(work.path, 'rev-parse', 'HEAD') !== work.base || git(work.path, 'status', '--porcelain')) {
            throw new Error('Initial worktree differs from recorded base');
          }
          save({ stage: 'investigate' });
        }
        if (activeWork().stage === 'investigate') {
          checks(work, project.setup ?? []);
          const investigation = await session(work, 'investigate', prompt +
            'Inspect current files and history before edits. Call outcome_report with outcome ready, summary, ' +
            'inspected containing actual inspected repository paths, and findings array. Do not edit files. ' +
            'Do not use a final message as a substitute for outcome_report.');
          save({ investigation, stage: 'plan' });
        }
        if (activeWork().stage === 'plan') {
          let bound = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            // Graded test fragments come from the frozen threshold on every attempt, so replanning repeats them.
            await session(work, 'plan', prompt + 'Create proposal.md, design.md, tasks.md and specs/<capability>/spec.md. ' +
              'Use OpenSpec delta headings and WHEN/THEN scenarios. Stay within task scope; do not edit product files. ' +
              'This session writes only those planning artifacts. Product file writes and run_checks are refused until ' +
              'the specification is bound, in a later session; that is expected and not a blocker, so do not attempt them. ' +
              'When the artifacts are written, call outcome_report with outcome ready. ' +
              planTestInstructions(config.coverage) + ' ' +
              'Address private findings: ' + JSON.stringify(activeWork().findings ?? []));
            let specification;
            try {
              specification = packet(work.path, work.directory);
              checks(work, [project.planningCheck]);
            } catch (error) {
              save({ findings: [failureDetail(error)] }); continue;
            }
            const review = await session(work, 'review', prompt +
              'Review planning artifacts independently against exact source criteria, scope and decisions. ' +
              'Report accepted only with zero findings; otherwise changes-required with concrete findings. ' +
              planningReviewTestInstructions(config.coverage));
            save({ planningReviews: [...(activeWork().planningReviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ specification, stage: 'work', findings: [] }); bound = true; break;
            }
            save({ findings: review.findings });
          }
          if (!bound) throw new Error('Planning review remains unresolved');
        }
        if (activeWork().stage === 'work') {
          let passed = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await session(activeWork(), 'work', prompt +
              'Implement all approved OpenSpec scenarios and every test marked (required) within product scope; ' +
              'write (coverage-only) tests only as the graded test rules below allow. ' +
              workTestInstructions(config.coverage) + ' Preserve bound specs. ' +
              'Address private findings: ' + JSON.stringify(activeWork().findings ?? []));
            await cancellable(afterEffect('implementation', activeWork()), signal);
            assertWork(activeWork()); commit(work);
            try { save({ checks: checks(work, project.checks) }); }
            catch (error) { save({ findings: [failureDetail(error)] }); continue; }
            const review = await session(activeWork(), 'review', prompt +
              'Review actual implementation independently against every criterion, scope, security and test evidence. ' +
              'Read files and context. Report accepted with zero findings only when complete; otherwise changes-required. ' +
              'When reporting accepted, provide completion.summary with two or three English sentences describing what ' +
              'the whole task changed, and completion.grade for whole-task complexity: A (most complex), B, C, D, ' +
              'E (easiest). Grade complexity, not correctness, quality or execution speed. ' +
              implementationReviewTestInstructions(config.coverage), true);
            save({ reviews: [...(activeWork().reviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              // The documentation stage starts from the reviewed head; its record lists what it later updates.
              save({ review: { ...review, accepted: true }, stage: 'document', findings: [],
                documentation: { base: git(work.path, 'rev-parse', 'HEAD'), files: [], outsideScope: [] } });
              passed = true; break;
            }
            save({ findings: review.findings });
          }
          if (!passed) throw new Error('Implementation checks or review remain unresolved');
        }
        // Each documentation round persists its stage before the next session, so a restart in document-review
        // reviews the recorded documentation instead of writing it again.
        while (['document', 'document-review'].includes(activeWork().stage)) {
          if (activeWork().stage === 'document') {
            if ((activeWork().documentationReviews ?? []).length >= DOCUMENTATION_ROUNDS) {
              throw new Error('Documentation review remains unresolved');
            }
            const documented = await session(activeWork(), 'document', prompt +
              'Update the documentation inside the task scopes so that it matches the implemented behaviour and every ' +
              'criterion. Documentation files are README files, Markdown files (.md, .mdx) and files under docs or doc ' +
              `directories. Write only documentation files inside the task scopes ${JSON.stringify(work.scopes)}; ` +
              'writes to product code, tests, OpenSpec files or paths outside the scopes are refused. ' +
              'Report in findings only documentation outside the task scopes that needs changes, one file and reason ' +
              'per finding, and call outcome_report with outcome ready. ' +
              'Address private findings: ' + JSON.stringify(activeWork().findings ?? []));
            await cancellable(afterEffect('documentation', activeWork()), signal);
            assertWork(activeWork()); commitDocumentation(work);
            const record = activeWork().documentation ?? { base: work.base, files: [], outsideScope: [] };
            const files = git(work.path, 'diff', '--name-only', record.base, 'HEAD').split('\n').filter(path =>
              path && isDocumentation(path) && work.scopes.some(scope => within(path, scope)));
            save({ documentation: { ...record, files, outsideScope: [...new Set(documented.findings)] },
              stage: 'document-review' });
          }
          if (activeWork().stage === 'document-review') {
            const review = await session(activeWork(), 'document-review', prompt +
              'Review the documentation changes independently against the implementation, every criterion and the ' +
              'task scope. Documentation may change only README files, Markdown files and docs or doc directories ' +
              'inside the task scopes. Read files and context; the diff section shows all task changes. ' +
              'Report accepted only with zero findings; otherwise changes-required with concrete findings.');
            const reviews = [...(activeWork().documentationReviews ?? []), review];
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ documentationReviews: reviews, stage: 'final-checks', findings: [] });
            } else {
              save({ documentationReviews: reviews, findings: review.findings, stage: 'document' });
            }
          }
        }
        if (activeWork().stage === 'final-checks') {
          assertWork(activeWork());
          save({ documentationChecks: runProductChecks(work), stage: 'archive' });
        }
        if (activeWork().stage === 'archive') {
          const now = activeWork();
          const original = join(work.path, work.directory);
          const archiveParent = `${project.changes}/archive`;
          const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${work.change}$`, 'u');
          const archived = () => existsSync(join(work.path, archiveParent)) ? readdirSync(join(work.path, archiveParent))
            .filter(name => pattern.test(name)).map(name => `${archiveParent}/${name}`) : [];
          // A change directory that is already gone was archived before a restart; the command never runs twice.
          if (existsSync(original)) {
            assertWork(now);
            if (archived().length) throw new Error('Archived change directory already exists');
            const definition = archiveCommand(project);
            const args = definition.args.map(arg => arg.replaceAll('{change}', work.change));
            try { runCommand(work.path, definition.command, args); }
            catch (error) { throw new Error(`Archive command failed: ${failureDetail(error)}`); }
          }
          const found = archived();
          if (existsSync(original) || found.length !== 1) throw new Error('Archive did not relocate the change directory');
          const directory = found[0];
          const specification = rekeyBinding(now.specification ?? {}, work.directory, directory);
          for (const [path, expected] of Object.entries(specification)) {
            const file = join(work.path, path);
            if (!existsSync(file) || lstatSync(file).isSymbolicLink() || digest(readFileSync(file)) !== expected) {
              throw new Error('Archived specification differs from binding');
            }
          }
          let archivedPacket: Record<string, string> | undefined;
          try { archivedPacket = packet(work.path, directory); } catch { archivedPacket = undefined; }
          if (!archivedPacket || hash(archivedPacket) !== hash(specification)) {
            throw new Error('Archived specification differs from binding');
          }
          const specs = specsDirectory(project.changes);
          const paths = [work.directory, directory, specs].filter(path =>
            existsSync(join(work.path, path)) || git(work.path, 'ls-files', '--', path));
          if (paths.length) git(work.path, 'add', '-A', '--', ...paths);
          if (git(work.path, 'diff', '--cached', '--name-only')) {
            git(work.path, 'commit', '-m', commitSubject('docs', `archive ${work.change} for ${work.id}`));
          }
          const written = git(work.path, 'diff', '--name-only', work.base, 'HEAD', '--', specs).split('\n').filter(Boolean);
          save({ archive: { directory, specs: written, head: git(work.path, 'rev-parse', 'HEAD') }, specification,
            stage: 'receipt' });
          await cancellable(afterEffect('archive', activeWork()), signal);
        }
        if (activeWork().stage === 'receipt') {
          const now = activeWork(); assertWork(now);
          const paths = git(work.path, 'diff', '--name-only', work.base, 'HEAD').split('\n').filter(Boolean);
          if (!paths.length || outsideManifest(paths, now).length) {
            throw new Error('Empty or out-of-scope result manifest');
          }
          const manifest = paths.map(path => ({ path, hash: digest(readFileSync(join(work.path, path))) }));
          const receipt = { version: 1, id: work.id, taskHash: work.taskHash,
            authority: config.authority.reference, specification: now.specification,
            review: { ...reviewRecord(now.review!), accepted: true },
            checks: checkRecords(now.documentationChecks ?? now.checks!), manifest,
            head: git(work.path, 'rev-parse', 'HEAD'), base: work.base };
          const path = join(work.path, receiptPath(work.id)); mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
          git(work.path, 'add', '--', receiptPath(work.id));
          git(work.path, 'commit', '-m', `docs(${project.commitScope ?? 'work-queue'}): record ${work.id} acceptance evidence${project.commitSuffix ?? ''}`);
          save({ stage: 'publish' });
        }
        if (activeWork().stage === 'publish') {
          assertWork(activeWork());
          const targetNow = refresh().target;
          integrateTarget(work, targetNow);
          save({ finalChecks: checks(work, project.checks) });
          if (git(work.path, 'status', '--porcelain')) throw new Error('Final checks changed tracked inputs');
          const head = git(work.path, 'rev-parse', 'HEAD');
          git(work.path, 'push', 'origin', `HEAD:refs/heads/${work.branch}`);
          save({ head, testedTarget: targetNow, stage: 'pr' });
        }
        if (activeWork().stage === 'pr') {
          const now = activeWork();
          const body = join(store.directory, `${work.id}-pr.md`);
          writeFileSync(body, pullRequestBody(now, config.authority.reference));
          let pr = await cancellable(Promise.resolve(host.find(work.branch)), signal);
          if (pr) rememberPr(pr);
          if (!pr) {
            pr = await cancellable(Promise.resolve(host.create(now, body)), signal);
            if (pr) rememberPr(pr);
            await cancellable(afterEffect('pr', pr), signal);
          }
          if (!pr || pr.state === 'CLOSED') throw new Error('PR unavailable or closed');
          save({ stage: 'merge' });
        }
        if (activeWork().stage === 'merge') {
          const now = activeWork();
          const polling = options.mergePolling ?? {};
          const limit = polling.views ?? MERGE_STATE_VIEWS;
          for (let view = 1; ; view += 1) {
            const pr = await cancellable(Promise.resolve(host.find(work.branch)), signal);
            if (!pr) throw new Error('Recorded PR missing');
            rememberPr(pr);
            if (pr.state === 'MERGED') break;
            if (pr.state !== 'OPEN') throw new Error('PR unavailable or closed');
            assertWork(now);
            if (git(work.path, 'rev-parse', 'HEAD') !== now.head) {
              throw new Error('Checked head or target changed');
            }
            if (refresh().target !== now.testedTarget) { save({ stage: 'publish' }); break; }
            if (pr.headRefOid === now.head) {
              await cancellable(Promise.resolve(host.merge(pr, now.head!)), signal); await cancellable(afterEffect('merge', pr), signal);
              break;
            }
            assertOriginHead(work.path, work.branch, now.head!);
            if (view >= limit) throw new Error('Checked head or target changed');
            await cancellable((polling.delay ?? delay)(polling.pollMs ?? MERGE_STATE_POLL_MS), signal);
          }
          if (activeWork().stage === 'publish') continue;
          const targetNow = refresh().target;
          if (!accepted(targetNow, authorized(refresh().queue, work.id))) throw new Error('Merged result lacks valid receipt');
        }
      } catch (error) {
        if (stopped || signal?.aborted) {
          statistics?.decision(activeWork(), 'blocked', activeWork(), 'cancelled');
          return { status: 'cancelled', ...resultData(newlyAccepted), remaining };
        }
        if ((error as InterruptedFailure).interrupted) throw error;
        store.update({ blocked: { ...store.state.blocked, [work.id]: {
          reason: (error as Error).message, work: activeWork() } }, current: null });
        // The reason reaches only the stderr mascot caption; the serialized event stays unchanged.
        report({ status: 'blocked', id: work.id }, { reason: (error as Error).message });
      }
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const close of [() => adapter?.close(), () => store?.close(), () => lock.close()]) {
      try { close(); } catch (error) { cleanupErrors.push(error); }
    }
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (cleanupErrors.length) throw cleanupErrors[0];
  }
}
