import { createHash } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import type { SessionHandle, AdapterEvent } from './harness-adapter.ts';

export interface CommandSpec { command: string; args: string[] }

export interface Task {
  id: string;
  change: string;
  title: string;
  criteria: string[];
  scopes: string[];
  dependencies: string[];
  priority: number;
}

export interface Queue { version: number; tasks: Task[] }

export interface Project {
  queue: string;
  changes: string;
  receipts: string;
  target: string;
  repository?: string;
  commitScope?: string;
  commitSuffix?: string;
  checks: CommandSpec[];
  planningCheck: CommandSpec;
  setup?: CommandSpec[];
  /** Archives the OpenSpec change in the worktree; `{change}` is replaced by the task change name. */
  archive?: CommandSpec;
}

/** The archive command used when a project does not configure one. */
export const DEFAULT_ARCHIVE: CommandSpec = Object.freeze({
  command: 'openspec', args: Object.freeze(['archive', '{change}', '--yes']) as string[] });
export const archiveCommand = (project: Pick<Project, 'archive'>): CommandSpec => project.archive ?? DEFAULT_ARCHIVE;

export interface Authority {
  reference: string;
  instruction: string;
  target: string;
  tasks: Record<string, string>;
}

export type Harness = 'claude' | 'codex';

export interface RunConfig {
  mode?: string;
  root: string;
  stateDirectory: string;
  invocation: string;
  authority: Authority;
  project: Project;
  maxAccepted?: number;
  leaves?: string[];
  harness?: Harness;
  model?: string;
  effort?: string;
  coverage?: number;
  /**
   * Seconds between two polls while the run waits for work claimed elsewhere or for a dependency; an integer from 5
   * through 3600, 60 when omitted. Operational only: it never enters the invocation identity.
   */
  pollSeconds?: number;
}

export interface ResolvedRunConfig extends RunConfig {
  harness: Harness;
  model: string;
  effort: string;
  coverage: number;
}

export type Stage = 'claim' | 'investigate' | 'plan' | 'work' | 'document' | 'document-review' | 'final-checks' |
  'archive' | 'integrate' | 'receipt' | 'publish' | 'pr' | 'merge';
export type Purpose = 'investigate' | 'plan' | 'work' | 'review' | 'document' | 'document-review';

/** The stages with a durable review and check budget. */
export type BudgetStage = 'plan' | 'work' | 'document';
/** The used review rounds and failing check runs of one budget stage. */
export interface StageBudget { reviews: number; checks: number }
/** The used counts of every budget stage of a task. */
export type TaskBudget = Record<BudgetStage, StageBudget>;
export interface BudgetUse { used: number; limit: number }
/** A budget that ran out: its stage, which part ran out and the used and allowed counts of both parts. */
export interface BudgetExhaustion {
  stage: BudgetStage;
  exhausted: 'reviews' | 'checks';
  reviews: BudgetUse;
  checks: BudgetUse;
}
/** One owner retry (`--retry <task id>`) of a blocked task: the budget it replaced and the exhaustion, if any. */
export interface RetryRecord {
  task: string;
  at: string;
  stage: Stage;
  previous: TaskBudget;
  exhausted?: BudgetExhaustion;
}

/**
 * Why the merge stage did not merge and tried again: the target advanced, the pull request was behind the target,
 * the target advanced only by release commits (no attempt used), or required checks were still pending.
 */
export type MergeRetryReason = 'target-advanced' | 'behind' | 'release-commit' | 'checks-pending';

/**
 * One merge-stage retry. `attempt` is the attempt the retry leads to; it is unchanged for `release-commit` and
 * `checks-pending`.
 */
export interface MergeRetry {
  attempt: number;
  reason: MergeRetryReason;
  at: string;
  status?: string;
  target?: string;
  checks?: string[];
}

/** A running wait for pending required checks: its start, the last status and pending checks and the views read. */
export interface MergeWait { since: string; status: string; checks: string[]; views: number }

/**
 * The durable steps of merging a target advance into the paths the task changed, in order. `send-back` is the one
 * worker session of a rejected integration; the checks and both reviews follow it again.
 */
export type IntegrationStep = 'merge' | 'resolve' | 'checks' | 'review' | 'document-review' | 'send-back';

/**
 * What did not accept the merged result: the setup or product checks, the implementation review or the
 * documentation review.
 */
export type SendBackCause = 'checks' | 'review' | 'document-review';

/** The one send-back of a clean integration. */
export interface SendBackRecord {
  /** What rejected the merged result before the session. */
  cause: SendBackCause;
  /** The review findings or the failed check output given to the session. */
  findings: string[];
  /**
   * `pending`: not started. `started`: saved right before the session starts. `finished`: session done and result
   * committed.
   */
  session: 'pending' | 'started' | 'finished';
  /** Set when the checks and both reviews after the session decided. */
  outcome?: 'accepted' | 'rejected';
  /** The last rejection after the session: its cause and its findings or check output. */
  rejection?: { cause: SendBackCause; findings: string[] };
}

