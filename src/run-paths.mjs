import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { git } from './git.mjs';
import { digest } from './model.mjs';

const safeInvocation = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function stateHome(env) {
  return isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
}

export function resolveRunPaths(config, { cwd = process.cwd(), env = process.env } = {}) {
  if (config.root !== undefined || config.stateDirectory !== undefined) {
    throw new Error('Invocation files must not set root or stateDirectory');
  }
  if (!safeInvocation.test(config.invocation ?? '')) throw new Error('Unsafe invocation name');
  const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
  const clone = `${basename(root)}-${digest(root).slice(0, 12)}`;
  return { ...config, root, stateDirectory: join(stateHome(env), 'outcome-runner', clone, config.invocation) };
}
