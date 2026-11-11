import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isatty } from 'node:tty';
import { git } from './git.ts';
import { primaryOf, withGitLock } from './git-lock.ts';
import { safePath, validBranchName } from './model.ts';
import type { RunConfig } from './model.ts';
import { setupWorktree } from './setup-worktree.ts';
import type { SetupWorktree } from './setup-worktree.ts';

export const OPENSPEC_INSTALL: readonly string[] = ['npm', 'install', '-g', '@fission-ai/openspec@latest'];
export const OPENSPEC_CONFIG = 'openspec/config.yaml';
export const OPENSPEC_CONFIG_CONTENT = 'schema: spec-driven\n';

/** A startup refusal whose `reason` (and optional private `details`) is reported in the CLI's diagnostics output. */
export class PreflightError extends Error {
  reason: string;
  details?: unknown;
  constructor(reason: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PreflightError';
    this.reason = reason;
    if (details !== undefined) this.details = details;
  }
}

export interface ProcessStatus { status: number | null }

export interface PreflightDeps {
  signal?: AbortSignal;
  /** True only when both stdin and stderr are TTYs. */
  interactive: boolean;
  /** Asks one question on stderr and resolves with the answer line ('' when stdin closes). */
  ask: (question: string) => Promise<string>;
  /** Writes an explanation to stderr. */
  say: (text: string) => void;
  /** Runs a program silently (child output discarded); used only for `openspec --version`. */
  probe: (program: string, args: string[], cwd: string) => ProcessStatus;
  /** Runs a program forwarding its output to stderr; used only for the npm install. */
  exec: (program: string, args: string[], cwd: string) => ProcessStatus;
  /** Whether openspec/config.yaml exists at origin/<target>; throws on any git failure. */
  configPresent: (root: string, target: string) => boolean;
  exists: (path: string) => boolean;
  /** Creates a new file (never overwrites), creating parent directories. */
  writeFile: (path: string, content: string) => void;
  /** Creates or reuses the setup worktree that receives the layout files; the start checkout is never changed. */
  setupWorktree: (root: string, config: RunConfig) => SetupWorktree;
}

interface TtyStream { isTTY?: boolean }

export const isInteractive = (stdin: TtyStream, stderr: TtyStream): boolean => Boolean(stdin.isTTY && stderr.isTTY);

/** Prompts on `output` and reads one line from `input`; a closed input answers ''. */
export function promptOn(input: Readable, output: Writable, signal?: AbortSignal): (question: string) => Promise<string> {
  return question => new Promise<string>(resolve => {
    const reader = createInterface({ input, terminal: false });
    const cancel = () => reader.close();
    reader.once('close', () => { signal?.removeEventListener('abort', cancel); resolve(''); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { reader.close(); return; }
    output.write(question);
    reader.once('line', line => { resolve(line); reader.close(); });
  });
}

const statusOf = (result: { error?: Error; status: number | null }): ProcessStatus =>
  ({ status: result.error ? null : result.status });

/** Fetches origin <target> under the Git lock and lists openspec/config.yaml there; any git failure throws a plain Error. */
export function configAtOrigin(root: string, target: string): boolean {
  try { withGitLock(primaryOf(root), () => git(root, 'fetch', 'origin', target)); }
  catch (error) { throw new Error(`git fetch origin ${target} failed: ${(error as Error).message}`); }
  let listing: string;
  try { listing = git(root, 'ls-tree', '--name-only', `origin/${target}`, '--', OPENSPEC_CONFIG); }
  catch (error) { throw new Error(`git ls-tree origin/${target} failed: ${(error as Error).message}`); }
  if (!listing) return false;
  if (listing.split('\n').includes(OPENSPEC_CONFIG)) return true;
  throw new Error(`git ls-tree origin/${target} returned unexpected output`);
}

export function defaultPreflightDeps(): PreflightDeps {
  return {
    // Equivalent to process.stdin.isTTY && process.stderr.isTTY without opening the stdin stream.
    interactive: isInteractive({ isTTY: isatty(0) }, { isTTY: isatty(2) }),
    ask: question => promptOn(process.stdin, process.stderr)(question),
    say: text => { process.stderr.write(text); },
    probe: (program, args, cwd) => statusOf(spawnSync(program, args, { cwd, shell: false, stdio: 'ignore' })),
    exec: (program, args, cwd) => statusOf(spawnSync(program, args, { cwd, shell: false, stdio: ['ignore', 2, 2] })),
    configPresent: configAtOrigin,
    exists: existsSync,
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { flag: 'wx' });
    },
    setupWorktree,
  };
}