/** One merge of an advanced target that changed the task's guarded paths. */
export interface IntegrationRecord {
  /** The `origin/<target>` commit being merged. */
  target: string;
  /** The task's base before this integration. */
  previousBase: string;
  /** The sorted conflicting paths; empty for a clean merge. */
  conflicts: string[];
  outcome: 'clean' | 'conflict';
  step: IntegrationStep;
  /**
   * The one send-back of this integration; absent when none was needed. Its presence means that this target
   * commit has used its send-back.
   */
  sendBack?: SendBackRecord;
}

export interface CheckRecord extends CommandSpec { outcome: string; output?: string }

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';
export interface Completion { summary: string; grade: Grade }
export interface TaskCompletion extends Completion { durationSeconds: number }

export interface WorkerReport {
  completion?: Completion;
  outcome: string;
  summary: string;
  findings: string[];
  inspected?: string[];
}

export interface ReviewRecord extends WorkerReport { reviewer: string; accepted?: boolean }

export interface PullRequest {
  url?: string;
  number: number;
  state: string;
  headRefOid: string;
  baseRefName: string;
  branch?: string;
}

export interface WorkerSession {
  purpose: Purpose;
  threadId: string;
  events: AdapterEvent[];
  privateText: string;
}

/** Documentation stage result: the commit it started from, updated files and out-of-scope findings. */
export interface DocumentationRecord { base: string; files: string[]; outsideScope: string[] }

/** Archive stage result: the archived change directory and the specification files the archive wrote. */
export interface ArchiveRecord { directory: string; specs: string[]; head: string }

/** A cleanup step after acceptance; failed steps are recorded and never change the result. */
export type CleanupStep = 'worktree' | 'local-branch' | 'remote-branch';

export interface Work extends Task {
  taskHash: string;
  operation: string;
  stage: Stage;
  base: string;
  branch: string;
  path: string;
  directory: string;
  specification?: Record<string, string>;
  findings?: string[];
  checks?: CheckRecord[];
  finalChecks?: CheckRecord[];
  investigation?: ReviewRecord;
  planningReviews?: ReviewRecord[];
  reviews?: ReviewRecord[];
  review?: ReviewRecord;
  documentation?: DocumentationRecord;
  documentationReviews?: ReviewRecord[];
  documentationChecks?: CheckRecord[];
  archive?: ArchiveRecord;
  /** The integration in progress; unset outside the `integrate` stage. */
  integration?: IntegrationRecord;
  /** Every finished integration, oldest first. */
  integrations?: IntegrationRecord[];
  /** Every origin/<target> commit merged into the task branch, oldest first. */
  integratedTargets?: string[];
  /** Consecutive comparisons that found origin/<target> different from the checked target. */
  targetAttempts?: number;
  /** Every merge-stage retry and its reason, oldest first. */
  mergeRetries?: MergeRetry[];
  /** The wait for pending required checks in progress; cleared when the merge stage ends. */
  mergeWait?: MergeWait;
  session?: SessionHandle & { purpose: Purpose };
  sessions?: WorkerSession[];
  sessionStarts?: Partial<Record<Purpose, number>>;
  lastToolError?: { purpose: Purpose; input: unknown; message: string };
  lastReportAttempt?: { purpose: Purpose; input: unknown };
  head?: string;
  testedTarget?: string;
  pr?: PullRequest;
  acceptedTarget?: string;
  claimedAt?: string;
  acceptedAt?: string;
  completion?: TaskCompletion;
  cleanup?: { failed: CleanupStep[] };
  /** The used review rounds and check attempts; absent in work recorded before budgets existed. */
  budget?: TaskBudget;
  /** Every owner retry of this task, oldest first. */
  retries?: RetryRecord[];
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const digest = (bytes: BinaryLike): string => createHash('sha256').update(bytes).digest('hex');
export function safePath(path: string): string {
  if (typeof path !== 'string' || !path || path.startsWith('/') ||
      /[\\\x00-\x1f*?\[\]]/u.test(path) ||
      path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) {
    throw new Error('Expected a safe repository-relative path');
  }
  return path;
}
const FORBIDDEN_BRANCH_CHARACTERS = '~^:?*[\\';
/**
 * The rules of `git check-ref-format --branch` for a plain branch name: nonempty, not `@`; no component beginning
 * with a dot or ending with `.lock`; no `..`, `@{` or `//`; no control character, space, `~`, `^`, `:`, `?`, `*`,
 * `[` or backslash; no leading `-` or `/`; no trailing `/` or dot.
 */
export function validBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name === '@') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if ([...name].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 ||
    FORBIDDEN_BRANCH_CHARACTERS.includes(character))) return false;
  return name.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
