import { execFileSync, spawn } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, safePath } from './model.ts';
import { readPage } from './text-page.ts';
import type { TextPage } from './text-page.ts';
import type { CheckRecord, Project, PullRequest, ReviewRecord, Work } from './model.ts';

export interface Receipt {
  version: number;
  id: string;
  taskHash: string;
  authority: string;
  specification: Record<string, string>;
  review: Pick<ReviewRecord, 'reviewer' | 'outcome' | 'accepted'>;
  checks: CheckRecord[];
  manifest: { path: string; hash: string }[];
  head: string;
  base: string;
}

const runOptions = (): ExecFileSyncOptionsWithStringEncoding => ({ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID'].includes(key))), CI: 'true', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
export const command = (cwd: string, program: string, args: string[]): string => execFileSync(program, args, {
  ...runOptions(), cwd, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
export async function gitPage(cwd: string, offset: number, ...args: string[]): Promise<TextPage> {
  const child = spawn('git', args, { cwd, env: runOptions().env, stdio: ['ignore', 'pipe', 'ignore'] });
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
export const gitWithInput = (cwd: string, input: string, ...args: string[]): string => execFileSync('git', args, {
  ...runOptions(), cwd, input, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
export const git = (cwd: string, ...args: string[]): string => command(cwd, 'git', args);
export function fileAt(root: string, revision: string, path: string): Buffer {
  return execFileSync('git', ['show', `${revision}:${path}`], {
    cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      !receipt.checks?.length || receipt.checks.some(check => check.outcome !== 'passed') ||
      !receipt.specification || !Object.keys(receipt.specification).length || !receipt.manifest?.length) {
    throw new Error('Invalid accepted outcome receipt');
  }
  const paths = new Set<string>();
  for (const entry of receipt.manifest) {
    safePath(entry.path);
    if (paths.has(entry.path)) throw new Error('Duplicate receipt path');
    paths.add(entry.path);
    if (digest(fileAt(root, first, entry.path)) !== entry.hash) throw new Error('Accepted result differs from receipt');
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

// GitHub has taken more than a minute; at the default poll this waits 5 minutes.
export const MERGE_STATE_VIEWS = 100;
export const MERGE_STATE_POLL_MS = 3000;
export interface MergePolling {
  views?: number;
  pollMs?: number;
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
      '--base', this.project.target, '--json', 'number,state,headRefOid,baseRefName,headRefName'));
    if (rows.length > 1) throw new Error('Multiple PRs match the outcome branch');
    const row = rows[0] as (PullRequest & { headRefName?: string }) | undefined;
    return row ? { ...row, branch: row.headRefName ?? branch } : null;
  }
  create(work: Work, body: string): PullRequest | null {
    this.gh('pr', 'create', '--base', this.project.target, '--head', work.branch,
      '--title', `feat(${this.project.commitScope ?? 'work-queue'}): complete ${work.id}${this.project.commitSuffix ?? ''}`, '--body-file', body);
    return this.find(work.branch);
  }
  async merge(pr: PullRequest, head: string): Promise<void> {
    const row = await this.settledMergeView(pr, head);
    if (row.state !== 'OPEN' || row.headRefOid !== head || row.baseRefName !== this.project.target ||
        row.mergeStateStatus !== 'CLEAN' || row.isDraft) {
      throw new Error(`PR protection or identity blocks merge (${row.mergeStateStatus})`);
    }
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
