import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Grade, Purpose, RunConfig, Task, Work } from './model.ts';
import { runnerVersion } from './runner-version.ts';

export type Source = 'cli-flag' | 'invocation-json' | 'interactive-answer' | 'default';
export type Setting = 'harness' | 'harnessCliVersion' | 'model' | 'effort' | 'coverage' | 'maxAccepted' | 'leaves';
export type Sources = Partial<Record<Setting, Source>>;
export interface Pair<T> { value: T | null; source: Source | null }
export interface Settings {
  harness: Pair<string>; harnessCliVersion: Pair<string>; model: Pair<string>; effort: Pair<string>;
  coverage: Pair<number>; maxAccepted: Pair<number>; leaves: Pair<string[]>;
}
export interface TokenUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export type TaskOutcome = 'accepted' | 'blocked' | 'claimed-elsewhere' | 'not-started';
export interface TaskStatistics {
  id: string; change: string; outcome: TaskOutcome; lastStage: Work['stage'] | null;
  blockingReason: string | null; durationSeconds: number | null; complexityGrade: Grade | null;
  completionSummary: string | null; workerSessions: Record<Purpose, number>;
  planningReviewRounds: number; implementationReviewRounds: number;
  planningFindingsPerRound: number[]; implementationFindingsPerRound: number[];
  finalChecks: { command: string; args: string[]; outcome: string }[];
  pr: { number: number; url: string } | null; tokenUsage: TokenUsage | null;
}
export type Status = 'exhausted' | 'limit-reached' | 'incomplete' | 'cancelled' | 'unavailable';
export interface RunStatistics {
  schemaVersion: 1; runId: string; runnerVersion: string; hostname: string;
  repositoryTopLevel: string | null; originUrl: string | null; targetBranch: string | null;
  invocation: string | null; authorityReference: string | null; startedAt: string; endedAt: string;
  durationSeconds: number; exitCode: number; status: Status; failureReason: string | null;
  settings: Settings; tasks: TaskStatistics[]; tokenUsage: TokenUsage | null;
}

export const SAFE_FAILURE_REASONS: readonly string[] = ['openspec-missing', 'openspec-not-initialized', 'openspec-layout-created',
  'harness-unavailable', 'missing-setting'];

export const safeFailure = (reason: unknown): string =>
  SAFE_FAILURE_REASONS.includes(typeof reason === 'string' ? reason : '') ? reason as string : 'startup-or-run-failed';

export function cleanOrigin(origin: string): string | null {
  try {
    const url = new URL(origin); url.username = ''; url.password = '';
    // Query and fragment may carry credentials too.
    url.search = ''; url.hash = ''; return url.toString();
  } catch {
    return /^[^\s@]+@[^\s:]+:[^\s]+$/u.test(origin) ? origin.replace(/^[^@]+@/u, '') :
      origin.includes('@') ? null : origin;
  }
}

export const ledgerPath = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  join(env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state'),
    'outcome-runner', 'runs.jsonl');