export const within = (path: string, scope: string): boolean => path === scope || path.startsWith(`${scope}/`);
/** A documentation file is a README file, a Markdown file, or any file under a docs or doc directory. */
export function isDocumentation(path: string): boolean {
  const parts = path.split('/'); const name = parts.at(-1) ?? '';
  return /^readme(?:\.|$)/iu.test(name) || /\.mdx?$/iu.test(name) ||
    parts.slice(0, -1).some(part => part === 'docs' || part === 'doc');
}
/** The directory beside the changes directory that receives the archived specification updates. */
export const specsDirectory = (changes: string): string =>
  changes.includes('/') ? changes.replace(/[^/]+$/u, 'specs') : 'specs';
export function validateQueue(candidate: unknown, project?: Project): Queue {
  const queue = candidate as Queue;
  const protectedPaths = project ? [project.queue, project.receipts, project.changes] : [];
  if (queue?.version !== 1 || !Array.isArray(queue.tasks) || !queue.tasks.length) {
    throw new Error('Expected a nonempty version 1 outcome queue');
  }
  const ids = new Set<string>(); const changes = new Set<string>();
  for (const task of queue.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(task.id ?? '') || ids.has(task.id) ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(task.change ?? '') || changes.has(task.change) ||
        typeof task.title !== 'string' || !task.title ||
        !Array.isArray(task.criteria) || !task.criteria.length ||
        task.criteria.some(value => typeof value !== 'string' || !value) ||
        !Array.isArray(task.scopes) || !task.scopes.length ||
        !Array.isArray(task.dependencies) || !Number.isSafeInteger(task.priority)) {
      throw new Error('Invalid or duplicate outcome definition');
    }
    task.scopes.forEach(path => {
      safePath(path);
      if (protectedPaths.some(protectedPath =>
        within(path, protectedPath) || within(protectedPath, path))) {
        throw new Error('Product scope overlaps queue or controller artifacts');
      }
    });
    ids.add(task.id); changes.add(task.change);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (!ids.has(id) || visiting.has(id)) throw new Error('Unknown or cyclic outcome dependency');
    if (visited.has(id)) return;
    visiting.add(id);
    queue.tasks.find(task => task.id === id)!.dependencies.forEach(visit);
    visiting.delete(id); visited.add(id);
  };
  ids.forEach(visit); return queue;
}
export function resolveCoverage(value: unknown = 85): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('Invalid coverage: expected an integer from 1 to 100');
  }
  return value;
}

/** The default seconds between two polls of a run that waits for free work. */
export const DEFAULT_POLL_SECONDS = 60;

/**
 * The poll interval in seconds: `value`, or 60 when omitted. Anything but a safe integer from 5 through 3600 throws
 * an error with `reason` `invalid-poll-seconds` and `details` naming the `pollSeconds` setting and the value.
 */
export function resolvePollSeconds(value: unknown = DEFAULT_POLL_SECONDS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 3600) {
    throw Object.assign(new Error('Invalid pollSeconds: expected an integer from 5 through 3600'),
      { reason: 'invalid-poll-seconds', details: { setting: 'pollSeconds', value } });
  }
  return value;
}

export function validateConfig<T extends RunConfig>(config: T): T {
  resolveCoverage(config.coverage);
  resolvePollSeconds(config.pollSeconds);
  const project = config.project;
  if ((config.mode ?? 'OFF') !== 'OFF' || !config.root || !config.stateDirectory ||
      !config.invocation || !config.authority?.reference || !config.authority?.instruction ||
      !project || !validBranchName(project.target) ||
      config.authority.target !== project.target || !config.authority.tasks ||
      config.maxAccepted !== undefined && (!Number.isSafeInteger(config.maxAccepted) || config.maxAccepted < 1)) {
    throw new Error('Invalid OFF configuration or authority');
  }
  if (project.commitScope !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(project.commitScope) ||
      project.commitSuffix !== undefined && (typeof project.commitSuffix !== 'string' || /[\r\n]/u.test(project.commitSuffix))) {
    throw new Error('Invalid project commit metadata');
  }
  [project.queue, project.changes, project.receipts].forEach(safePath);
  if (!Array.isArray(project.checks) || !project.planningCheck) {
    throw new Error('Planning and result checks are mandatory');
  }
  for (const check of [...project.checks, project.planningCheck, ...(project.setup ?? []), archiveCommand(project)]) {
    if (!check || typeof check.command !== 'string' || !check.command ||
        !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) {
      throw new Error('Commands must be fixed executable and argument arrays');
    }
  }
  if (!project.checks.some(check => check.args.some(arg => arg.includes('{coverage}')))) {
    throw new Error('A coverage gate check is required');
  }
  return config;
}
