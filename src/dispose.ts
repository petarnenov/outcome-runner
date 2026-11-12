import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaimLedger } from './claims.ts';
import type { LedgerSnapshot } from './claims.ts';
import { fileAt, git, hasRef, receiptAt, GitHubHost } from './git.ts';
import { primaryOf, withGitLock } from './git-lock.ts';
import { hash, validateQueue, within } from './model.ts';
import type { PullRequest, RunConfig, Work } from './model.ts';
import { writeStateFile } from './run-store.ts';
import type { RunState } from './run-store.ts';
import { invocationLockFiles } from './runner.ts';
import type { PullRequestHost } from './runner.ts';
import { runnerVersion } from './runner-version.ts';

export interface DisposeOptions {
  /** Removes the worktrees and the local and remote branches of the unaccepted tasks; by default they are kept. */
  removeWork?: boolean;
  /** The pull request host; the default is the GitHub host of the project. Only `find` is ever called. */
  host?: PullRequestHost;
  now?: () => number;
}

/** `kept` and `absent` describe inspected work; `removed` and `failed` the steps of `--remove-work`. */
export type WorkState = 'kept' | 'removed' | 'absent' | 'failed';

export interface DisposedWork {
  id: string;
  /** Omitted when the worktree path is unknown (a claim without a state entry). */
  worktree?: { path: string; state: WorkState };
  localBranch: { name: string; state: WorkState };
  remoteBranch: { name: string; state: WorkState };
}

export interface OpenPullRequest { id: string; number: number; url?: string; branch: string; state: 'OPEN' | 'unknown' }

export interface DisposeSummary {
  status: 'disposed' | 'nothing-to-release';
  invocation: string;
  releasedClaims: string[];
  ownership: 'released' | 'already-released' | 'absent';
  work: DisposedWork[];
  openPullRequests: OpenPullRequest[];
}

/** Unaccepted work of the invocation: a state entry, or only the branch of a released claim. */
type UnacceptedWork = Pick<Work, 'id' | 'branch'> & { path?: string; pr?: PullRequest };

const CLAIM_RELEASE_RETRIES = 5;

const refusal = (reason: string, message: string): Error => Object.assign(new Error(message), { reason });
const byId = <T extends { id: string }>(first: T, second: T): number => first.id.localeCompare(second.id);

/**
 * The state of the invocation, read without creating any file or directory. It must be a regular version 2
 * `state.json` of the same invocation name, repository root and target; otherwise `unknown-invocation`.
 */
function matchState(config: RunConfig, root: string): RunState {
  const file = join(resolve(config.stateDirectory), 'state.json');
  let state: RunState | undefined;
  try {
    if (!lstatSync(file).isSymbolicLink()) {
      const candidate = JSON.parse(readFileSync(file, 'utf8')) as RunState;
      const identity = candidate?.identity as { invocation?: unknown; root?: unknown; project?: { target?: unknown } };
      if (candidate?.version === 2 && identity?.invocation === config.invocation &&
          typeof identity.root === 'string' && realpathSync(identity.root) === root &&
          identity.project?.target === config.project.target) state = candidate;
    }
  } catch { state = undefined; }
  if (!state) {
    throw refusal('unknown-invocation',
      `No state of invocation ${JSON.stringify(config.invocation)} exists for this repository and target`);
  }
  return state;
}

