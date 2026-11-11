import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, hasRef } from './git.ts';
import { primaryOf, withGitLock } from './git-lock.ts';
import { hash } from './model.ts';
import type { RunConfig } from './model.ts';

/** The kept worktree that receives interactive setup changes, so the start checkout is never changed. */
export interface SetupWorktree { path: string; branch: string }

/** Where the setup worktree of an invocation lives and which branch it uses; nothing is created. */
export function setupLocation(primary: string, invocation: string): SetupWorktree {
  const operation = hash({ invocation, setup: true });
  return { path: join(dirname(primary), `${basename(primary)}-outcomes`, `setup-${operation}`),
    branch: `outcome/setup-${operation.slice(0, 12)}` };
}

/**
 * Returns the setup worktree `<primary>-outcomes/setup-<operation>` on branch `outcome/setup-<operation[0..12]>`.
 * On first use it is created from `origin/<target>` under the Git lock; later calls reuse it. Task cleanup and the
 * leftover sweep never touch it.
 */
export function setupWorktree(root: string, config: Pick<RunConfig, 'invocation' | 'project'>): SetupWorktree {
  const primary = primaryOf(root);
  const location = setupLocation(primary, config.invocation);
  if (existsSync(location.path)) return location;
  const target = config.project.target;
  withGitLock(primary, () => {
    git(root, 'fetch', 'origin', target);
    if (hasRef(root, `refs/heads/${location.branch}`)) git(root, 'worktree', 'add', location.path, location.branch);
    else git(root, 'worktree', 'add', '-b', location.branch, location.path, `origin/${target}`);
  });
  return location;
}
