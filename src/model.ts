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
}

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
}

export interface ResolvedRunConfig extends RunConfig {
  harness: Harness;
  model: string;
  effort: string;
  coverage: number;
}

export type Stage = 'claim' | 'investigate' | 'plan' | 'work' | 'receipt' | 'publish' | 'pr' | 'merge';
export type Purpose = 'investigate' | 'plan' | 'work' | 'review';

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
  session?: SessionHandle & { purpose: Purpose };
  sessions?: WorkerSession[];
  lastToolError?: { purpose: Purpose; input: unknown; message: string };
  lastReportAttempt?: { purpose: Purpose; input: unknown };
  head?: string;
  testedTarget?: string;
  pr?: PullRequest;
  acceptedTarget?: string;
  claimedAt?: string;
  acceptedAt?: string;
  completion?: TaskCompletion;
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
export const within = (path: string, scope: string): boolean => path === scope || path.startsWith(`${scope}/`);
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

export function validateConfig<T extends RunConfig>(config: T): T {
  resolveCoverage(config.coverage);
  const project = config.project;
  if ((config.mode ?? 'OFF') !== 'OFF' || !config.root || !config.stateDirectory ||
      !config.invocation || !config.authority?.reference || !config.authority?.instruction ||
      !project || !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/u.test(project.target ?? '') ||
      project.target.includes('..') || project.target.endsWith('/') ||
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
  for (const check of [...project.checks, project.planningCheck, ...(project.setup ?? [])]) {
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
