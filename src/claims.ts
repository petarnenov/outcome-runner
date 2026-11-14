import { isDeepStrictEqual } from 'node:util';
import { fileAt, git, gitWithInput, pushBookkeeping } from './git.ts';
import { DEFAULT_LEASE_SECONDS } from './model.ts';

export interface Claim {
  version: number;
  id: string;
  claimant: string;
  scopes: string[];
  taskHash?: string;
  host?: string;
  branch?: string;
  claimedAt?: string;
  /** ISO time of the last renewal; a new or taken-over claim sets it equal to `claimedAt`. */
  renewedAt?: string;
  /** The lease of the holder in seconds; absent in claims of earlier runners (the default lease applies). */
  leaseSeconds?: number;
  /** Present while the task is blocked in the holder's invocation; a blocked claim never expires. */
  blocked?: { at: string };
}

export interface LedgerSnapshot { head: string | null; claims: Map<string, Claim> }

/** Runs one group of Git operations under a lock; the default runs it directly. */
export type LockWrapper = <T>(fn: () => T) => T;

/** The result of a renewal: renewed, the claim is no longer the caller's, or every compare-and-swap was lost. */
export type RenewResult = 'renewed' | 'lost' | 'deferred';
/** The result of marking a claim blocked. */
export type MarkBlockedResult = 'blocked' | 'lost' | 'deferred';

/** The tries of one renewal or blocked mark before it is deferred. */
export const LEDGER_UPDATE_TRIES = 5;

export const claimsBranch = (target: string): string => `work-queue-claims-${target.replaceAll('/', '-')}`;

function assertClaim(claim: Claim, id: string): Claim {
  if (claim?.version !== 1 || claim.id !== id || typeof claim.claimant !== 'string' ||
      !claim.claimant || !Array.isArray(claim.scopes) ||
      claim.renewedAt !== undefined && typeof claim.renewedAt !== 'string' ||
      claim.leaseSeconds !== undefined && (!Number.isSafeInteger(claim.leaseSeconds) || claim.leaseSeconds <= 0) ||
      claim.blocked !== undefined && (typeof claim.blocked !== 'object' || claim.blocked === null ||
        typeof claim.blocked.at !== 'string')) throw new Error('Invalid repository claim record');
  return claim;
}

/**
 * Whether `claim` is stale at `nowMs`: it is not blocked and its last renewal (`renewedAt`, or `claimedAt` for a
 * legacy claim) is strictly older than its own lease (`leaseSeconds`, or 1800). A claim without a parseable renewal
 * time is never stale.
 */
