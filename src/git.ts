import { execFileSync, spawn } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, safePath } from './model.ts';
import { withNetworkRetry } from './network-retry.ts';
import { readPage } from './text-page.ts';
import type { TextPage } from './text-page.ts';
import type { CheckRecord, Project, PullRequest, RetryRecord, ReviewRecord, Work } from './model.ts';
import type { InvocationChange } from './run-store.ts';

export interface Receipt {
  version: number;
  id: string;
  taskHash: string;
  authority: string;
  /** The resolved target branch of the run; receipts written before it was recorded omit it. */
  target?: string;
  specification: Record<string, string>;
  review: Pick<ReviewRecord, 'reviewer' | 'outcome' | 'accepted'>;
  checks: CheckRecord[];
  /** Each changed path with its content hash; a deleted path has hash null. */
  manifest: { path: string; hash: string | null }[];
  head: string;
  base: string;
  /** The changes recorded for the invocation when the receipt was written; omitted when there were none. */
  invocationChanges?: InvocationChange[];
  /** The owner retries of the task (`--retry <task id>`); omitted when the task was never retried. */
  retries?: RetryRecord[];
}

/**
 * Runner Git commands turn automatic garbage collection off, so an automatic `gc` or `pack-refs` started by one
 * runner cannot take ref lock files while another runner of the same clone works.
 */
export const GIT_OPTIONS: readonly string[] = ['-c', 'gc.auto=0'];
const GIT_PREFIX = `git ${GIT_OPTIONS.join(' ')} `;

/**
 * The environment of every runner command: the process environment without the Node test runner variables, with
 * `CI=true`, `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`.
 */
export const commandEnvironment = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID'].includes(key))), CI: 'true',
  GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