/** Holds the SQLite file lock a running process of the invocation holds; only a held lock is `invocation-running`. */
function lockExclusive(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try { database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch (error) {
    database.close();
    if (/locked|busy/iu.test((error as Error).message)) {
      throw refusal('invocation-running', `A process of this invocation is running (${(error as Error).message})`);
    }
    throw error;
  }
  return database;
}

/** Runs one inspection or removal step; a throwing step is `failed`. */
const attempt = (fn: () => WorkState): WorkState => {
  try { return fn(); } catch { return 'failed'; }
};

/**
 * Disposes of an invocation the owner no longer wants: releases its claims of unaccepted tasks in one ledger
 * commit, records the disposed work in `state.json` with `status: 'released'`, frees its ownership file and lists
 * (or, with `removeWork`, removes) the worktrees and branches of its unaccepted tasks and lists its open pull
 * requests. Accepted tasks and other invocations are never touched. Refuses with `unknown-invocation` before any
 * file is created and with `invocation-running` while a process of the invocation holds its locks. The written
 * `state.json` and ownership file carry the `runnerVersion` of this runner.
 */
export async function disposeInvocation(config: RunConfig, options: DisposeOptions = {}): Promise<DisposeSummary> {
  const { removeWork = false, host, now = Date.now } = options;
  const root = realpathSync(config.root);
  const project = config.project;
  matchState(config, root);
  const primary = primaryOf(root);
  const stateDirectory = resolve(config.stateDirectory);
  const files = invocationLockFiles(primary, stateDirectory);
  const locks: DatabaseSync[] = [];
  try {
    locks.push(lockExclusive(files.lock));
    locks.push(lockExclusive(join(stateDirectory, 'lock.sqlite')));
    // A run may have finished or rewritten the state between the first match and the locks.
    const state = matchState(config, root);
    const lockGit = <T>(fn: () => T): T => withGitLock(primary, fn);
    const target = lockGit(() => {
      git(root, 'fetch', 'origin', project.target);
      return git(root, 'rev-parse', `origin/${project.target}`);
    });
    const queue = validateQueue(JSON.parse(fileAt(root, target, project.queue).toString()), project);
    const accepted = new Map<string, boolean>();
    const isDone = (id: string): boolean => {
      if (!accepted.has(id)) {
        const task = queue.tasks.find(item => item.id === id);
        accepted.set(id, !!task && !!receiptAt(root, target, `${project.receipts}/${id}.json`, hash(task), null));
      }
      return accepted.get(id)!;
    };
    const ledger = new ClaimLedger(root, project.target, lockGit);
    const owned = (snapshot: LedgerSnapshot): string[] => state.claimant ? [...snapshot.claims.values()]
      .filter(claim => claim.claimant === state.claimant && !isDone(claim.id)).map(claim => claim.id).sort() : [];
    let snapshot = ledger.pull();
    const claims = owned(snapshot);

    // The unaccepted work: earlier disposed work again, then the current and blocked entries, then claim branches.
    const work = new Map<string, UnacceptedWork>();
    for (const entry of Object.values(state.disposed?.tasks ?? {})) if (!isDone(entry.id)) work.set(entry.id, entry);
    const disposing: Record<string, Work> = {};
    for (const entry of [state.current, ...Object.values(state.blocked ?? {}).map(item => item?.work)]) {
      if (entry && !isDone(entry.id)) { disposing[entry.id] = entry; work.set(entry.id, entry); }
    }
    for (const id of claims) {
      const branch = snapshot.claims.get(id)!.branch;
      if (!work.has(id) && branch) work.set(id, { id, branch });
    }

    // The state is written first, so an interrupted dispose leaves a state the runner refuses and a repeat finishes.
    const something = claims.length > 0 || Object.keys(disposing).some(id => !state.disposed?.tasks?.[id]);
    let stateWritten = false;
    if (something || state.status !== 'released') {
      const kept = Object.fromEntries(Object.entries(state.blocked ?? {}).filter(([id]) => !disposing[id]));
      writeStateFile(stateDirectory, { ...state, status: 'released',
        ...(state.blocked ? { blocked: kept } : {}),
        ...(state.current && disposing[state.current.id] ? { current: null } : {}),
        disposed: { at: new Date(now()).toISOString(), tasks: { ...state.disposed?.tasks, ...disposing } },
        runnerVersion: runnerVersion(), sequence: (state.sequence ?? 0) + 1 });
      stateWritten = true;
    }

    let releasedClaims: string[] = [];
    const message = `chore(${project.commitScope ?? 'work-queue'}): release claims of invocation ` +
      `${config.invocation}${project.commitSuffix ?? ''}`;
    for (let tries = 0; ; tries += 1) {
      const ids = owned(snapshot);
      if (!ids.length) break;
      if (ledger.release(snapshot, ids, message)) { releasedClaims = ids; break; }
      if (tries >= CLAIM_RELEASE_RETRIES) throw new Error('The claims ledger kept moving; the claims were not released');
      snapshot = ledger.pull();
    }

    const listed = [...work.values()].sort(byId);
    // Open pull requests are listed before any branch is removed; the host is only asked, never merged into.
    const openPullRequests: OpenPullRequest[] = [];
    let pullRequests: PullRequestHost | undefined;
    for (const entry of listed) {
      try {
        pullRequests ??= host ?? new GitHubHost(root, project);
        const pr = await pullRequests.find(entry.branch);
        if (pr?.state === 'OPEN') {
          openPullRequests.push({ id: entry.id, number: pr.number, ...(pr.url ? { url: pr.url } : {}),
            branch: pr.branch ?? entry.branch, state: 'OPEN' });
        }
      } catch {
        if (entry.pr) {
          openPullRequests.push({ id: entry.id, number: entry.pr.number, ...(entry.pr.url ? { url: entry.pr.url } : {}),
            branch: entry.pr.branch ?? entry.branch, state: 'unknown' });
        }
      }
    }

    // Without removeWork every step only inspects; with it each step removes independently under the Git lock.
    const outcomes = join(dirname(primary), `${basename(primary)}-outcomes`);
    const disposedWork = listed.map((entry): DisposedWork => {
      const { path, branch } = entry;
      const worktree = (): WorkState => {
        if (!path || !existsSync(path)) return 'absent';
        if (!removeWork || !within(resolve(path), outcomes)) return 'kept';
        git(root, 'worktree', 'remove', '--force', path); git(root, 'worktree', 'prune');
        return 'removed';
      };
      const localBranch = (): WorkState => {
        if (!hasRef(root, `refs/heads/${branch}`)) return 'absent';
        if (!removeWork) return 'kept';
        git(root, 'branch', '-D', branch); return 'removed';
      };
      const remoteBranch = (): WorkState => {
        if (!git(root, 'ls-remote', 'origin', `refs/heads/${branch}`)) return 'absent';
        if (!removeWork) return 'kept';
        git(root, 'push', 'origin', '--delete', branch); return 'removed';
      };
      const build = (run: (step: () => WorkState) => WorkState): DisposedWork => ({ id: entry.id,
        ...(path ? { worktree: { path, state: run(worktree) } } : {}),
        localBranch: { name: branch, state: run(localBranch) }, remoteBranch: { name: branch, state: run(remoteBranch) } });
      try { return removeWork ? lockGit(() => build(attempt)) : build(attempt); }
      catch { return build(() => 'failed'); }
    });

    let ownership: DisposeSummary['ownership'] = 'absent';
    if (existsSync(files.ownership)) {
      const previous = JSON.parse(readFileSync(files.ownership, 'utf8'));
      // Only this invocation's ownership file is ever written; a file without `runnerVersion` is read the same way.
      if (previous?.stateDirectory === stateDirectory) {
        if (previous.released) ownership = 'already-released';
        else {
          writeFileSync(files.ownership, JSON.stringify({ ...previous, released: true, runnerVersion: runnerVersion() }),
            { mode: 0o600 });
          ownership = 'released';
        }
      }
    }

    const status = releasedClaims.length || ownership === 'released' || stateWritten ? 'disposed' : 'nothing-to-release';
    return { status, invocation: config.invocation, releasedClaims, ownership, work: disposedWork, openPullRequests };
  } finally {
    for (const lock of locks.reverse()) {
      try { lock.close(); } catch { /* Closing a lock never changes the result. */ }
    }
  }
}
