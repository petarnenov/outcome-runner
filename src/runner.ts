import { cancellable, tokenUsage } from './statistics.ts';
import type { Sources, Statistics } from './statistics.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { hash, digest, within, safePath, validateConfig, validateQueue, archiveCommand, isDocumentation,
  specsDirectory, resolvePollSeconds } from './model.ts';
import type { BudgetExhaustion, BudgetStage, CheckRecord, CleanupStep, CommandSpec, PullRequest, Purpose, Queue,
  RetryRecord, ReviewRecord, RunConfig, SendBackCause, SendBackRecord, Task, TaskBudget, Work, WorkerReport,
  TaskCompletion } from './model.ts';
import { command, git, gitPage, fileAt, hasRef, pushBookkeeping, receiptAt, GitHubHost, assertOriginHead, MERGE_STATE_VIEWS,
  MERGE_STATE_POLL_MS, MergeIneligible } from './git.ts';
import type { MergeEligibility } from './git.ts';
import { classifyEligibility, releaseOnlyAdvance, MergeNotEligible, MERGE_ELIGIBILITY_POLL_MS,
  MERGE_ELIGIBILITY_WAIT_MS } from './merge-eligibility.ts';
import type { EligibilityClass } from './merge-eligibility.ts';
import { lockRootOf, withGitLock } from './git-lock.ts';
import { pageOffset, readPage } from './text-page.ts';
import { RunStore } from './run-store.ts';
import type { BlockedEntry } from './run-store.ts';
import { invocationIdentity, missingSetting, MissingSettingError, REQUIRED_SETTINGS,
  settingAt } from './invocation-identity.ts';
import type { RequiredSetting } from './invocation-identity.ts';
import { buildCompletion, validCompletion } from './completion.ts';
import { ClaimLedger } from './claims.ts';
import type { Claim, LedgerSnapshot } from './claims.ts';
import { CodexFiles, brokerTool } from './codex-files.ts';
import { resolveHarness, createHarness, codexSelection } from './harness.ts';
import { selectHarness } from './harness-selection.ts';
import type { SelectionDeps } from './harness-selection.ts';
import { openspecPreflight } from './openspec-preflight.ts';
import type { PreflightDeps } from './openspec-preflight.ts';
import { planTestInstructions, planningReviewTestInstructions, workTestInstructions,
  implementationReviewTestInstructions } from './test-grading.ts';
import { useNetworkRetry } from './network-retry.ts';
import { createStepLog, runStartMessage } from './step-log.ts';
import type { StepLog, StepOutput } from './step-log.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolDefinition } from './harness-adapter.ts';
import { runnerVersion } from './runner-version.ts';

export interface PullRequestHost {
  find(branch: string): PullRequest | null | Promise<PullRequest | null>;
  create(work: Work, body: string): PullRequest | null | Promise<PullRequest | null>;
  /**
   * Merges the pull request with the exact checked `head`. A host that waits before its merge command calls the
   * optional `guard` immediately before it; a throwing guard means no merge command is issued. A merge refused only
   * by the pull request status may throw `MergeIneligible`.
   */
  merge(pr: PullRequest, head: string, guard?: () => void | Promise<void>): void | Promise<void>;
  /**
   * The settled merge status of the open pull request of `head` and its required checks. A host without it is
   * treated as eligible (`CLEAN` without checks).
   */
  eligibility?(pr: PullRequest, head: string): MergeEligibility | Promise<MergeEligibility>;
}

export interface RunEvent {
  status: string; id: string; summary?: string; durationSeconds?: number; grade?: TaskCompletion['grade'];
  /** Cleanup steps that failed after acceptance; omitted when the cleanup succeeded. */
  cleanupFailed?: CleanupStep[];
}

/** Why a task of the invocation was not finished. */
export type BlockerKind = 'blocked' | 'waiting-for-dependency' | 'waiting-for-claim' | 'max-accepted';

/**
 * One unfinished task of the invocation: `blocked` carries `stage` and `diagnostics` (the state.json path),
 * `waiting-for-dependency` the `dependencies` not yet accepted, `waiting-for-claim` the foreign `claim`
 * and `max-accepted` the `limit`.
 * A task blocked by an unresolved target conflict also carries the conflicting `paths`, a task blocked by an
 * exhausted review or check budget carries the `budget`, and a task blocked with `merge-not-eligible` carries the
 * last merge `status` and the failed or pending required `checks`.
 */
export interface Blocker {
  kind: BlockerKind;
  reason: string;
  stage?: Work['stage'];
  diagnostics?: string;
  paths?: string[];
  budget?: BudgetExhaustion;
  status?: string;
  checks?: string[];
  dependencies?: string[];
  claim?: { id: string; host?: string };
  limit?: number;
}

export interface RunResult {
  status: string;
  accepted: string[];
  remaining: string[];
  completions: Record<string, TaskCompletion>;
  blockers?: Record<string, Blocker>;
  claimedElsewhere?: Record<string, { host?: string }>;
}

/** Runs one program with an argument array and no shell in `cwd`; throws on a nonzero exit. */
export type CommandRunner = (cwd: string, program: string, args: string[]) => string;

/** Waits `milliseconds` or until `signal` aborts; it resolves in both cases. */
export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

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
  /** Injectable runner of the archive command; the default executes the program without a shell. */
  runCommand?: CommandRunner;
  /** Receives each step line (with its newline) before the step starts; the default writes to stderr. */
  steps?: StepOutput;
  /** Settings the invocation file must contain; the default is `REQUIRED_SETTINGS`. */
  requiredSettings?: readonly RequiredSetting[];
  /**
   * Blocked tasks of the invocation that get a fresh review and check budget (`--retry <task id>`). Any other id
   * refuses the run with `retry-not-blocked`. Operational only: it never enters the invocation identity.
   */
  retry?: string[];
  /**
   * The wait of one poll while the run waits for free work. It receives the poll interval in milliseconds and a
   * signal that aborts on cancellation; the default is a timer that ends early when the signal aborts.
   */
  sleep?: Sleep;
}

interface CommandFailure extends Error { stdout?: string | Buffer; stderr?: string | Buffer }
interface InterruptedFailure extends Error { interrupted?: boolean }

/**
 * The blocked reasons of a failed integration of an advanced target: an unresolved conflict, a rejected
 * integration, or a target that kept advancing for `TARGET_ATTEMPTS` consecutive attempts.
 */
export type IntegrationCode = 'target-conflict-unresolved' | 'target-integration-rejected' | 'target-keeps-advancing';

/** A failed integration: the message is the code, and `paths` lists the unresolved conflicting paths. */
export class IntegrationFailure extends Error {
  code: IntegrationCode;
  paths: string[];
  constructor(code: IntegrationCode, paths: string[]) {
    super(code);
    this.name = 'IntegrationFailure';
    this.code = code;
    this.paths = [...paths];
  }
}

/** The guard of a merge found origin/<target> different from the checked target; no merge command was issued. */
class TargetAdvanced extends Error {
  constructor() {
    super('Target advanced before the merge');
    this.name = 'TargetAdvanced';
  }
}

/** The consecutive attempts that may end with an advanced target before the task blocks with `target-keeps-advancing`. */
export const TARGET_ATTEMPTS = 10;

/** The eligibility of a host that does not report one. */
const ELIGIBLE: MergeEligibility = Object.freeze({ status: 'CLEAN', checks: [] });

/** Whether `text` has a line starting with a Git conflict marker (`<<<<<<< ` or `>>>>>>> `). */
export const conflictMarkers = (text: string): boolean => /^(?:<<<<<<<|>>>>>>>) /mu.test(text);

const INTEGRATION_REASONS: readonly string[] = ['target-conflict-unresolved', 'target-integration-rejected',
  'target-keeps-advancing'];

/** The blocked reason of a pull request that cannot become mergeable. */
const MERGE_NOT_ELIGIBLE = 'merge-not-eligible';

/** How the send-back step lines and the send-back prompt name what rejected the merged result. */
const CAUSE_LABEL: Readonly<Record<SendBackCause, string>> = Object.freeze({ checks: 'checks',
  review: 'implementation review', 'document-review': 'documentation review' });

/** The review rounds of every budget stage (planning, implementation and documentation) of a task. */
export const REVIEW_ROUNDS = 4;
/** The failing runner check runs of each budget stage; the documentation stage runs no checks. */
export const CHECK_ATTEMPTS: Readonly<Record<BudgetStage, number>> = Object.freeze({ plan: 4, work: 4, document: 0 });
const BUDGET_NAMES: Readonly<Record<BudgetStage, string>> = Object.freeze({ plan: 'Planning', work: 'Implementation',
  document: 'Documentation' });
/** A budget with nothing used. */
const freshBudget = (): TaskBudget => ({ plan: { reviews: 0, checks: 0 }, work: { reviews: 0, checks: 0 },
  document: { reviews: 0, checks: 0 } });

/**
 * The used counts of `work`: its recorded `budget`, or for work recorded before budgets existed the number of its
 * planning, implementation and documentation reviews with no check attempts used.
 */
export function budgetOf(work: Pick<Work, 'budget' | 'planningReviews' | 'reviews' | 'documentationReviews'>): TaskBudget {
  if (work.budget) return work.budget;
  return { plan: { reviews: (work.planningReviews ?? []).length, checks: 0 },
    work: { reviews: (work.reviews ?? []).length, checks: 0 },
    document: { reviews: (work.documentationReviews ?? []).length, checks: 0 } };
}

/** The exhaustion of `stage` of `budget`, with the used and allowed counts of both parts. */
export function budgetExhaustion(budget: TaskBudget, stage: BudgetStage, exhausted: BudgetExhaustion['exhausted']):
  BudgetExhaustion {
  return { stage, exhausted, reviews: { used: budget[stage].reviews, limit: REVIEW_ROUNDS },
    checks: { used: budget[stage].checks, limit: CHECK_ATTEMPTS[stage] } };
}

