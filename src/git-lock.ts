import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from './git.ts';
import { hash } from './model.ts';

/** The default wait for the per-clone Git lock. */
export const GIT_LOCK_TIMEOUT_MS = 60000;
export const GIT_LOCK_TIMEOUT_MESSAGE = 'Git lock wait exceeded 60 seconds';

/** The primary checkout of the repository containing `root` (shared by all its worktrees). */
export const primaryOf = (root: string): string => dirname(resolve(root, git(root, 'rev-parse', '--git-common-dir')));

/** The directory beside the primary checkout that holds the lock and ownership files of a clone. */
export function lockRootOf(primary: string): string {
  const lockRoot = join(dirname(primary), '.work-queue-locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return lockRoot;
}

const held = new Map<string, number>();

/**
 * Runs one synchronous group of Git operations while holding the per-clone Git lock
 * `<lockRoot>/<hash(primary)>-git.sqlite`. The operating system releases the SQLite file lock when the holder exits
 * or crashes. A nested call in the same process reuses the held lock.
 */
export function withGitLock<T>(primary: string, fn: () => T, { timeoutMs = GIT_LOCK_TIMEOUT_MS }: { timeoutMs?: number } = {}): T {
  const key = resolve(primary);
  const depth = held.get(key) ?? 0;
  if (depth) {
    held.set(key, depth + 1);
    try { return fn(); } finally { held.set(key, depth); }
  }
  const database = new DatabaseSync(join(lockRootOf(key), `${hash(key)}-git.sqlite`));
  try {
    database.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(timeoutMs))};`);
    try { database.exec('BEGIN EXCLUSIVE;'); }
    catch (error) {
      if (/locked|busy/iu.test((error as Error).message)) throw new Error(GIT_LOCK_TIMEOUT_MESSAGE);
      throw error;
    }
    held.set(key, 1);
    try { return fn(); }
    finally {
      held.delete(key);
      try { database.exec('ROLLBACK;'); } catch { /* Closing releases the lock as well. */ }
    }
  } finally { database.close(); }
}