const runOptions = (): ExecFileSyncOptionsWithStringEncoding => ({ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  env: commandEnvironment() });
/** Runs one program; a connection that cannot be made is waited out (see network-retry.ts). */
export const command = (cwd: string, program: string, args: string[]): string => withNetworkRetry(
  () => execFileSync(program, args, { ...runOptions(), cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  () => describeCommand(program, args));
/** The program and its first two arguments, without the runner's Git options, for the retry step line. */
export const describeCommand = (program: string, args: string[]): string => {
  const own = program === 'git' && GIT_OPTIONS.every((option, index) => args[index] === option) ? args.slice(GIT_OPTIONS.length) : args;
  return [program, ...own.slice(0, 2)].join(' ');
};
/** Runs one Git command with the runner options; failure messages name the command without them. */
function runGit<T>(run: (args: string[]) => T, args: string[]): T {
  try { return run([...GIT_OPTIONS, ...args]); }
  catch (error) {
    if (error instanceof Error) error.message = error.message.replace(GIT_PREFIX, 'git ');
    throw error;
  }
}
export async function gitPage(cwd: string, offset: number, ...args: string[]): Promise<TextPage> {
  const child = spawn('git', [...GIT_OPTIONS, ...args], { cwd, env: runOptions().env, stdio: ['ignore', 'pipe', 'ignore'] });
  const [page, [code]] = await Promise.all([
    readPage(child.stdout, offset).then(result => {
      if (result.nextOffset !== null) child.kill();
      return result;
    }),
    once(child, 'close'),
  ]);
  if (page.nextOffset === null && code !== 0) throw new Error(`git ${args[0]} failed`);
  return page;
}
export const gitWithInput = (cwd: string, input: string, ...args: string[]): string => runGit(full =>
  execFileSync('git', full, { ...runOptions(), cwd, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), args);
export const git = (cwd: string, ...args: string[]): string => runGit(full => command(cwd, 'git', full), args);
/**
 * Pushes runner bookkeeping (claims ledger commits and task branch deletions) without client-side hooks. These
 * pushes carry no product code, are pushed from the start checkout while it has another commit checked out, and a
 * project's pre-push verification can only check the checked-out commit. Tested task heads are pushed with hooks.
 */
export const pushBookkeeping = (cwd: string, ...args: string[]): string => git(cwd, 'push', '--no-verify', ...args);
/** Whether `ref` (for example `refs/heads/<branch>`) exists in the repository of `root`. */
export function hasRef(root: string, ref: string): boolean {
  try { git(root, 'show-ref', '--verify', '--quiet', ref); return true; } catch { return false; }
}
export function fileAt(root: string, revision: string, path: string): Buffer {
  return runGit(full => execFileSync('git', full, {
    cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }), ['show', `${revision}:${path}`]);
}
/** The content hash of a path at a revision, or null when the path does not exist there. */
function hashAt(root: string, revision: string, path: string): string | null {
  const present = git(root, 'ls-tree', '--name-only', revision, '--', path).split('\n').includes(path);
  return present ? digest(fileAt(root, revision, path)) : null;
}
export function receiptAt(root: string, revision: string, path: string, taskHash: string, authority: string | null): Receipt | null {
  const files = git(root, 'ls-tree', '-r', '--name-only', revision, '--', path).split('\n');
  if (!files.includes(path)) return null;
  const bytes = fileAt(root, revision, path);
  const first = git(root, 'log', '--first-parent', '--diff-filter=A', '--reverse', '--format=%H',
    revision, '--', path).split('\n')[0];
  if (!first || digest(fileAt(root, first, path)) !== digest(bytes)) throw new Error('Receipt provenance changed');
  const receipt: Receipt = JSON.parse(bytes.toString());
  if (receipt.version !== 1 || receipt.taskHash !== taskHash ||
      !receipt.authority || authority && receipt.authority !== authority || !receipt.review?.accepted ||
      Object.hasOwn(receipt, 'target') && (typeof receipt.target !== 'string' || !receipt.target) ||
      !receipt.checks?.length || receipt.checks.some(check => check.outcome !== 'passed') ||
      !receipt.specification || !Object.keys(receipt.specification).length || !receipt.manifest?.length) {
    throw new Error('Invalid accepted outcome receipt');
  }
  const paths = new Set<string>();
  for (const entry of receipt.manifest) {
    safePath(entry.path);
    if (paths.has(entry.path)) throw new Error('Duplicate receipt path');
    paths.add(entry.path);
    if (hashAt(root, first, entry.path) !== entry.hash) throw new Error('Accepted result differs from receipt');
  }
  for (const [path, expected] of Object.entries(receipt.specification)) {
    safePath(path);
    if (!paths.has(path) || digest(fileAt(root, first, path)) !== expected) {
      throw new Error('Accepted specification differs from exact binding');
    }
  }
  return receipt;
}
interface MergeView { headRefName?: string; headRefOid: string; baseRefName: string; mergeStateStatus: string; state: string; isDraft: boolean }

/** The bucket `gh pr checks --json bucket` reports for one check. */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
/** One required check of a pull request and its bucket. */
export interface RequiredCheck { name: string; bucket: CheckBucket }
/** The settled `mergeStateStatus` of an open pull request and its required checks (none for `CLEAN`). */
export interface MergeEligibility { status: string; checks: RequiredCheck[] }

/**
 * A merge refused only because the settled status is not `CLEAN`; it carries the status and the required checks.
 * The message is `PR protection or identity blocks merge (<status>)`.
 */
export class MergeIneligible extends Error {
  status: string;
  checks: RequiredCheck[];
  constructor(status: string, checks: RequiredCheck[] = []) {
    super(`PR protection or identity blocks merge (${status})`);
    this.name = 'MergeIneligible';
    this.status = status;
    this.checks = checks.map(check => ({ ...check }));
  }
}

/** Parses the JSON of `gh pr checks --json name,bucket`; anything but an array of named checks throws. */
function parseChecks(text: string): RequiredCheck[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('Unexpected required checks output');
  return rows.map(row => {
    const { name, bucket } = (row ?? {}) as Partial<RequiredCheck>;
    if (typeof name !== 'string' || typeof bucket !== 'string') throw new Error('Unexpected required checks output');
    return { name, bucket };
  });
}

// GitHub has taken more than a minute; at the default poll this waits 5 minutes.
export const MERGE_STATE_VIEWS = 100;
export const MERGE_STATE_POLL_MS = 3000;
export interface MergePolling {
  views?: number;
  pollMs?: number;
  /** The delay between two views while required checks are pending; default `MERGE_ELIGIBILITY_POLL_MS`. */
  eligibilityPollMs?: number;
  delay?: (ms: number) => Promise<unknown>;
}
export function assertOriginHead(root: string, branch: string, head: string): void {
  const ref = `refs/heads/${branch}`;
  const rows = git(root, 'ls-remote', 'origin', ref).split('\n');
  if (!rows.some(row => {
    const [oid, name] = row.split(/\s+/u);
    return name === ref && oid === head;
  })) throw new Error('Checked head or target changed');
}

export class GitHubHost {
  root: string;
  project: Project;
  mergeStatePollMs: number;
  readonly polling: MergePolling;

  constructor(root: string, project: Project, mergeStatePollMs = MERGE_STATE_POLL_MS, polling: MergePolling = {}) {
    if (!project.repository) throw new Error('Explicit PR repository is required');
    this.root = root; this.project = project; this.mergeStatePollMs = mergeStatePollMs;
    this.polling = polling;
  }
  gh(...args: string[]): string { return command(this.root, 'gh', [...args, '--repo', this.project.repository!]); }
  find(branch: string): PullRequest | null {
    const rows: PullRequest[] = JSON.parse(this.gh('pr', 'list', '--state', 'all', '--head', branch,
      '--base', this.project.target, '--json', 'number,url,state,headRefOid,baseRefName,headRefName'));
    if (rows.length > 1) throw new Error('Multiple PRs match the outcome branch');
    const row = rows[0] as (PullRequest & { headRefName?: string }) | undefined;
    return row ? { ...row, branch: row.headRefName ?? branch } : null;
  }
  create(work: Work, body: string): PullRequest | null {
    this.gh('pr', 'create', '--base', this.project.target, '--head', work.branch,
      '--title', `feat(${this.project.commitScope ?? 'work-queue'}): complete ${work.id}${this.project.commitSuffix ?? ''}`, '--body-file', body);
    return this.find(work.branch);
  }
  /**
   * The required checks of `pr` with their buckets. `gh pr checks` exits nonzero while checks are pending or after
   * one failed, still printing the JSON, so the stdout of such a failure is parsed. Empty output gives no checks;
   * any other unparsable output rethrows the command failure.
   */
  requiredChecks(pr: PullRequest): RequiredCheck[] {
    let output: string;
    try { output = this.gh('pr', 'checks', String(pr.number), '--required', '--json', 'name,bucket'); }
    catch (error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
      if (!stdout) return [];
      try { return parseChecks(stdout); } catch { throw error; }
    }
    return output.trim() ? parseChecks(output) : [];
  }
  /** Throws the identity refusal when the settled view is not the open, non-draft pull request of `head`. */
  private assertIdentity(row: MergeView, head: string): void {
    if (row.state !== 'OPEN' || row.headRefOid !== head || row.baseRefName !== this.project.target || row.isDraft) {
      throw new Error(`PR protection or identity blocks merge (${row.mergeStateStatus})`);
    }
  }
  /**
   * The merge eligibility of the settled view of `head`: `CLEAN` without reading checks, any other status with the
   * required checks. A view that is not the open, non-draft pull request of `head` throws.
   */
  async eligibility(pr: PullRequest, head: string): Promise<MergeEligibility> {
    const row = await this.settledMergeView(pr, head);
    this.assertIdentity(row, head);
    if (row.mergeStateStatus === 'CLEAN') return { status: 'CLEAN', checks: [] };
    return { status: row.mergeStateStatus, checks: this.requiredChecks(pr) };
  }
  /**
   * Merges the exact checked `head` once the pull request view has settled and is eligible. The optional `guard`
   * runs after the settled view and immediately before `gh pr merge`; a throwing guard issues no merge command.
   * A view whose only problem is a status other than `CLEAN` throws `MergeIneligible` with the required checks.
   */
  async merge(pr: PullRequest, head: string, guard?: () => void | Promise<void>): Promise<void> {
    const row = await this.settledMergeView(pr, head);
    this.assertIdentity(row, head);
    if (row.mergeStateStatus !== 'CLEAN') throw new MergeIneligible(row.mergeStateStatus, this.requiredChecks(pr));
    await guard?.();
    this.gh('pr', 'merge', String(pr.number), '--merge', '--match-head-commit', head);
  }
  mergeView(pr: PullRequest): MergeView {
    return JSON.parse(this.gh('pr', 'view', String(pr.number), '--json',
      'headRefOid,headRefName,baseRefName,mergeStateStatus,state,isDraft'));
  }
  // GitHub computes mergeability in the background after a PR is created.
  async settledMergeView(pr: PullRequest, head?: string): Promise<MergeView> {
    const limit = this.polling.views ?? MERGE_STATE_VIEWS;
    for (let view = 1; ; view += 1) {
      const row = this.mergeView(pr);
      if (row.state !== 'OPEN') return row;
      const stale = head !== undefined && row.headRefOid !== head;
      if (stale) {
        const branch = pr.branch ?? row.headRefName;
        if (!branch) throw new Error('Checked head or target changed');
        assertOriginHead(this.root, branch, head);
        if (view >= limit) throw new Error('Checked head or target changed');
      }
      if ((!stale && row.mergeStateStatus !== 'UNKNOWN') || view >= limit) return row;
      await (this.polling.delay ?? delay)(this.polling.pollMs ?? this.mergeStatePollMs);
    }
  }
}
