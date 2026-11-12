import { fileAt, git, gitWithInput, pushBookkeeping } from './git.ts';

export interface Claim {
  version: number;
  id: string;
  claimant: string;
  scopes: string[];
  taskHash?: string;
  host?: string;
  branch?: string;
  claimedAt?: string;
}

export interface LedgerSnapshot { head: string | null; claims: Map<string, Claim> }

/** Runs one group of Git operations under a lock; the default runs it directly. */
export type LockWrapper = <T>(fn: () => T) => T;

export const claimsBranch = (target: string): string => `work-queue-claims-${target.replaceAll('/', '-')}`;

function assertClaim(claim: Claim, id: string): Claim {
  if (claim?.version !== 1 || claim.id !== id || typeof claim.claimant !== 'string' ||
      !claim.claimant || !Array.isArray(claim.scopes)) throw new Error('Invalid repository claim record');
  return claim;
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

  commitClaim(head: string | null, claim: Claim, message: string): string {
    const blob = gitWithInput(this.root, `${JSON.stringify(claim, null, 2)}\n`, 'hash-object', '-w', '--stdin');
    const entries = head ? git(this.root, 'ls-tree', head).split('\n').filter(Boolean) : [];
    const tree = gitWithInput(this.root,
      `${[...entries, `100644 blob ${blob}\t${claim.id}.json`].join('\n')}\n`, 'mktree');
    return git(this.root, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message);
  }
}