export function claimStale(claim: Pick<Claim, 'renewedAt' | 'claimedAt' | 'leaseSeconds' | 'blocked'>,
  nowMs: number): boolean {
  if (claim.blocked) return false;
  const renewal = claim.renewedAt ?? claim.claimedAt;
  const time = typeof renewal === 'string' ? Date.parse(renewal) : Number.NaN;
  if (!Number.isFinite(time)) return false;
  return nowMs - time > (claim.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
}

export class ClaimLedger {
  root: string;
  branch: string;
  ref: string;
  tracking: string;
  withLock: LockWrapper;

  constructor(root: string, target: string, withLock: LockWrapper = fn => fn()) {
    this.root = root;
    this.branch = claimsBranch(target);
    this.ref = `refs/heads/${this.branch}`;
    this.tracking = `refs/work-queue/claims/${this.branch}`;
    this.withLock = withLock;
  }

  remoteHead(): string | null {
    return git(this.root, 'ls-remote', 'origin', this.ref).split('\t')[0] || null;
  }

  pull(): LedgerSnapshot {
    return this.withLock(() => {
      if (!this.remoteHead()) return { head: null, claims: new Map<string, Claim>() };
      git(this.root, 'fetch', 'origin', `+${this.ref}:${this.tracking}`);
      const head = git(this.root, 'rev-parse', this.tracking);
      const files = git(this.root, 'ls-tree', '--name-only', head).split('\n').filter(Boolean);
      return { head, claims: new Map(files.map((file): [string, Claim] => {
        const id = file.replace(/\.json$/u, '');
        return [id, assertClaim(JSON.parse(fileAt(this.root, head, file).toString()), id)];
      })) };
    });
  }

  // A plain push is the compare-and-swap; false means another claim won.
  acquire({ head }: Pick<LedgerSnapshot, 'head'>, claim: Claim, message: string): boolean {
    return this.withLock(() => this.push(head, this.commitClaim(head, claim, message)));
  }

  /**
   * Replaces the stale claim `stale` with `claim` in one commit on top of the snapshot head, pushed with the
   * compare-and-swap of `acquire`. Refuses without a commit (false) unless the snapshot's claim of `claim.id` is
   * deep-equal to `stale`; false also means that the ledger moved, so another runner may have won.
   */
  takeOver(snapshot: LedgerSnapshot, stale: Claim, claim: Claim, message: string): boolean {
    const current = snapshot.claims.get(claim.id);
    if (!current || !isDeepStrictEqual(current, stale)) return false;
    return this.acquire(snapshot, claim, message);
  }

  /**
   * Renews the claim of `id` held by `claimant` on `branch`: `renewedAt` becomes `at`, `leaseSeconds` the given lease
   * and a `blocked` mark is cleared. `lost` when the ledger has no such claim of the caller.
   */
  renew(id: string, claimant: string, branch: string, at: string, leaseSeconds: number, message: string): RenewResult {
    const result = this.update(id, claimant, branch, claim => {
      const { blocked: _blocked, ...rest } = claim;
      return { ...rest, renewedAt: at, leaseSeconds };
    }, message);
    return result === 'updated' ? 'renewed' : result;
  }

  /** Marks the claim of `id` held by `claimant` on `branch` blocked at `at`, keeping its `renewedAt`. */
  markBlocked(id: string, claimant: string, branch: string, at: string, message: string): MarkBlockedResult {
    const result = this.update(id, claimant, branch, claim => ({ ...claim, blocked: { at } }), message);
    return result === 'updated' ? 'blocked' : result;
  }

  /**
   * Up to `LEDGER_UPDATE_TRIES` tries of pull, check, commit and compare-and-swap push of `change(claim)`.
   */
  private update(id: string, claimant: string, branch: string, change: (claim: Claim) => Claim,
    message: string): 'updated' | 'lost' | 'deferred' {
    for (let tries = 0; tries < LEDGER_UPDATE_TRIES; tries += 1) {
      const snapshot = this.pull();
      const claim = snapshot.claims.get(id);
      if (!claim || claim.claimant !== claimant || claim.branch !== branch) return 'lost';
      if (this.acquire(snapshot, change(claim), message)) return 'updated';
    }
    return 'deferred';
  }

  /**
   * Removes the claims `ids` in one commit on top of the snapshot head, pushed with the compare-and-swap of
   * `acquire`. Returns false when the remote head moved; makes no commit when `ids` is empty or the ledger is empty.
   */
  release({ head }: Pick<LedgerSnapshot, 'head'>, ids: string[], message: string): boolean {
    if (!ids.length || !head) return true;
    return this.withLock(() => {
      const removed = new Set(ids.map(id => `${id}.json`));
      const entries = git(this.root, 'ls-tree', head).split('\n').filter(Boolean)
        .filter(entry => !removed.has(entry.slice(entry.indexOf('\t') + 1)));
      const tree = gitWithInput(this.root, entries.map(entry => `${entry}\n`).join(''), 'mktree');
      return this.push(head, git(this.root, 'commit-tree', tree, '-p', head, '-m', message));
    });
  }

  private push(head: string | null, commit: string): boolean {
    try {
      pushBookkeeping(this.root, 'origin', `${commit}:${this.ref}`);
      return true;
    } catch (error) {
      if (this.remoteHead() !== head) return false;
      throw error;
    }
  }

  /** A commit on top of `head` whose tree holds `claim` as `<id>.json`, replacing an existing entry of that id. */
  commitClaim(head: string | null, claim: Claim, message: string): string {
    const blob = gitWithInput(this.root, `${JSON.stringify(claim, null, 2)}\n`, 'hash-object', '-w', '--stdin');
    const name = `${claim.id}.json`;
    const entries = head ? git(this.root, 'ls-tree', head).split('\n').filter(Boolean)
      .filter(entry => entry.slice(entry.indexOf('\t') + 1) !== name) : [];
    const tree = gitWithInput(this.root,
      `${[...entries, `100644 blob ${blob}\t${name}`].join('\n')}\n`, 'mktree');
    return git(this.root, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message);
  }
}