/**
 * The private blocked reason of an exhausted budget, for example
 * `Implementation review budget exhausted: 4 of 4 review rounds and 1 of 4 check attempts used`.
 */
export function budgetMessage({ stage, exhausted, reviews, checks }: BudgetExhaustion): string {
  return `${BUDGET_NAMES[stage]} ${exhausted === 'reviews' ? 'review' : 'check'} budget exhausted: ` +
    `${reviews.used} of ${reviews.limit} review rounds and ${checks.used} of ${checks.limit} check attempts used`;
}

/** A task whose review or check budget ran out; the message is `budgetMessage(budget)`. */
export class BudgetExhausted extends Error {
  budget: BudgetExhaustion;
  constructor(budget: BudgetExhaustion) {
    super(budgetMessage(budget));
    this.name = 'BudgetExhausted';
    this.budget = structuredClone(budget);
  }
}

// Test reporters write failures to stdout while package managers write notices to stderr, so both are kept.
const failureDetail = (error: unknown): string => {
  const { stdout, stderr, message } = error as CommandFailure;
  const output = [stdout, stderr].map(stream => String(stream ?? '').trim()).filter(Boolean).join('\n');
  return (output || message).slice(-16000);
};

const checkRecords = (rows: CheckRecord[]) => rows.map(({ command, args, outcome }) => ({ command, args, outcome }));
const reviewRecord = ({ reviewer, outcome }: ReviewRecord) => ({ reviewer, outcome });
const DOCUMENTATION_REVIEW = 'Review the documentation changes independently against the implementation, every ' +
  'criterion and the task scope. Documentation may change only README files, Markdown files and docs or doc ' +
  'directories inside the task scopes. Read files and context; the diff section shows all task changes. ' +
  'Report accepted only with zero findings; otherwise changes-required with concrete findings.';
/** The implementation session instruction to delete every scratch or diagnostic file before finishing. */
export const LEFTOVER_FILES_WORK = 'Before finishing, delete with delete_file every scratch or diagnostic file you created ' +
  'during this task, such as temporary debug tests, captures or notes; keep only files the task needs.';
/** The implementation review instruction to reject leftover diagnostic files and name them in findings. */
export const LEFTOVER_FILES_REVIEW = 'Report changes-required when the task changes contain a file that only served ' +
  'diagnosis, such as a temporary debug test, capture or scratch file, and name each such file by path in findings.';
/** The implementation review prompt of the work stage and of an integration. */
const implementationReview = (coverage: number | undefined): string =>
  'Review actual implementation independently against every criterion, scope, security and test evidence. ' +
  'Read files and context. Report accepted with zero findings only when complete; otherwise changes-required. ' +
  'When reporting accepted, provide completion.summary with two or three English sentences describing what ' +
  'the whole task changed, and completion.grade for whole-task complexity: A (most complex), B, C, D, ' +
  'E (easiest). Grade complexity, not correctness, quality or execution speed. ' + LEFTOVER_FILES_REVIEW + ' ' +
  implementationReviewTestInstructions(coverage!);
/** The number of sessions of `purpose` already started for `work`, as the session start counter records it. */
const sessionsStarted = (work: Work, purpose: Purpose): number => work.sessionStarts ?
  work.sessionStarts[purpose] ?? 0 : (work.sessions ?? []).filter(item => item.purpose === purpose).length;

/**
 * For each id of `ids` (in order), its dependencies that are outside `ids` and not accepted. A dependency that is
 * not a task of `tasks` is always missing. Ids without missing dependencies are omitted.
 */
export function missingDependencies(ids: string[], tasks: Pick<Task, 'id' | 'dependencies'>[],
  isAccepted: (id: string) => boolean): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  for (const id of ids) {
    const dependencies = (tasks.find(task => task.id === id)?.dependencies ?? []).filter(dependency =>
      !ids.includes(dependency) && !(tasks.some(task => task.id === dependency) && isAccepted(dependency)));
    if (dependencies.length) missing[id] = dependencies;
  }
  return missing;
}

export interface AcceptedInput {
  ids: string[];
  completed: Record<string, unknown>;
  blocked: Record<string, unknown>;
  done: Iterable<string>;
  baselineDone: Iterable<string>;
}

/**
 * The ids of the invocation counted against `maxAccepted`: newly done ids that this run accepted (`completed`) or
 * merged without recording the acceptance (`blocked`). Ids outside `ids` never count, even when newly done.
 */
export function acceptedThisRun({ ids, completed, blocked, done, baselineDone }: AcceptedInput): string[] {
  const finished = new Set(done); const baseline = new Set(baselineDone);
  return ids.filter(id => finished.has(id) && !baseline.has(id) &&
    (Object.hasOwn(completed, id) || Object.hasOwn(blocked, id)));
}

/** The claims of another claimant whose task is not done. */
export function foreignClaimsOf(snapshot: Pick<LedgerSnapshot, 'claims'>, done: Iterable<string>,
  claimant: string): Claim[] {
  const finished = new Set(done);
  return [...snapshot.claims.values()].filter(claim => claim.claimant !== claimant && !finished.has(claim.id));
}

export interface UnfinishedInput extends AcceptedInput {
  remaining: string[];
  tasks: Pick<Task, 'id' | 'dependencies' | 'scopes'>[];
  blocked: Record<string, { reason?: string; paths?: string[]; budget?: BudgetExhaustion;
    eligibility?: { status: string; checks: string[] }; work?: Pick<Work, 'stage' | 'scopes'> }>;
  maxAccepted?: number;
  foreignClaims: Pick<Claim, 'id' | 'host' | 'scopes'>[];
  statePath: string;
}

/**
 * A blocker for every blocked task of the invocation and every remaining task, using the first matching rule:
 * blocked, max-accepted, waiting-for-dependency, waiting-for-claim. Throws
 * `Unexplained unfinished task` when no rule matches. A blocked task with an exhausted budget has the reason
 * `review-budget-exhausted` or `check-budget-exhausted` and a copy of the `budget`; a blocked task keeps the reason
 * `target-conflict-unresolved` (with its conflicting `paths`), `target-integration-rejected`,
 * `target-keeps-advancing` or `merge-not-eligible` (with the merge `status` and the required `checks`); every other
 * blocked task has the reason `operation-incomplete`.
 */
export function explainUnfinished(input: UnfinishedInput): Record<string, Blocker> {
  const { remaining, ids, tasks, blocked, done, maxAccepted, foreignClaims, statePath } = input;
  const finished = new Set(done);
  const limited = !!maxAccepted && acceptedThisRun(input).length >= maxAccepted;
  const blockedIds = ids.filter(id => Object.hasOwn(blocked, id));
  const claims = [...foreignClaims].sort((first, second) => first.id.localeCompare(second.id));
  const blockers: Record<string, Blocker> = {};
  for (const id of [...new Set([...blockedIds, ...remaining])]) {
    if (Object.hasOwn(blocked, id)) {
      const { reason, paths, budget, eligibility, work } = blocked[id];
      if (budget) {
        blockers[id] = { kind: 'blocked', stage: work?.stage,
          reason: budget.exhausted === 'reviews' ? 'review-budget-exhausted' : 'check-budget-exhausted',
          diagnostics: statePath, budget: structuredClone(budget) };
        continue;
      }
      if (reason === MERGE_NOT_ELIGIBLE) {
        blockers[id] = { kind: 'blocked', stage: work?.stage, reason: MERGE_NOT_ELIGIBLE, diagnostics: statePath,
          ...(eligibility ? { status: eligibility.status, checks: [...eligibility.checks] } : {}) };
        continue;
      }
      const integration = typeof reason === 'string' && INTEGRATION_REASONS.includes(reason);
      blockers[id] = { kind: 'blocked', stage: work?.stage, reason: integration ? reason! : 'operation-incomplete',
        diagnostics: statePath, ...(integration && paths?.length ? { paths: [...paths] } : {}) };
      continue;
    }
    if (limited) {
      blockers[id] = { kind: 'max-accepted', reason: 'max-accepted', limit: maxAccepted };
      continue;
    }
    const task = tasks.find(item => item.id === id);
    const dependencies = (task?.dependencies ?? []).filter(dependency => !finished.has(dependency));
    if (dependencies.length) {
      blockers[id] = { kind: 'waiting-for-dependency', reason: 'waiting-for-dependency', dependencies };
      continue;
    }
    const claim = claims.find(item => item.id === id);
    if (claim) {
      blockers[id] = { kind: 'waiting-for-claim', reason: 'waiting-for-claim', claim: { id: claim.id, host: claim.host } };
      continue;
    }
    throw new Error(`Unexplained unfinished task: ${id}`);
  }
  return blockers;
}

/** Whether the run waits for free work: some blockers exist and each waits for a foreign claim or a dependency. */
export const waitsForFreeWork = (blockers: Record<string, Pick<Blocker, 'kind'>>): boolean => {
  const kinds = Object.values(blockers).map(blocker => blocker.kind);
  return kinds.length > 0 && kinds.every(kind => kind === 'waiting-for-claim' || kind === 'waiting-for-dependency');
};

/**
 * The message of the `run wait` step line: `waiting <n>s for <id> on <host>, ...` with the distinct ids waited for,
 * sorted. A `waiting-for-claim` blocker names the claimed task and the host its claim records (`unknown host` when it
 * records none); every dependency of a `waiting-for-dependency` blocker not already listed names the host of its
 * foreign claim, or `unclaimed` when no foreign claim holds it.
 */