const accepted = (answer: string): boolean => ['y', 'yes'].includes(answer.trim().toLowerCase());

/**
 * Verifies that the OpenSpec CLI is available and that openspec/config.yaml exists at origin/<target>.
 * Interactive runs may install the CLI or create the layout in the setup worktree; non-interactive runs only refuse.
 */
export async function openspecPreflight(config: RunConfig, overrides: Partial<PreflightDeps> = {}): Promise<void> {
  const deps: PreflightDeps = { ...defaultPreflightDeps(), ...overrides };
  if (!overrides.ask) deps.ask = question => promptOn(process.stdin, process.stderr, deps.signal)(question);
  const ask = deps.ask;
  deps.ask = async question => { const answer = await ask(question); deps.signal?.throwIfAborted(); return answer; };
  deps.signal?.throwIfAborted();
  const project = config?.project;
  const target = project?.target;
  if (!config?.root || !validBranchName(target)) throw new Error('Invalid OFF configuration or authority');
  const changes = safePath(project.changes); const receipts = safePath(project.receipts);
  const root = realpathSync(config.root);

  const cliAvailable = () => deps.probe('openspec', ['--version'], root).status === 0;
  if (!cliAvailable()) {
    const install = OPENSPEC_INSTALL.join(' ');
    if (!deps.interactive) {
      throw new PreflightError('openspec-missing', `OpenSpec CLI unavailable: openspec --version failed; install it with ${install}`);
    }
    deps.say('The OpenSpec CLI is missing: `openspec --version` did not succeed. The runner needs it to plan and validate changes.\n');
    if (!accepted(await deps.ask(`Install it now with \`${install}\`? [y/N] `))) {
      throw new PreflightError('openspec-missing', 'OpenSpec CLI unavailable and installation was declined');
    }
    // The global install writes no project file, so it runs outside the start checkout.
    if (deps.exec(OPENSPEC_INSTALL[0], OPENSPEC_INSTALL.slice(1), tmpdir()).status !== 0) {
      throw new PreflightError('openspec-missing', `OpenSpec installation failed: ${install}`);
    }
    if (!cliAvailable()) {
      throw new PreflightError('openspec-missing', 'OpenSpec was installed but openspec --version still fails');
    }
  }

  if (deps.configPresent(root, target)) return;
  const missing = `${OPENSPEC_CONFIG} is missing at origin/${target}`;
  if (!deps.interactive) throw new PreflightError('openspec-not-initialized', `OpenSpec not initialized: ${missing}`);
  const layout = new Map([[OPENSPEC_CONFIG, OPENSPEC_CONFIG_CONTENT], [`${changes}/.gitkeep`, ''], [`${receipts}/.gitkeep`, '']]);
  deps.say(`OpenSpec is not initialized: ${missing}. The project layout consists of ${[...layout.keys()].join(', ')}.\n`);
  if (!accepted(await deps.ask('Create the missing layout files in a setup worktree outside your checkout ' +
      '(they are not committed or pushed)? [y/N] '))) {
    throw new PreflightError('openspec-not-initialized', `OpenSpec not initialized: ${missing}; layout creation was declined`);
  }
  const setup = deps.setupWorktree(root, config);
  const created: string[] = [];
  for (const [path, content] of layout) {
    const file = join(setup.path, path);
    if (!deps.exists(file)) { deps.writeFile(file, content); created.push(path); }
  }
  const where = `the setup worktree ${setup.path} on branch ${setup.branch}`;
  const message = (created.length ? `Created ${created.join(', ')} in ${where}` : `The OpenSpec layout files already exist in ${where}`) +
    `; commit them there, push the branch and merge it into ${target}, then run again`;
  deps.say(message + '\n');
  throw new PreflightError('openspec-layout-created', message, { setupWorktree: setup.path, setupBranch: setup.branch, created });
}