export const ledgerEffects = {
  mkdir: (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  open: (path: string) => openSync(path, 'a', 0o600),
  secure: (fd: number) => fchmodSync(fd, 0o600),
  serialize: (record: RunStatistics) => Buffer.from(JSON.stringify(record) + '\n'),
  append: (fd: number, bytes: Buffer) => writeSync(fd, bytes),
  close: (fd: number) => closeSync(fd),
};
export type LedgerEffects = typeof ledgerEffects;
export function appendStatistics(record: RunStatistics, { env = process.env, home = homedir(),
  stderr = (line: string) => { process.stderr.write(line); }, effects = ledgerEffects }:
  { env?: NodeJS.ProcessEnv; home?: string; stderr?: (line: string) => void; effects?: LedgerEffects } = {}): void {
  const warn = (message: string) => { try { stderr(message); } catch { /* Diagnostics cannot alter the result. */ } };
  let fd: number | undefined;
  try {
    const bytes = effects.serialize(record); const path = ledgerPath(env, home);
    effects.mkdir(dirname(path)); fd = effects.open(path); effects.secure(fd);
    if (effects.append(fd, bytes) !== bytes.length) throw new Error('short write');
  } catch { warn('outcome-runner: could not persist run statistics ledger.\n'); }
  finally {
    if (fd !== undefined) {
      try { effects.close(fd); } catch { warn('outcome-runner: could not close run statistics ledger.\n'); }
    }
  }
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Only documented token counters cross this boundary. Cumulative updates replace prior totals. */
export function tokenUsage(value: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }): TokenUsage | null {
  const result = { inputTokens: count(value.inputTokens), outputTokens: count(value.outputTokens),
    totalTokens: count(value.totalTokens) };
  return Object.values(result).every(value => value === null) ? null : result;
}
export function sumUsage(rows: (TokenUsage | null)[]): TokenUsage | null {
  if (!rows.some(Boolean)) return null;
  const sum = (key: keyof TokenUsage) => rows.every(row => row?.[key] != null) ?
    count(rows.reduce((total, row) => total + row![key]!, 0)) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens') };
}

export class Statistics {
  readonly record: RunStatistics;
  sources: Sources = {};
  private tasks = new Map<string, TaskStatistics>();
  private sessions: { id: string; usage: TokenUsage | null }[] = [];
  private start: number;
  private finished = false;
  private clocks: { utc: () => string; elapsed: () => number; uuid: () => string; version: () => string; host: () => string };
  constructor(clocks: Statistics['clocks'] = { utc: () => new Date().toISOString(), elapsed: () => performance.now(),
    uuid: randomUUID, version: runnerVersion, host: hostname }) {
    this.clocks = clocks;
    this.start = clocks.elapsed();
    const pair = () => ({ value: null, source: null });
    this.record = { schemaVersion: 1, runId: clocks.uuid(), runnerVersion: clocks.version(), hostname: clocks.host(),
      repositoryTopLevel: null, originUrl: null, targetBranch: null, invocation: null, authorityReference: null,
      startedAt: clocks.utc(), endedAt: '', durationSeconds: 0, exitCode: 4, status: 'unavailable',
      failureReason: 'startup-or-run-failed', settings: { harness: pair(), harnessCliVersion: pair(), model: pair(),
        effort: pair(), coverage: pair(), maxAccepted: pair(), leaves: pair() }, tasks: [], tokenUsage: null };
  }
  metadata(config: RunConfig, root: string, origin: string | null): void {
    if (this.finished) return;
    this.record.repositoryTopLevel = root; this.record.originUrl = origin === null ? null : cleanOrigin(origin);
    this.record.targetBranch = typeof config.project?.target === 'string' ? config.project.target : null;
    this.record.invocation = typeof config.invocation === 'string' ? config.invocation : null;
    this.record.authorityReference = typeof config.authority?.reference === 'string' ? config.authority.reference : null;
  }
  setting<K extends Setting>(key: K, value: Settings[K]['value'], source: Source): void {
    if (this.finished) return;
    if (!['cli-flag', 'invocation-json', 'interactive-answer', 'default'].includes(source)) source = 'default';
    (this.record.settings[key] as Pair<typeof value>) = { value, source }; this.sources[key] = source;
  }
  resolved(config: RunConfig, sources: Sources, version?: string): void {
    for (const key of ['harness', 'model', 'effort', 'coverage', 'maxAccepted'] as const) {
      this.setting(key, config[key] ?? null, sources[key] ?? this.sources[key] ?? 'default');
    }
    if (version !== undefined) this.setting('harnessCliVersion', version, sources.harness ?? this.sources.harness ?? 'default');
  }
  decision(task: Pick<Task, 'id' | 'change'>, outcome: TaskOutcome = 'not-started', work?: Work,
    reason = 'operation-incomplete'): void {
    if (this.finished) return;
    const previous = this.tasks.get(task.id);
    if (previous?.outcome === 'accepted' && outcome !== 'accepted') return;
    if (previous && outcome === 'not-started' && !work &&
        ['blocked', 'claimed-elsewhere'].includes(previous.outcome)) return;
    const accepted = outcome === 'accepted' ? work?.completion : undefined;
    const planning = work?.planningReviews?.map(review => review.findings.length) ?? [];
    const implementation = work?.reviews?.map(review => review.findings.length) ?? [];
    const purposes = ['investigate', 'plan', 'work', 'review'] as const;
    const workerSessions = Object.fromEntries(purposes.map(purpose => [purpose,
      work?.sessionStarts?.[purpose] ?? work?.sessions?.filter(session => session.purpose === purpose).length ?? 0])) as Record<Purpose, number>;
    this.tasks.set(task.id, { id: task.id, change: task.change, outcome, lastStage: work?.stage ?? previous?.lastStage ?? null,
      blockingReason: outcome === 'blocked' ? (reason === 'cancelled' ? 'cancelled' : 'operation-incomplete') : null,
      durationSeconds: accepted?.durationSeconds ?? null, complexityGrade: accepted?.grade ?? null,
      completionSummary: accepted?.summary ?? null, workerSessions, planningReviewRounds: planning.length,
      implementationReviewRounds: implementation.length, planningFindingsPerRound: planning,
      implementationFindingsPerRound: implementation, finalChecks: (work?.finalChecks ?? []).map(check =>
        ({ command: check.command, args: [...check.args], outcome: check.outcome })),
      pr: work?.pr?.url ? { number: work.pr.number, url: work.pr.url } : null, tokenUsage: null });
  }
  session(id: string): (usage: TokenUsage | null) => void {
    const row = { id, usage: null as TokenUsage | null }; this.sessions.push(row);
    return usage => { if (usage) row.usage = tokenUsage(usage); };
  }
  finish(status: Status, exitCode: number, reason?: unknown): RunStatistics {
    if (this.finished) return this.record;
    this.finished = true;
    Object.assign(this.record, { status, exitCode, failureReason: status === 'unavailable' ? safeFailure(reason) : null,
      endedAt: this.clocks.utc(), durationSeconds: Math.max(0, (this.clocks.elapsed() - this.start) / 1000) });
    this.record.tasks = [...this.tasks.values()].map(task => ({ ...task,
      blockingReason: task.outcome === 'blocked' && status === 'cancelled' ? 'cancelled' : task.blockingReason,
      tokenUsage: sumUsage(this.sessions.filter(session => session.id === task.id).map(session => session.usage)) }));
    this.record.tokenUsage = sumUsage(this.sessions.map(session => session.usage));
    return this.record;
  }
}

/** Race pending startup/session activity with cancellation and always remove the observer. */
export async function cancellable<T>(activity: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return activity;
  if (signal.aborted) { activity.catch(() => {}); throw signal.reason; }
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([activity, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