export function waitMessage(blockers: Record<string, Pick<Blocker, 'kind' | 'claim' | 'dependencies'>>,
  foreignClaims: Pick<Claim, 'id' | 'host'>[], pollSeconds: number): string {
  const hosts = new Map<string, string>();
  const shown = (host: string | undefined): string => host || 'unknown host';
  for (const blocker of Object.values(blockers)) {
    if (blocker.kind === 'waiting-for-claim' && blocker.claim) hosts.set(blocker.claim.id, shown(blocker.claim.host));
  }
  for (const blocker of Object.values(blockers)) {
    if (blocker.kind !== 'waiting-for-dependency') continue;
    for (const dependency of blocker.dependencies ?? []) {
      if (hosts.has(dependency)) continue;
      const claim = foreignClaims.find(item => item.id === dependency);
      hosts.set(dependency, claim ? shown(claim.host) : 'unclaimed');
    }
  }
  const waited = [...hosts.keys()].sort((first, second) => first.localeCompare(second));
  return `waiting ${pollSeconds}s for ${waited.map(id => `${id} on ${hosts.get(id)}`).join(', ')}`;
}

/** The default sleep: a timer that ends early, without an error, when `signal` aborts. */
const defaultSleep: Sleep = async (milliseconds, signal) => {
  try { await delay(milliseconds, undefined, { signal }); }
  catch (error) { if ((error as Error)?.name !== 'AbortError') throw error; }
};

/**
 * The per-invocation lock and ownership files of one clone: `<hash(primary)>-<hash(stateDirectory)>.sqlite` and
 * `<hash(primary)>-<hash(stateDirectory)>-owner.json` beside the primary checkout. Different invocations of one
 * clone use different files, so they run concurrently and never read each other's ownership.
 */
export function invocationLockFiles(primary: string, stateDirectory: string): { lock: string; ownership: string } {
  const lockRoot = join(dirname(primary), '.work-queue-locks');
  const key = `${hash(primary)}-${hash(resolve(stateDirectory))}`;
  return { lock: join(lockRoot, `${key}.sqlite`), ownership: join(lockRoot, `${key}-owner.json`) };
}

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

/**
 * Runs the queue. One step line goes to `options.steps` (default stderr) before each logical step; the first line
 * names the requested invocation, harness, model and effort and the last line names the run outcome, or
 * `unavailable` when the run throws.
 */
export async function runQueue(requested: RunConfig, options: RunOptions = {}): Promise<RunResult> {
  const step = createStepLog({ write: options.steps, now: options.now });
  const { invocation, harness, model, effort } = (requested ?? {}) as Partial<RunConfig>;
  step('run', 'start', runStartMessage({ invocation, harness, model, effort }));
  const restoreNetworkRetry = useNetworkRetry({ onWait: (retry, milliseconds, failed) =>
    step('run', 'network', `connection lost at ${failed}; retrying in ${milliseconds / 1000} s`, { attempt: retry + 1 }) });
  let status = 'unavailable';
  try {
    const result = await runSteps(requested, options, step);
    status = result.status;
    return result;
  } finally { restoreNetworkRetry(); step('run', 'end', `outcome ${status}`); }
}

