import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../src/git.ts';
import { withGitLock } from '../../src/git-lock.ts';

// `hold <root> <name> <rounds> <marker>` takes the Git lock, writes the marker and sleeps inside the lock until killed.
// `hold-ms <root> <name> <milliseconds> <marker>` does the same but releases the lock after the given time.
// `work <root> <name> <rounds>` repeatedly fetches, adds and removes a worktree and creates and deletes a branch,
// each group under the Git lock. Any Git failure exits nonzero with the message on stderr.
const [mode, root, name, rounds = '4', marker = ''] = process.argv.slice(2);
if (mode === 'hold' || mode === 'hold-ms') {
  withGitLock(root, () => {
    writeFileSync(marker, 'held');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, mode === 'hold-ms' ? Number(rounds) : 30000);
  });
} else {
  for (let round = 0; round < Number(rounds); round += 1) {
    const branch = `lock-${name}-${round}`; const path = join(root, '..', `tree-${name}-${round}`);
    withGitLock(root, () => {
      git(root, 'fetch', '-q', 'origin', 'main');
      git(root, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
    });
    withGitLock(root, () => {
      git(root, 'worktree', 'remove', '--force', path);
      git(root, 'branch', '-D', branch);
      git(root, 'worktree', 'prune');
    });
  }
}
