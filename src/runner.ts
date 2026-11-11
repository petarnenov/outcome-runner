import { cancellable, tokenUsage } from './statistics.ts';
import type { Sources, Statistics } from './statistics.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { hash, digest, within, safePath, validateConfig, validateQueue } from './model.ts';
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

export interface RunOptions {
  statistics?: Statistics;
  signal?: AbortSignal;
  now?: () => number;
  mergePolling?: import('./git.ts').MergePolling;
  host?: PullRequestHost;
  createAdapter?: (options: HarnessOptions) => HarnessAdapter;
  afterEffect?: (operation: string, subject: Work | PullRequest | null) => Promise<void>;
  report?: (event: RunEvent) => void;
  /** Injectable effects of the OpenSpec preflight; omitted fields use the real process, TTY and filesystem. */
  openspec?: Partial<PreflightDeps>;
  /** Injectable prompts, harness probes, Codex reader and recorded state of the harness selection. */
  selection?: Partial<SelectionDeps>;
}

interface CommandFailure extends Error { stderr?: string | Buffer }
interface InterruptedFailure extends Error { interrupted?: boolean }

const failureDetail = (error: unknown): string => {
  const { stderr, message } = error as CommandFailure;
  return String(stderr ?? message).slice(-16000);
};

const checkRecords = (rows: CheckRecord[]) => rows.map(({ command, args, outcome }) => ({ command, args, outcome }));
const reviewRecord = ({ reviewer, outcome }: ReviewRecord) => ({ reviewer, outcome });
const scopesOverlap = (first: string[], second: string[]): boolean => first.some(path =>
  second.some(other => within(path, other) || within(other, path)));

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
  // the lock, claims and worktrees.
  const statistics = options.statistics;
  const signal = options.signal;
  await cancellable(openspecPreflight(requested, { ...options.openspec, signal }), signal);
  // Selected values enter the configuration before it is hashed, so they are frozen exactly like flags.
  // A Codex selection reads Codex once; resolution reuses that read instead of opening another session.
  let sources: Sources = {}; let harnessVersion: string | undefined;
  const { config: selected, codex } = await cancellable(selectHarness(requested, {
    ...options.selection, signal, sources: statistics?.sources,
    onResolved: (config, resolvedSources, version) => {
      sources = resolvedSources; harnessVersion = version;
      statistics?.resolved(config, sources, version);
    },
  }), signal);
  const config = await cancellable(resolveHarness(selected, codex ? async () => codex :
    cwd => codexSelection(cwd, undefined, signal)), signal);
  statistics?.resolved(config, sources, harnessVersion);
  validateConfig(config);
  const { afterEffect = async () => {}, report = () => {}, now = Date.now } = options;
  const createAdapter = options.createAdapter ?? ((adapterOptions: HarnessOptions) => createHarness(adapterOptions, config));
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
  const stop = () => { stopped = true; adapter?.close();
    if (store?.state.current) statistics?.decision(store.state.current, 'blocked', store.state.current, 'cancelled');
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
      if (work.specification && hash(packet(work.path, work.directory)) !== hash(work.specification)) {
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
    const integrateTarget = (work: Work, target: string): void => {
      if (git(work.path, 'merge-base', target, 'HEAD') === target) return;
      const changed = git(work.path, 'diff', '--name-only', work.base, target).split('\n').filter(Boolean);
      if (scopesOverlap(changed, [...work.scopes, work.directory])) throw new Error('Target changed outcome scope');
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
      const writable = purpose === 'plan' ? [work.directory] : purpose === 'work' ?
        [...work.scopes, `${work.directory}/tasks.md`, `${work.directory}/compliance.md`,
          `${work.directory}/verification.md`] : [];
      const broker = new CodexFiles({ root: work.path,
        scopes: [...files.map(path => ({ path, mode: 'read' })),
          ...instructionPaths.map(path => ({ path, mode: 'read' })), ...work.scopes.map(path => ({ path, mode: 'read' })),
          { path: work.directory, mode: 'read' }, ...writable.map(path => ({ path, mode: 'write' }))],
        store, identity: { id: work.id, operation: work.operation, purpose },
        revalidate: async () => assertWork(activeWork()) });
      signal?.throwIfAborted();
      const starts = activeWork().sessionStarts ?? Object.fromEntries(
        (['investigate', 'plan', 'work', 'review'] as const).map(key =>
          [key, (activeWork().sessions ?? []).filter(session => session.purpose === key).length]));
      save({ sessionStarts: { ...starts, [purpose]: (starts[purpose] ?? 0) + 1 } });
      const usage = statistics?.session(work.id);
      adapter = createAdapter({ cwd: work.path, tools: [brokerTool, reportTool], onUsage: usage,
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
            try { return await broker.call(name, input); }
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
        const reply = await cancellable(adapter.startAction('OFF. Never ask a person anything. All output is private. ' +
          'Use only backlog_tool operations read_file/write_file/context/run_checks and outcome_report. ' +
          'Read files with input {path,offset}; write with {path,content,expectedHash} from the read result. ' +
          'A read returns one page: repeat it with nextOffset until nextOffset is null. hash covers the whole file. ' +
          'context takes input {section,offset} and pages the same way. section is paths (default, with history), ' +
          'diff, findings or checks. ' +
          'run_checks takes input {} and runs only frozen project checks after specification binding; ' +
          'read their output through the checks section. ' +
          'Read applicable AGENTS.md. Report blockers privately. No shell or approval tools.\n' +
          `Resolved coverage threshold: ${config.coverage}%.\n` + prompt), signal);
        for (const event of reply.events) {
          if (event.type === 'token-usage') usage?.(tokenUsage(event));
        }
        save({ sessions: [...(activeWork().sessions ?? []), {
          purpose, threadId: reply.threadId, events: reply.events, privateText: reply.text }] });
        if (!result || result.outcome === 'blocked') throw new Error(`Worker ${purpose} incomplete`);
        return { ...result, reviewer: `${config.harness}:${reply.threadId}` };
      } finally { adapter.close(); adapter = null; }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const recovery = Object.values(store.state.blocked ?? {}).map(entry => entry.work).filter(Boolean);
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
          const finished = { ...current, claimedAt, acceptedAt, completion, acceptedTarget: target };
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
        if (task.id === store.state.current?.id) statistics?.decision(task, 'blocked', store.state.current);
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
            await afterEffect('claim', work);
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
            await session(work, 'plan', prompt 