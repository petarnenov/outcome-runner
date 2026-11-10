import { fileAt, git, gitWithInput } from './git.mjs';

export const claimsBranch = target => `work-queue-claims-${target.replaceAll('/', '-')}`;

function assertClaim(claim, id) {
  if (claim?.version !== 1 || claim.id !== id || typeof claim.claimant !== 'string' ||
      !claim.claimant || !Array.isArray(claim.scopes)) throw new Error('Invalid repository claim record');
  return claim;
}

export class ClaimLedger {
  constructor(root, target) {
    this.root = root;
    this.branch = claimsBranch(target);
    this.ref = `refs/heads/${this.branch}`;
    this.tracking = `refs/work-queue/claims/${this.branch}`;
  }

  remoteHead() {
    return git(this.root, 'ls-remote', 'origin', this.ref).split('\t')[0] || null;
  }

  pull() {
    if (!this.remoteHead()) return { head: null, claims: new Map() };
    git(this.root, 'fetch', 'origin', `+${this.ref}:${this.tracking}`);
    const head = git(this.root, 'rev-parse', this.tracking);
    const files = git(this.root, 'ls-tree', '--name-only', head).split('\n').filter(Boolean);
    return { head, claims: new Map(files.map(file => {
      const id = file.replace(/\.json$/u, '');
      return [id, assertClaim(JSON.parse(fileAt(this.root, head, file)), id)];
    })) };
  }

  // A plain push is the compare-and-swap; false means another claim won.
  acquire({ head }, claim, message) {
    const commit = this.commitClaim(head, claim, message);
    try {
      git(this.root, 'push', 'origin', `${commit}:${this.ref}`);
      return true;
    } catch (error) {
      if (this.remoteHead() !== head) return false;
      throw error;
    }
  }

  commitClaim(head, claim, message) {
    const blob = gitWithInput(this.root, `${JSON.stringify(claim, null, 2)}\n`, 'hash-object', '-w', '--stdin');
    const entries = head ? git(this.root, 'ls-tree', head).split('\n').filter(Boolean) : [];
    const tree = gitWithInput(this.root,
      `${[...entries, `100644 blob ${blob}\t${claim.id}.json`].join('\n')}\n`, 'mktree');
    return git(this.root, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message);
  }
}