async function runSteps(requested: RunConfig, options: RunOptions, step: StepLog): Promise<RunResult> {
  // A setting this runner requires and the invocation lacks refuses the run before any preflight, lock, state,
  // ownership file, claim or worktree is touched.
  const required = options.requiredSettings ?? REQUIRED_SETTINGS;
  const lacking = missingSetting(requested, required);
  if (lacking) throw new MissingSettingError(lacking);
  // An invalid poll interval is refused just as early; the interval is operational and never enters the identity.
  const pollSeconds = resolvePollSeconds((requested as Partial<RunConfig> | undefined)?.pollSeconds);
  const sleep = options.sleep ?? defaultSleep;
  // The OpenSpec preflight precedes the harness availability check and selection, harness resolution,
  // the lock, claims and worktrees.
  const statistics = options.statistics;
  const signal = options.signal;
  step('run', 'preflight', 'checking OpenSpec');
  await cancellable(openspecPreflight(requested, { ...options.openspec, signal }), signal);
  // Selected values enter the configuration before the identity is projected, so they are frozen exactly like flags.
  // A Codex selection reads Codex once; resolution reuses that read instead of opening another session.
  let sources: Sources = {}; let harnessVersion: string | undefined;
  step('run', 'preflight', 'checking the harness version');
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
  // The run clock; the merge stage shadows `now` with its work, so the eligibility wait reads this name.
  const clock = now;
  const createAdapter = options.createAdapter ?? ((adapterOptions: HarnessOptions) => createHarness(adapterOptions, config));
  const root = realpathSync(config.root); const project = config.project;
  const primary = dirname(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
  let stateAncestor = resolve(config.stateDirectory); const missing: string[] = [];
  while (!existsSync(stateAncestor)) { missing.unshift(stateAncestor.split('/').at(-1)!); stateAncestor = dirname(stateAncestor); }
  const statePath = join(realpathSync(stateAncestor), ...missing);
  if (within(statePath, primary)) throw new Error('State must be outside the primary checkout');
  lockRootOf(primary);
  // Every Git group of the runner announces a contended Git lock once, before it waits.
  const lockGit = <T>(subject: string, fn: () => T): T =>
    withGitLock(primary, fn, { onWait: () => step(subject, 'git lock', 'waiting for the Git lock') });
  // Task ids whose work was found in durable state at start; only their first line carries `resuming`.
  const resumable = new Set<string>();
  const lastStep = new Map<string, string>();
  const taskStep = (id: string, name: string, message: string, attempt?: number): void => {
    const resuming = resumable.delete(id); lastStep.set(id, name);
    step(id, name, message, { attempt, resuming });
  };
  // The blocked line names only the step; the reason stays in the private state.
  const blockedStep = (id: string, stage: string): void => step(id, 'blocked', `stopped at ${lastStep.get(id) ?? stage}`);
  // The invocation lock and ownership belong to this invocation only; other invocations of the clone run concurrently.
  const files = invocationLockFiles(primary, config.stateDirectory);
  const lock = new DatabaseSync(files.lock);
  const outcomes = join(dirname(primary), `${primary.split('/').at(-1)}-outcomes`);
  let store!: RunStore; let adapter: HarnessAdapter | null | undefined; let stopped = false;
  const ownershipFile = files.ownership;
  // The wait for free work ends on the caller's signal and on `stop` (also reached through SIGINT and SIGTERM).
  const local = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const stop = () => {
    stopped = true;
    local.abort();
    if (store?.state.current) statistics?.decision(store.state.current, 'blocked', store.state.current, 'cancelled');
    try { adapter?.close(); } catch { /* Cancellation still reaches the guarded CLI finalizer. */ }
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch (error) {
      throw Object.assign(new Error(`This invocation is already running in another process (${(error as Error).message})`),
        { reason: 'invocation-running' });
    }
    // Identity compatibility is the run store's decision; only another state directory's unreleased file refuses.
    if (existsSync(ownershipFile)) {
      const previous = JSON.parse(readFileSync(ownershipFile, 'utf8'));
      if (!previous.released && previous.stateDirectory !== resolve(config.stateDirectory)) {
        throw new Error('Another durable invocation owns unfinished work in this repository');
      }
    }
    // Every write of the ownership file names the version of this runner; readers never decide on it.
    const ownership = { identity: '', stateDirectory: resolve(config.stateDirectory), released: false,
      runnerVersion: runnerVersion() };
    let released = false;
    const release = () => {
      writeFileSync(ownershipFile, JSON.stringify({ ...ownership, released: true }));
      released = true;
    };
    const refresh = (subject = 'run') => {
      const target = lockGit(subject, () => {
        git(root, 'fetch', 'origin', project.target);
        return git(root, 'rev-parse', `origin/${project.target}`);
      });
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
    const receiptPath = (id: string) => `${project.receipts}/${id}.json`;
    const accepted = (target: string, task: Task) => receiptAt(root, target, receiptPath(task.id),
      hash(task), null);
    // Every dependency of a task of the invocation is in the invocation or already accepted at the initial target;
    // otherwise the run is refused before any state, ownership, claim or worktree exists.
    const missingByTask = missingDependencies(ids, initial.queue.tasks, id =>
      Boolean(accepted(initial.target, initial.queue.tasks.find(task => task.id === id)!)));
    if (Object.keys(missingByTask).length) {
      throw Object.assign(new Error(`Dependencies outside the invocation are not accepted: ${Object.entries(missingByTask)
        .map(([id, dependencies]) => `${id} needs ${dependencies.join(', ')}`).join('; ')}`),
      { reason: 'dependencies-outside-invocation', details: { missing: missingByTask } });
    }
    // Only what the owner authorised enters the identity, so newer runner defaults never change it.
    const identity = invocationIdentity({ ...config, root, leaves: ids });
    ownership.identity = hash(identity);
    store = new RunStore(config.stateDirectory, identity, { repositoryRoot: root, now });
    // A disposed invocation is never resumed, so its kept work is never picked up without a claim. The refusal
    // precedes the ownership file; the store is closed by the finally below.
    if (store.state.disposed) {
      throw Object.assign(new Error('This invocation was disposed; start new work with a new invocation name'),
        { reason: 'invocation-disposed' });
    }
    // Every retried id must be a blocked task of this invocation; otherwise nothing (settings, ownership file,
    // claims, sessions, budgets or retry records) is touched.
    const retry = [...new Set(options.retry ?? [])];
    const notBlocked = retry.filter(id => !ids.includes(id) || !Object.hasOwn(store.state.blocked ?? {}, id));
    if (notBlocked.length) {
      throw Object.assign(new Error(`Only blocked tasks of this invocation can be retried: ${notBlocked.join(', ')}`),
        { reason: 'retry-not-blocked', details: { tasks: notBlocked } });
    }
    // Required settings are recorded by path and value hash only; one added on resume is recorded as a change.
    store.recordSettings(Object.fromEntries(required.map(setting =>
      [setting.path, hash(settingAt(requested, setting.path))])));
    const stateFile = join(store.directory, 'state.json');
    sources = store.state.statisticsSources ?? sources;
    if (!store.state.statisticsSources) store.update({ statisticsSources: sources });
    statistics?.resolved(config, sources, harnessVersion);
    statistics?.setting('leaves', [...ids], sources.leaves ?? 'default');
    writeFileSync(ownershipFile, JSON.stringify(ownership), { mode: 0o600 });
    const host: PullRequestHost = options.host ?? new GitHubHost(root, project);
    // Claims announce a contended Git lock for the task being claimed, other ledger reads for the run.
    let ledgerSubject = 'run';
    const ledger = new ClaimLedger(root, project.target, fn => lockGit(ledgerSubject, fn));
    if (!store.state.claimant) store.update({ claimant: randomUUID() });
    const claimant = store.state.claimant!;
    const commitSubject = (type: string, text: string) => `${type}(${project.commitScope ?? 'work-queue'}): ${text}${project.commitSuffix ?? ''}`;
    const save = (fields: Partial<Work>) => {
      const result = store.update({ current: { ...store.state.current, ...fields } as Work });
      statistics?.decision(result.current!, 'blocked', result.current!);
      return result;
    };
    const activeWork = () => store.state.current as Work;
    // The attempt of the current publish, pull request and merge pass; it is durable, so a restart keeps it.
    const currentAttempt = (): number => (activeWork().targetAttempts ?? 0) + 1;
    // The integrated targets with `target` appended unless it is already the last entry.
    const integrated = (target: string): string[] => {
      const list = activeWork().integratedTargets ?? [];
      return list.at(-1) === target ? [...list] : [...list, target];
    };
    // The durable budget of the active work. A budget stage saves it on entry, so legacy work keeps its derived counts.
    const budget = (): TaskBudget => budgetOf(activeWork());
    const enterBudget = () => { if (!activeWork().budget) save({ budget: structuredClone(budget()) }); };
    const exhausted = (stage: BudgetStage, part: BudgetExhaustion['exhausted']) =>
      new BudgetExhausted(budgetExhaustion(budget(), stage, part));
    // Before every round: an exhausted stage blocks before any session starts.
    const guardRound = (stage: BudgetStage) => {
      const used = budget()[stage];
      if (used.reviews >= REVIEW_ROUNDS) throw exhausted(stage, 'reviews');
      if (CHECK_ATTEMPTS[stage] && used.checks >= CHECK_ATTEMPTS[stage]) throw exhausted(stage, 'checks');
    };
    // Immediately before a review session: the round is counted durably first, so a failing session still uses it.
    const countReview = (stage: BudgetStage) => {
      const current = budget();
      if (current[stage].reviews >= REVIEW_ROUNDS) throw exhausted(stage, 'reviews');
      save({ budget: { ...current, [stage]: { ...current[stage], reviews: current[stage].reviews + 1 } } });
    };
    // A failing runner check run uses one check attempt, never a review round.
    const countCheck = (stage: BudgetStage, findings: string[]) => {
      const current = budget();
      const checks = current[stage].checks + 1;
      save({ budget: { ...current, [stage]: { ...current[stage], checks } }, findings });
      if (checks >= CHECK_ATTEMPTS[stage]) throw exhausted(stage, 'checks');
    };
    // A review that did not accept on the last round exhausts the review budget.
    const afterRejection = (stage: BudgetStage) => {
      if (budget()[stage].reviews >= REVIEW_ROUNDS) throw exhausted(stage, 'reviews');
    };
    const rememberPr = (pr: PullRequest) => {
      const previous = activeWork().pr;
      save({ pr: { ...pr, url: pr.url ?? (previous?.number === pr.number ? previous.url : undefined) } });
    };
    // Removes the worktree, the local branch and (after acceptance) the remote branch of an accepted task under the
    // Git lock. Each step is attempted independently; the failed steps are returned and never change the result.
    const cleanupTask = (subject: string, work: Pick<Work, 'path' | 'branch'>, remote: boolean): CleanupStep[] => {
      const failed: CleanupStep[] = [];
      const steps: [CleanupStep, () => void][] = [
        ['worktree', () => {
          if (existsSync(work.path)) {
            if (!within(resolve(work.path), outcomes)) throw new Error('Task worktree outside the outcomes directory');
            git(root, 'worktree', 'remove', '--force', work.path);
          }
          git(root, 'worktree', 'prune');
        }],
        ['local-branch', () => { if (hasRef(root, `refs/heads/${work.branch}`)) git(root, 'branch', '-D', work.branch); }],
        ...(remote ? [['remote-branch', () => {
          if (git(root, 'ls-remote', 'origin', `refs/heads/${work.branch}`)) pushBookkeeping(root, 'origin', '--delete', work.branch);
        }] as [CleanupStep, () => void]] : []),
      ];
      try {
        lockGit(subject, () => {
          for (const [step, run] of steps) { try { run(); } catch { failed.push(step); } }
        });
      } catch {
        for (const [step] of steps) if (!failed.includes(step)) failed.push(step);
      }
      return failed;
    };
    const authorized = (queue: Queue, id: string): Task => {
      const task = queue.tasks.find(item => item.id === id);
      if (!task || hash(task) !== config.authority.tasks[id]) throw new Error('Task source differs from frozen authority');
      return task;
    };
    const assertWork = (work: Work): boolean => {
      const { queue } = refresh(work.id); authorized(queue, work.id);
      if (git(work.path, 'branch', '--show-current') !== work.branch) throw new Error('Work branch changed');
      // After the archive the binding follows the files, so integrity checks read the archived change.
      const directory = work.archive?.directory ?? work.directory;
      if (work.specification && hash(packet(work.path, directory)) !== hash(work.specification)) {
        throw new Error('Exact specification changed after authorization');
      }
      return true;
    };
    // `kind` names the step line written before each command; only the program name and its index are shown.
    const checks = (work: Work, definitions: CommandSpec[], kind?: 'setup' | 'check', attempt?: number): CheckRecord[] => {
      const rows: CheckRecord[] = [];
      const finalGate = definitions === project.checks && activeWork()?.stage === 'publish';
      for (const [index, check] of definitions.entries()) {
        const args = check.args.map(arg => arg.replaceAll('{change}', work.change)
          .replaceAll('{target}', project.target).replaceAll('{scope}', work.scopes[0])
          .replaceAll('{coverage}', String(config.coverage)));
        if (kind) taskStep(work.id, kind, `running ${index + 1}/${definitions.length}: ${basename(check.command)}`, attempt);
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
    // Whether a Git command succeeds in `cwd`.
    const succeeds = (cwd: string, ...args: string[]): boolean => {
      try { git(cwd, ...args); return true; } catch { return false; }
    };
    // Paths of `paths` that exist in the worktree or are tracked; the archive removes the change directory.
    const present = (work: Work, paths: string[]): string[] => paths.filter(path =>
      existsSync(join(work.path, path)) || git(work.path, 'ls-files', '--', path));
    const commit = (work: Work): void => {
      const paths = present(work, [...work.scopes, work.directory]);
      if (paths.length) git(work.path, 'add', '--', ...paths);
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
    // The task scopes and the paths that conflicted with the advanced target: what a conflict resolution session
    // and a send-back session may write, and what the send-back commit stages.
    const integrationPaths = (work: Work, conflicts: string[]): string[] => [...new Set([...work.scopes, ...conflicts])];
    // The send-back commit never stages the (archived) change directory, unless one of its files conflicted.
    const commitSendBack = (work: Work, conflicts: string[]): void => {
      const paths = present(work, integrationPaths(work, conflicts));
      if (paths.length) git(work.path, 'add', '-A', '--', ...paths);
      if (git(work.path, 'diff', '--cached', '--name-only')) {
        git(work.path, 'commit', '-m', commitSubject('fix', `address the integration findings of ${work.id}`));
      }
    };
    // The sorted unmerged paths of the task worktree.
    const unmergedPaths = (work: Work): string[] => [...new Set(git(work.path, 'diff', '--name-only', '--diff-filter=U')
      .split('\n').filter(Boolean))].sort();
    // Starts the durable `integrate` stage for `target`; every earlier acceptance is cleared so it is never reused.
    const startIntegration = (target: string): void => {
      save({ stage: 'integrate', integration: { target, previousBase: activeWork().base, conflicts: [], step: 'merge',
        outcome: 'clean' }, review: undefined, checks: undefined, finalChecks: undefined, documentationChecks: undefined,
        head: undefined, testedTarget: undefined, findings: [] });
    };
    /**
     * `contained`: HEAD already contains the target. `merged`: an advance outside the guarded paths was merged and
     * set up as before; the base is unchanged. `integrate`: an advance inside the guarded paths (the files the task
     * changed, its change and its archive), or a merge with conflicts (aborted first), started the durable
     * `integrate` stage.
     */
    const integrateTarget = (work: Work, target: string, attempt?: number): 'contained' | 'merged' | 'integrate' => {
      if (git(work.path, 'merge-base', target, 'HEAD') === target) return 'contained';
      const recorded = activeWork();
      const changed = git(work.path, 'diff', '--name-only', recorded.base, target).split('\n').filter(Boolean);
      // Tasks may share scopes, so only an advance that touches a file this task changed, its change or the
      // specification files written by its archive needs the checks and reviews again.
      const archive = recorded.archive;
      const owned = [work.directory, ...(archive ? [archive.directory, ...archive.specs] : [])];
      const own = new Set(git(work.path, 'diff', '--name-only', `${target}...HEAD`).split('\n').filter(Boolean));
      if (changed.some(path => own.has(path) || owned.some(root => within(path, root)))) {
        startIntegration(target);
        return 'integrate';
      }
      taskStep(work.id, 'integrate', `integrating the advanced ${project.target}`, attempt);
      try {
        git(work.path, 'merge', '--no-edit', '-m', commitSubject('chore', `integrate ${project.target} into ${work.id}`), target);
      } catch (error) {
        if (!unmergedPaths(work).length) throw error;
        // The integrate stage merges again, records the conflicts and gives them one resolution session.
        git(work.path, 'merge', '--abort');
        startIntegration(target);
        return 'integrate';
      }
      save({ integratedTargets: integrated(target) });
      checks(work, project.setup ?? [], 'setup', attempt);
      return 'merged';
    };
    const runProductChecks = (work: Work, attempt?: number): CheckRecord[] => {
      try { return checks(work, project.checks, 'check', attempt); }
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
    // `writablePaths`, when given, replaces the default writable paths of `purpose` (the send-back session passes
    // only the task scopes).
    const session = async (work: Work, purpose: Purpose, prompt: string, implementationReview = false,
      attempt?: number, writablePaths?: string[]): Promise<ReviewRecord> => {
      let result: WorkerReport | undefined;
      const files = git(work.path, 'ls-files', '-z').split('\0').filter(Boolean);
      const instructionPaths = [...new Set(['AGENTS.md', ...[...work.scopes, work.directory].flatMap(path =>
        path.split('/').map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/AGENTS.md`))])];
      // A documentation session writes inside the task scopes, and only documentation files there.
      const writable = writablePaths ?? (purpose === 'plan' ? [work.directory] : purpose === 'work' ?
        [...work.scopes, `${work.directory}/tasks.md`, `${work.directory}/compliance.md`,
          `${work.directory}/verification.md`] : purpose === 'document' ? [...work.scopes] : []);
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
            taskStep(work.id, 'commit', 'committing the implementation', attempt);
            assertWork(activeWork()); commit(work);
            const evidence = runProductChecks(work, attempt); save({ checks: evidence });
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
          'The session sandbox is read-only on purpose: backlog_tool write_file and delete_file are the way to change ' +
          'files and are allowed inside the authorized scopes, so a read-only sandbox is never a blocker. ' +
          'The runner binds the specification when the plan is accepted; work and document sessions always start ' +
          'after binding, so run_checks is available there and no binding step is left to you. ' +
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
    // Each retried task gets a fresh budget and a retry record on its work and in the state, in one update.
    if (retry.length) {
      const at = new Date(now()).toISOString();
      const blocked: Record<string, BlockedEntry> = { ...store.state.blocked };
      const records: RetryRecord[] = [];
      for (const id of retry) {
        const entry = blocked[id];
        const record: RetryRecord = { task: id, at, stage: entry.work.stage, previous: structuredClone(budgetOf(entry.work)),
          ...(entry.budget ? { exhausted: structuredClone(entry.budget) } : {}) };
        blocked[id] = { ...entry, work: { ...entry.work, budget: freshBudget(),
          retries: [...(entry.work.retries ?? []), record] } };
        records.push(record);
      }
      store.update({ blocked, retries: [...(store.state.retries ?? []), ...structuredClone(records)] });
    }
    const recovery = Object.values(store.state.blocked ?? {}).map(entry => entry.work).filter(Boolean);
    for (const work of recovery.filter(work => ids.includes(work.id))) statistics?.decision(work, 'blocked', work);
    if (store.state.current) statistics?.decision(store.state.current, 'blocked', store.state.current);
    for (const work of [...recovery, ...(store.state.current ? [store.state.current] : [])]) resumable.add(work.id);
    store.update({ blocked: {} });
    // Leftover worktrees and local branches of tasks this invocation already accepted are removed before any task
    // is selected. Only this invocation's own state is considered; failures are recorded and never stop the run.
    for (const [id, entry] of Object.entries(store.state.completed ?? {})) {
      if (!entry?.path || !entry.branch || !existsSync(entry.path) && !hasRef(root, `refs/heads/${entry.branch}`)) continue;
      step('run', 'cleanup', `removing the leftover worktree of ${id}`);
      const failed = cleanupTask('run', entry, false);
      store.update({ completed: { ...store.state.completed, [id]: { ...entry, cleanup: { failed } } } });
      await cancellable(afterEffect('sweep', entry), signal);
    }
    store.update({ status: 'running' });
    const blockedInInvocation = () => Object.keys(store.state.blocked ?? {}).some(id => ids.includes(id));
    // Every return of the loop records the invocation status the run reached in state.json first.
    const finish = (result: RunResult): RunResult => {
      const status = released ? 'released' : blockedInInvocation() ? 'blocked' :
        result.status === 'limit-reached' ? 'completed' : 'incomplete';
      store.update({ status });
      return result;
    };
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
      const explain = (unfinished: string[], foreignClaims: Claim[]) => explainUnfinished({ remaining: unfinished, ids,
        tasks: queue.tasks, completed: store.state.completed ?? {}, blocked: store.state.blocked ?? {}, done,
        baselineDone: store.state.baselineDone ?? [], maxAccepted: config.maxAccepted, foreignClaims,
        statePath: stateFile });
      const withBlockers = (blockers: Record<string, Blocker>) => Object.keys(blockers).length ? { blockers } : {};
      let acceptanceFailed = false;
      if (current && done.has(current.id)) {
        try {
          taskStep(current.id, 'acceptance', 'recording the acceptance');
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
          // The merged task stays blocked for the next run; other tasks are still worked unless the limit is reached.
          store.update({ blocked: { ...store.state.blocked, [current.id]: {
            reason: failureDetail(error), work: current } }, current: null });
          blockedStep(current.id, current.stage);
          acceptanceFailed = true;
        }
        if (!acceptanceFailed) {
          // The merge is confirmed, so the task worktree, local branch and remote branch are no longer needed.
          taskStep(current.id, 'cleanup', 'removing the worktree and branches');
          const cleanupFailed = cleanupTask(current.id, completed[current.id], true);
          if (cleanupFailed.length) {
            completed[current.id] = { ...completed[current.id], cleanup: { failed: cleanupFailed } };
            store.update({ completed: { ...store.state.completed, [current.id]: completed[current.id] } });
          }
          report({ status: 'accepted', id: current.id, ...completed[current.id].completion,
            ...(cleanupFailed.length ? { cleanupFailed } : {}) });
        }
      }
      const newlyAccepted = Object.keys(completed).filter(id => done.has(id) && !store.state.baselineDone!.includes(id));
      const remaining = ids.filter(id => !done.has(id));
      for (const task of queue.tasks.filter(task => remaining.includes(task.id))) {
        if (task.id === store.state.current?.id) statistics?.decision(task, 'blocked', store.state.current!);
        else if (store.state.blocked?.[task.id]) statistics?.decision(task, 'blocked', store.state.blocked[task.id].work);
        else statistics?.decision(task);
      }
      const limitReached = !!config.maxAccepted && acceptedThisRun({ ids, completed: store.state.completed ?? {},
        blocked: store.state.blocked ?? {}, done, baselineDone: store.state.baselineDone! }).length >= config.maxAccepted;
      // A merged task of the invocation whose acceptance recording failed (in this iteration or an earlier one) keeps
      // the run incomplete (exit 3) when the limit is reached, even when a later task reached it.
      const mergedBlocked = ids.some(id => done.has(id) && Object.hasOwn(store.state.blocked ?? {}, id));
      if (mergedBlocked && limitReached) {
        return finish({ status: 'incomplete', ...resultData(newlyAccepted), remaining,
          blockers: explain(remaining, foreignClaimsOf(ledger.pull(), done, claimant)) });
      }
      if (limitReached) {
        if (!Object.keys(store.state.blocked!).length && !store.state.current && !recovery.length) release();
        return finish({ status: 'limit-reached', ...resultData(newlyAccepted), remaining,
          ...withBlockers(explain(remaining, foreignClaimsOf(ledger.pull(), done, claimant))) });
      }
      if (!remaining.length) {
        // A merged task whose acceptance recording failed keeps the ownership for the next run.
        if (blockedInInvocation()) {
          return finish({ status: 'incomplete', ...resultData(newlyAccepted), remaining, blockers: explain(remaining, []) });
        }
        release();
        return finish({ status: config.maxAccepted ? 'incomplete' : 'exhausted', ...resultData(newlyAccepted), remaining });
      }
      if (stopped) return finish({ status: 'cancelled', ...resultData(newlyAccepted), remaining });
      let work = store.state.current;
      if (!work) {
        const ledgerSnapshot = ledger.pull();
        const foreignClaims = foreignClaimsOf(ledgerSnapshot, done, claimant);
        for (const candidate of queue.tasks.filter(task => remaining.includes(task.id))) {
          if (foreignClaims.some(claim => claim.id === candidate.id)) {
            statistics?.decision(candidate, 'claimed-elsewhere');
          }
        }
        const task = queue.tasks.filter(task => remaining.includes(task.id) && !store.state.blocked![task.id] &&
          task.dependencies.every(id => done.has(id)) &&
          !foreignClaims.some(claim => claim.id === task.id))
          .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
        if (!task) {
          const blockers = explain(remaining, foreignClaims);
          // Work held by another runner or waiting for a dependency is waited for; anything blocked in this
          // invocation (or waiting for such a task or scope) ends the run, because nobody else can finish it.
          if (waitsForFreeWork(blockers)) {
            step('run', 'wait', waitMessage(blockers, foreignClaims, pollSeconds));
            await sleep(pollSeconds * 1000, waitSignal);
            // A cancel during the wait ends the run before any fetch, ledger pull, claim, worktree or session.
            if (stopped || signal?.aborted) {
              return finish({ status: 'cancelled', ...resultData(newlyAccepted), remaining, blockers });
            }
            continue;
          }
          return finish({ status: 'incomplete', ...resultData(newlyAccepted), remaining, blockers,
            claimedElsewhere: Object.fromEntries(foreignClaims.map(claim => [claim.id, { host: claim.host }])) });
        }
        const operation = hash({ invocation: config.invocation, id: task.id, authority: config.authority.reference });
        const branch = `outcome/${task.id}-${operation.slice(0, 12)}`;
        taskStep(task.id, 'claim', 'claiming the task');
        let claimed: boolean;
        ledgerSubject = task.id;
        try {
          claimed = ledgerSnapshot.claims.has(task.id) || ledger.acquire(ledgerSnapshot, {
            version: 1, id: task.id, taskHash: hash(task), scopes: task.scopes, claimant,
            host: hostname(), branch, claimedAt: new Date(now()).toISOString(),
          }, commitSubject('chore', `claim ${task.id}`));
        } finally { ledgerSubject = 'run'; }
        if (!claimed) continue;
        save({ ...task, taskHash: hash(task), operation, stage: 'claim', base: target, branch,
          path: join(outcomes, operation), directory: `${project.changes}/${task.change}` });
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
            const claimed = work;
            taskStep(claimed.id, 'worktree', 'preparing the worktree');
            lockGit(claimed.id, () => git(root, 'worktree', 'add', '-b', claimed.branch, claimed.path, claimed.base));
            await cancellable(afterEffect('claim', work), signal);
          }
          if (git(work.path, 'rev-parse', 'HEAD') !== work.base || git(work.path, 'status', '--porcelain')) {
            throw new Error('Initial worktree differs from recorded base');
          }
          save({ stage: 'investigate' });
        }
        if (activeWork().stage === 'investigate') {
          checks(work, project.setup ?? [], 'setup');
          taskStep(work.id, 'investigation', 'starting the investigation session');
          const investigation = await session(work, 'investigate', prompt +
            'Inspect current files and history before edits. Call outcome_report with outcome ready, summary, ' +
            'inspected containing actual inspected repository paths, and findings array. Do not edit files. ' +
            'Do not use a final message as a substitute for outcome_report.');
          save({ investigation, stage: 'plan' });
        }
        // Planning and implementation rounds are bounded only by the durable review and check budgets.
        if (activeWork().stage === 'plan') {
          enterBudget();
          for (;;) {
            guardRound('plan');
            const number = sessionsStarted(activeWork(), 'plan') + 1;
            taskStep(work.id, 'planning', 'starting the planning session', number);
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
              taskStep(work.id, 'planning check', 'validating the planning artifacts', number);
              specification = packet(work.path, work.directory);
              checks(work, [project.planningCheck]);
            } catch (error) {
              countCheck('plan', [failureDetail(error)]); continue;
            }
            countReview('plan');
            taskStep(work.id, 'planning review', 'starting the planning review session', number);
            const review = await session(work, 'review', prompt +
              'Review planning artifacts independently against exact source criteria, scope and decisions. ' +
              'Report accepted only with zero findings; otherwise changes-required with concrete findings. ' +
              planningReviewTestInstructions(config.coverage));
            save({ planningReviews: [...(activeWork().planningReviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ specification, stage: 'work', findings: [] }); break;
            }
            save({ findings: review.findings });
            afterRejection('plan');
          }
        }
        if (activeWork().stage === 'work') {
          enterBudget();
          for (;;) {
            guardRound('work');
            const number = sessionsStarted(activeWork(), 'work') + 1;
            taskStep(work.id, 'implementation', 'starting the implementation session', number);
            await session(activeWork(), 'work', prompt +
              'Implement all approved OpenSpec scenarios and every test marked (required) within product scope; ' +
              'write (coverage-only) tests only as the graded test rules below allow. ' +
              workTestInstructions(config.coverage) + ' Preserve bound specs. ' + LEFTOVER_FILES_WORK + ' ' +
              'Address private findings: ' + JSON.stringify(activeWork().findings ?? []), false, number);
            await cancellable(afterEffect('implementation', activeWork()), signal);
            taskStep(work.id, 'commit', 'committing the implementation', number);
            assertWork(activeWork()); commit(work);
            try { save({ checks: checks(work, project.checks, 'check', number) }); }
            catch (error) { countCheck('work', [failureDetail(error)]); continue; }
            countReview('work');
            taskStep(work.id, 'review', 'starting the implementation review session', number);
            const review = await session(activeWork(), 'review', prompt + implementationReview(config.coverage),
              true, number);
            save({ reviews: [...(activeWork().reviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              // The documentation stage starts from the reviewed head; its record lists what it later updates.
              save({ review: { ...review, accepted: true }, stage: 'document', findings: [],
                documentation: { base: git(work.path, 'rev-parse', 'HEAD'), files: [], outsideScope: [] } });
              break;
            }
            save({ findings: review.findings });
            afterRejection('work');
          }
        }
        // Each documentation round persists its stage before the next session, so a restart in document-review
        // reviews the recorded documentation instead of writing it again.
        while (['document', 'document-review'].includes(activeWork().stage)) {
          enterBudget();
          // Round N of the documentation follows N - 1 counted documentation review rounds.
          const round = budget().document.reviews + 1;
          if (activeWork().stage === 'document') {
            guardRound('document');
            taskStep(work.id, 'documentation', 'starting the documentation session', round);
            const documented = await session(activeWork(), 'document', prompt +
              'Update the documentation inside the task scopes so that it matches the implemented behaviour and every ' +
              'criterion. Documentation files are README files, Markdown files (.md, .mdx) and files under docs or doc ' +
              `directories. Write only documentation files inside the task scopes ${JSON.stringify(work.scopes)}; ` +
              'writes to product code, tests, OpenSpec files or paths outside the scopes are refused. ' +
              'Report in findings only documentation outside the task scopes that needs changes, one file and reason ' +
              'per finding, and call outcome_report with outcome ready. ' +
              'Address private findings: ' + JSON.stringify(activeWork().findings ?? []));
            await cancellable(afterEffect('documentation', activeWork()), signal);
            taskStep(work.id, 'commit', 'committing the documentation', round);
            assertWork(activeWork()); commitDocumentation(work);
            const record = activeWork().documentation ?? { base: work.base, files: [], outsideScope: [] };
            const files = git(work.path, 'diff', '--name-only', record.base, 'HEAD').split('\n').filter(path =>
              path && isDocumentation(path) && work.scopes.some(scope => within(path, scope)));
            save({ documentation: { ...record, files, outsideScope: [...new Set(documented.findings)] },
              stage: 'document-review' });
          }
          if (activeWork().stage === 'document-review') {
            // A restart in document-review skips the branch above, so the review budget is guarded here as well.
            countReview('document');
            taskStep(work.id, 'documentation review', 'starting the documentation review session', round);
            const review = await session(activeWork(), 'document-review', prompt + DOCUMENTATION_REVIEW);
            const reviews = [...(activeWork().documentationReviews ?? []), review];
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ documentationReviews: reviews, stage: 'final-checks', findings: [] });
            } else {
              save({ documentationReviews: reviews, findings: review.findings, stage: 'document' });
              afterRejection('document');
            }
          }
        }
        if (activeWork().stage === 'final-checks') {
          taskStep(work.id, 'final checks', 'running the final checks');
          assertWork(activeWork());
          save({ documentationChecks: runProductChecks(work), stage: 'archive' });
        }
        if (activeWork().stage === 'archive') {
          taskStep(work.id, 'archive', 'archiving the change');
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
          taskStep(work.id, 'commit', 'committing the archive');
          if (paths.length) git(work.path, 'add', '-A', '--', ...paths);
          if (git(work.path, 'diff', '--cached', '--name-only')) {
            git(work.path, 'commit', '-m', commitSubject('docs', `archive ${work.change} for ${work.id}`));
          }
          const written = git(work.path, 'diff', '--name-only', work.base, 'HEAD', '--', specs).split('\n').filter(Boolean);
          save({ archive: { directory, specs: written, head: git(work.path, 'rev-parse', 'HEAD') }, specification,
            stage: 'receipt' });
          await cancellable(afterEffect('archive', activeWork()), signal);
        }
        // A target advance into the paths the task changed is merged, checked and reviewed again. Every step saves
        // its successor before the next effect, so a restart resumes at the recorded step without merging twice or
        // reusing an acceptance.
        while (activeWork().stage === 'integrate') {
          const integration = activeWork().integration!;
          const subject = commitSubject('chore', `integrate ${project.target} into ${work.id}`);
          const merging = () => succeeds(work.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
          const contains = () => succeeds(work.path, 'merge-base', '--is-ancestor', integration.target, 'HEAD');
          const merged = `The task branch was merged with the advanced ${project.target} ${integration.target} ` +
            `(previous base ${integration.previousBase}, new base ${activeWork().base}, conflicts ` +
            `${JSON.stringify(integration.conflicts)}); review the merged result.`;
          // A failure after the merge blocks with the integration reason; a cancellation keeps the recorded step.
          const rejected = (error: unknown): never => {
            if (stopped || signal?.aborted || (error as InterruptedFailure).interrupted ||
                error instanceof IntegrationFailure) throw error;
            throw integration.outcome === 'conflict' ?
              new IntegrationFailure('target-conflict-unresolved', integration.conflicts) :
              new IntegrationFailure('target-integration-rejected', []);
          };
          const cancelled = (error: unknown): boolean => stopped || !!signal?.aborted ||
            !!(error as InterruptedFailure).interrupted;
          /**
           * A rejection of the merged result by the checks or a review. The integration, clean or with resolved
           * conflicts, is sent back once: the send-back step is saved before the next effect. A rejection after
           * that send-back records the last findings and blocks with `target-integration-rejected`.
           */
          const sendBackOrReject = async (cause: SendBackCause, findings: string[]): Promise<void> => {
            const current = activeWork().integration!;
            if (current.sendBack) {
              save({ findings, integration: { ...current, sendBack: { ...current.sendBack, outcome: 'rejected',
                rejection: { cause, findings: [...findings] } } } });
              taskStep(work.id, 'send-back', 'the merged result is still rejected after the send-back session',
                currentAttempt());
              throw new IntegrationFailure('target-integration-rejected', []);
            }
            taskStep(work.id, 'send-back', `the ${CAUSE_LABEL[cause]} did not accept the merged result; sending it back`,
              currentAttempt());
            save({ findings, integration: { ...current, step: 'send-back',
              sendBack: { cause, findings: [...findings], session: 'pending' } } });
            await cancellable(afterEffect('send-back-requested', activeWork()), signal);
          };
          // The send-back step text: the cause, the findings or check output, and the task scopes and conflicting
          // paths as the only writable paths.
          const sendBackPrompt = (sendBack: SendBackRecord): string =>
            `Address the rejection of the merged result: the ${CAUSE_LABEL[sendBack.cause]} did not accept the merge ` +
            `of the advanced ${project.target} ${integration.target} into the task branch. Findings or failed check ` +
            `output: ${JSON.stringify(sendBack.findings)}. Fix them by writing only inside the task scopes and the ` +
            `conflicting paths ${JSON.stringify(integrationPaths(work, integration.conflicts))}; writes to the ` +
            'OpenSpec change or any other path are refused. Keep all ' +
            'approved OpenSpec scenarios and tests passing. ' + workTestInstructions(config.coverage) + ' ' +
            LEFTOVER_FILES_WORK;
          if (integration.step === 'merge') {
            // The attempt is read from the durable work, so a restart keeps the number.
            taskStep(work.id, 'integrate', `merging the advanced ${project.target} into the task scope`, currentAttempt());
            assertWork(activeWork());
            let conflicts: string[] = [];
            if (merging()) {
              // The merge started before a restart.
              conflicts = unmergedPaths(work);
              if (!conflicts.length) git(work.path, 'commit', '--no-edit', '-m', subject);
            } else if (!contains()) {
              try { git(work.path, 'merge', '--no-edit', '-m', subject, integration.target); }
              catch (error) {
                conflicts = unmergedPaths(work);
                if (!conflicts.length) throw error;
              }
            }
            save({ base: integration.target, integratedTargets: integrated(integration.target),
              integration: { ...integration, conflicts, outcome: conflicts.length ? 'conflict' : 'clean',
                step: conflicts.length ? 'resolve' : 'checks' } });
            await cancellable(afterEffect('integrate', activeWork()), signal);
          } else if (integration.step === 'resolve') {
            try {
              const paths = integration.conflicts;
              taskStep(work.id, 'implementation', 'starting the conflict resolution session');
              await session(activeWork(), 'work', prompt + `Resolve the merge conflicts of the advanced ${project.target} ` +
                `${integration.target} in these paths: ${JSON.stringify(paths)}. Keep the intent of both sides, remove ` +
                'every conflict marker and keep all approved OpenSpec scenarios and tests passing. Write only inside ' +
                'the task scopes and the conflicting paths. ' + workTestInstructions(config.coverage), false, undefined,
                integrationPaths(work, paths));
              for (const path of paths) {
                const file = join(work.path, path);
                if (existsSync(file) && conflictMarkers(readFileSync(file, 'utf8'))) throw new Error('Conflict markers remain');
              }
              const staged = present(work, [...new Set([...paths, ...work.scopes])]);
              if (staged.length) git(work.path, 'add', '-A', '--', ...staged);
              if (merging()) git(work.path, 'commit', '--no-edit', '-m', subject);
              if (unmergedPaths(work).length || !contains()) throw new Error('The merge was not concluded');
            } catch (error) { rejected(error); }
            save({ integration: { ...integration, step: 'checks' } });
          } else if (integration.step === 'checks') {
            try { assertWork(activeWork()); } catch (error) { rejected(error); }
            // A failing setup or product check is a rejection; its stdout and stderr reach the send-back session.
            let rows: CheckRecord[] | undefined; let failure: unknown;
            try {
              checks(work, project.setup ?? [], 'setup');
              rows = runProductChecks(work);
            } catch (error) {
              if (cancelled(error)) throw error;
              failure = error;
            }
            if (rows) save({ checks: rows, documentationChecks: rows, integration: { ...integration, step: 'review' } });
            else await sendBackOrReject('checks', [failureDetail(failure)]);
          } else if (integration.step === 'review') {
            let review!: ReviewRecord;
            try {
              taskStep(work.id, 'review', 'starting the implementation review session of the merged result');
              review = await session(activeWork(), 'review', prompt + implementationReview(config.coverage) + ' ' +
                merged, true);
              save({ reviews: [...(activeWork().reviews ?? []), review] });
            } catch (error) { rejected(error); }
            if (review.outcome !== 'accepted' || review.findings.length) {
              await sendBackOrReject('review', review.findings);
            } else {
              save({ review: { ...review, accepted: true }, findings: [],
                integration: { ...integration, step: 'document-review' } });
            }
          } else if (integration.step === 'document-review') {
            let review!: ReviewRecord;
            try {
              taskStep(work.id, 'documentation review', 'starting the documentation review session of the merged result');
              review = await session(activeWork(), 'document-review', prompt + DOCUMENTATION_REVIEW + ' ' + merged);
            } catch (error) { rejected(error); }
            const documentationReviews = [...(activeWork().documentationReviews ?? []), review];
            if (review.outcome !== 'accepted' || review.findings.length) {
              save({ documentationReviews });
              await sendBackOrReject('document-review', review.findings);
            } else {
              let finished = integration;
              if (integration.sendBack) {
                taskStep(work.id, 'send-back', 'the merged result was accepted after the send-back session',
                  currentAttempt());
                finished = { ...integration, sendBack: { ...integration.sendBack, outcome: 'accepted' } };
              }
              save({ documentationReviews, findings: [], integration: undefined, stage: 'receipt',
                integrations: [...(activeWork().integrations ?? []), finished] });
            }
          } else {
            // The one send-back session of a rejected integration, limited to the task scopes and the paths that
            // conflicted. `started` is saved before the session, so a restart commits what is in the worktree and
            // never starts it again.
            const sendBack = integration.sendBack!;
            if (sendBack.session === 'pending') {
              taskStep(work.id, 'implementation', 'starting the send-back session of the merged result', currentAttempt());
              save({ integration: { ...integration, sendBack: { ...sendBack, session: 'started' } } });
              let failed = false;
              try {
                await session(activeWork(), 'work', prompt + sendBackPrompt(sendBack), false, undefined,
                  integrationPaths(work, integration.conflicts));
              } catch (error) {
                if (cancelled(error)) throw error;
                failed = true;
              }
              // A failed session is the rejection after the send-back: it blocks with the original cause and findings.
              if (failed) await sendBackOrReject(sendBack.cause, sendBack.findings);
              await cancellable(afterEffect('send-back', activeWork()), signal);
            }
            taskStep(work.id, 'commit', 'committing the send-back result', currentAttempt());
            try { assertWork(activeWork()); commitSendBack(work, integration.conflicts); } catch (error) { rejected(error); }
            const current = activeWork().integration!;
            save({ integration: { ...current, step: 'checks', sendBack: { ...current.sendBack!, session: 'finished' } } });
          }
        }
        if (activeWork().stage === 'receipt') {
          taskStep(work.id, 'receipt', 'recording the receipt');
          const now = activeWork(); assertWork(now);
          // After an integration the base is the merged target, and the earlier receipt commit follows it.
          const paths = git(work.path, 'diff', '--name-only', now.base, 'HEAD').split('\n')
            .filter(path => path && path !== receiptPath(work.id));
          if (!paths.length || outsideManifest(paths, now).length) {
            throw new Error('Empty or out-of-scope result manifest');
          }
          // A path the task deleted is recorded with hash null.
          const manifest = paths.map(path => {
            const file = join(work.path, path);
            return { path, hash: existsSync(file) ? digest(readFileSync(file)) : null };
          });
          // The changes recorded for the invocation so far (runner upgrade, added settings or tasks) are listed.
          const changes = store.state.changes ?? [];
          const receipt = { version: 1, id: work.id, taskHash: work.taskHash,
            authority: config.authority.reference, target: project.target, specification: now.specification,
            review: { ...reviewRecord(now.review!), accepted: true },
            checks: checkRecords(now.documentationChecks ?? now.checks!), manifest,
            head: git(work.path, 'rev-parse', 'HEAD'), base: now.base,
            ...(changes.length ? { invocationChanges: structuredClone(changes) } : {}),
            ...(now.retries?.length ? { retries: structuredClone(now.retries) } : {}) };
          const path = join(work.path, receiptPath(work.id)); mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
          taskStep(work.id, 'commit', 'committing the receipt');
          git(work.path, 'add', '--', receiptPath(work.id));
          if (git(work.path, 'diff', '--cached', '--name-only')) {
            git(work.path, 'commit', '-m', `docs(${project.commitScope ?? 'work-queue'}): record ${work.id} acceptance evidence${project.commitSuffix ?? ''}`);
          }
          save({ stage: 'publish' });
        }
        if (activeWork().stage === 'publish') {
          const attempt = currentAttempt();
          assertWork(activeWork());
          // Every publish pass begins with the comparison of origin/<target> with the integrated target.
          taskStep(work.id, 'compare', `comparing origin/${project.target} with the integrated target`, attempt);
          const targetNow = refresh(work.id).target;
          // An advance inside the guarded paths continues in the integrate stage of the next loop iteration.
          if (integrateTarget(work, targetNow, attempt) === 'integrate') continue;
          let finalChecks: CheckRecord[];
          try { finalChecks = checks(work, project.checks, 'check', attempt); }
          catch (error) {
            const interrupted = stopped || signal?.aborted || (error as InterruptedFailure).interrupted;
            if (interrupted || targetNow === activeWork().base) throw error;
            // The checks fail on a target that was merged without the reviews: the integrate stage runs them again
            // and gives the worker its send-back session.
            startIntegration(targetNow);
            continue;
          }
          save({ finalChecks });
          if (git(work.path, 'status', '--porcelain')) throw new Error('Final checks changed tracked inputs');
          const head = git(work.path, 'rev-parse', 'HEAD');
          const published = work;
          taskStep(work.id, 'push', 'pushing the tested head', attempt);
          lockGit(published.id, () => git(published.path, 'push', 'origin', `HEAD:refs/heads/${published.branch}`));
          save({ head, testedTarget: targetNow, stage: 'pr' });
        }
        if (activeWork().stage === 'pr') {
          const attempt = currentAttempt();
          taskStep(work.id, 'pull request', 'finding the pull request', attempt);
          const now = activeWork();
          const body = join(store.directory, `${work.id}-pr.md`);
          writeFileSync(body, pullRequestBody(now, config.authority.reference));
          let pr = await cancellable(Promise.resolve(host.find(work.branch)), signal);
          if (pr) { taskStep(work.id, 'pull request', `reusing #${pr.number}`, attempt); rememberPr(pr); }
          if (!pr) {
            taskStep(work.id, 'pull request', 'creating the pull request', attempt);
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
          const pause = polling.delay ?? delay;
          // Every comparison of origin/<target> with the checked target goes through this helper; it is logged when
          // `log` is set or when the target differs, so repeated unchanged polling stays quiet.
          const compareTarget = (log: boolean): boolean => {
            const targetNow = refresh(work.id).target;
            const unchanged = targetNow === activeWork().testedTarget;
            if (log || !unchanged) {
              taskStep(work.id, 'compare', `comparing origin/${project.target} with the checked target`, currentAttempt());
            }
            return unchanged;
          };
          // Called by the host right before its merge command: a difference means no merge command is issued.
          const guard = (): void => { if (!compareTarget(true)) throw new TargetAdvanced(); };
          /**
           * One pending view of the eligibility wait. The first one records the start of the wait and a
           * `checks-pending` retry; a wait line is written when the wait starts and whenever the status changes.
           * After 30 minutes since the recorded start the task blocks with `merge-not-eligible`; otherwise the next
           * view follows the eligibility poll interval. A restart keeps the recorded start.
           */
          const waitForChecks = async (number: number, status: string, names: string[]): Promise<void> => {
            const wait = activeWork().mergeWait;
            if (!wait || wait.status !== status) {
              taskStep(work.id, 'wait', `waiting for required checks of #${number} (${status})`, currentAttempt());
            }
            if (!wait) {
              const at = new Date(clock()).toISOString();
              save({ mergeWait: { since: at, status, checks: [...names], views: 1 },
                mergeRetries: [...(activeWork().mergeRetries ?? []), { attempt: currentAttempt(), reason: 'checks-pending',
                  at, status, checks: [...names] }] });
            } else {
              save({ mergeWait: { ...wait, status, checks: [...names], views: wait.views + 1 } });
            }
            if (clock() - Date.parse(activeWork().mergeWait!.since) >= MERGE_ELIGIBILITY_WAIT_MS) {
              throw new MergeNotEligible(status, names);
            }
            await cancellable(pause(polling.eligibilityPollMs ?? MERGE_ELIGIBILITY_POLL_MS), signal);
          };
          // The wait is announced once on entry and a stale head once per merge stage, never on every view.
          taskStep(work.id, 'wait', `waiting for mergeability and checks of ${now.pr ? `#${now.pr.number}` : 'the pull request'}`,
            currentAttempt());
          let headWait = false; let staleViews = 0;
          // Why the merge stage returns to publish: the target advanced, or the pull request is behind the target.
          let retry: 'target-advanced' | 'behind' | undefined;
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
            const ready = pr.headRefOid === now.head;
            // The eligibility of a ready view decides between merging, catching up, waiting and blocking.
            let status = ''; let kind: EligibilityClass | undefined; let names: string[] = [];
            if (ready) {
              const eligibility = host.eligibility ?
                await cancellable(Promise.resolve(host.eligibility(pr, now.head!)), signal) : ELIGIBLE;
              status = eligibility.status;
              ({ kind, checks: names } = classifyEligibility(eligibility));
            }
            if (!compareTarget(view === 1 || kind === 'eligible' || kind === 'behind')) { retry = 'target-advanced'; break; }
            if (ready) {
              if (kind === 'eligible') {
                taskStep(work.id, 'merge', `merging #${pr.number}`, currentAttempt());
                try { await cancellable(Promise.resolve(host.merge(pr, now.head!, guard)), signal); }
                catch (error) {
                  if (error instanceof TargetAdvanced) { retry = 'target-advanced'; break; }
                  if (!(error instanceof MergeIneligible)) throw error;
                  // The status changed between the eligibility read and the merge; it is handled like that status.
                  status = error.status;
                  ({ kind, checks: names } = classifyEligibility({ status: error.status, checks: error.checks }));
                  if (kind === 'eligible') kind = 'refused';
                  if (kind === 'behind' && !compareTarget(true)) { retry = 'target-advanced'; break; }
                }
                if (kind === 'eligible') {
                  await cancellable(afterEffect('merge', pr), signal);
                  break;
                }
              }
              if (kind === 'behind') { retry = 'behind'; break; }
              if (kind === 'failed') throw new MergeNotEligible(status, names);
              if (kind === 'refused') throw new MergeNotEligible(status, []);
              await waitForChecks(pr.number, status, names);
              continue;
            }
            if (!headWait) { headWait = true; taskStep(work.id, 'wait', 'waiting for pull request head to match', currentAttempt()); }
            assertOriginHead(work.path, work.branch, now.head!);
            // Only stale-head views count toward the view limit; eligibility polls are bounded by time.
            staleViews += 1;
            if (staleViews >= limit) throw new Error('Checked head or target changed');
            await cancellable(pause(polling.pollMs ?? MERGE_STATE_POLL_MS), signal);
          }
          if (retry) {
            // A failed comparison or a behind pull request: repeat the worktree merge, checks and comparison. Only
            // advances that are not release-only count, at most TARGET_ATTEMPTS times.
            const current = activeWork();
            const targetNow = refresh(work.id).target;
            const at = new Date(clock()).toISOString();
            const records = current.mergeRetries ?? [];
            if (current.testedTarget && releaseOnlyAdvance(work.path, current.testedTarget, targetNow)) {
              const attempt = currentAttempt();
              taskStep(work.id, 'retry', `origin/${project.target} advanced with a release commit; integrating it ` +
                `without using an attempt (attempt ${attempt})`);
              save({ stage: 'publish', mergeWait: undefined,
                mergeRetries: [...records, { attempt, reason: 'release-commit', at, target: targetNow }] });
            } else {
              const attempts = (current.targetAttempts ?? 0) + 1;
              if (attempts >= TARGET_ATTEMPTS) {
                save({ stage: 'publish', targetAttempts: 0, mergeWait: undefined });
                throw new IntegrationFailure('target-keeps-advancing', []);
              }
              taskStep(work.id, 'retry', retry === 'behind' ?
                `#${current.pr?.number} is behind origin/${project.target}; catching up` :
                `origin/${project.target} advanced; integrating it again`, attempts + 1);
              save({ targetAttempts: attempts, stage: 'publish', mergeWait: undefined,
                mergeRetries: [...records, { attempt: attempts + 1, reason: retry, at, target: targetNow,
                  ...(retry === 'behind' ? { status: 'BEHIND' } : {}) }] });
            }
            await cancellable(afterEffect('retry', activeWork()), signal);
            continue;
          }
          if (activeWork().mergeWait) save({ mergeWait: undefined });
          const targetNow = refresh(work.id).target;
          if (!accepted(targetNow, authorized(refresh(work.id).queue, work.id))) throw new Error('Merged result lacks valid receipt');
        }
      } catch (error) {
        if (stopped || signal?.aborted) {
          statistics?.decision(activeWork(), 'blocked', activeWork(), 'cancelled');
          return finish({ status: 'cancelled', ...resultData(newlyAccepted), remaining });
        }
        if ((error as InterruptedFailure).interrupted) throw error;
        const stage = activeWork().stage;
        // An unresolved target conflict keeps its conflicting paths beside the reason, an exhausted budget its
        // stage, exhausted part and counts, and a pull request that cannot become mergeable its status and checks.
        const paths = error instanceof IntegrationFailure && error.paths.length ? { paths: [...error.paths] } : {};
        const budgetDetail = error instanceof BudgetExhausted ? { budget: structuredClone(error.budget) } : {};
        const eligibility = error instanceof MergeNotEligible ?
          { eligibility: { status: error.status, checks: [...error.checks] } } : {};
        // The merge stage ends here, so an eligibility wait in progress is cleared; a restart starts a new one.
        const blockedWork = activeWork().mergeWait ? { ...activeWork(), mergeWait: undefined } : activeWork();
        store.update({ blocked: { ...store.state.blocked, [work.id]: {
          reason: (error as Error).message, ...paths, ...budgetDetail, ...eligibility, work: blockedWork } }, current: null });
        blockedStep(work.id, stage);
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
