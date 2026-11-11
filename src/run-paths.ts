import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { git } from './git.ts';
import { digest, validBranchName } from './model.ts';
import type { Authority, Project, RunConfig } from './model.ts';

const safeInvocation = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export type TargetRefusal = 'detached-head' | 'target-differs-from-current-branch' | 'target-missing-on-origin' |
  'unsupported-target-name';

/** A startup refusal of the run target; the CLI prints its `reason` and exits with code 4. */
export class TargetError extends Error {
  reason: TargetRefusal;
  details?: unknown;
  constructor(reason: TargetRefusal, message: string, details?: unknown) {
    super(message);
    this.name = 'TargetError';
    this.reason = reason;
    if (details !== undefined) this.details = details;
  }
}

const failure = (error: unknown): string => {
  const { stderr, message } = error as Error & { stderr?: string | Buffer };
  return String(stderr ?? '').trim() || message;
};

function stateHome(env: NodeJS.ProcessEnv): string {
  return isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME! : join(homedir(), '.local', 'state');
}

/**
 * Resolves the run target to the branch checked out in `root`. Omitted `project.target` and `authority.target` are
 * set to it; a given target that differs, a detached HEAD, a name Git or the branch name rule rejects, and a branch
 * missing on origin are refused with a `reason`.
 */
export function resolveRunTarget(root: string, config: Partial<RunConfig>): Partial<RunConfig> {
  let branch: string;
  try { branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD'); }
  catch (error) {
    throw new TargetError('detached-head', 'HEAD is detached; check out the branch the runner should work on',
      { error: failure(error) });
  }
  let checked: string | undefined;
  try { checked = git(root, 'check-ref-format', '--branch', branch); } catch { checked = undefined; }
  if (checked !== branch || !validBranchName(branch)) {
    throw new TargetError('unsupported-target-name', `The current branch ${JSON.stringify(branch)} is not a supported target name`);
  }
  const given: [string, unknown][] = [['project.target', config.project?.target], ['authority.target', config.authority?.target]];
  for (const [field, value] of given) {
    if (value !== undefined && value !== branch) {
      throw new TargetError('target-differs-from-current-branch',
        `${field} ${JSON.stringify(value)} differs from the current branch ${JSON.stringify(branch)}`,
        { field, given: value, current: branch });
    }
  }
  try { git(root, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`); }
  catch (error) {
    throw new TargetError('target-missing-on-origin', `The current branch ${JSON.stringify(branch)} is missing on origin`,
      { branch, error: failure(error) });
  }
  return { ...config, project: { ...config.project, target: branch } as Project,
    authority: { ...config.authority, target: branch } as Authority };
}

export function resolveRunPaths(config: Partial<RunConfig>,
  { cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): RunConfig {
  if (config.root !== undefined || config.stateDirectory !== undefined) {
    throw new Error('Invocation files must not set root or stateDirectory');
  }
  if (!safeInvocation.test(config.invocation ?? '')) throw new Error('Unsafe invocation name');
  const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
  // Target resolution is the first startup step; the resolved target enters the frozen invocation identity.
  const resolved = resolveRunTarget(root, config);
  const clone = `${basename(root)}-${digest(root).slice(0, 12)}`;
  return { ...resolved, root, stateDirectory: join(stateHome(env), 'outcome-runner', clone, config.invocation!) } as RunConfig;
}
