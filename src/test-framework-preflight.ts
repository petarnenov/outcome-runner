import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isatty } from 'node:tty';
import { CodexFiles, brokerTool } from './codex-files.ts';
import { git } from './git.ts';
import { resolveCoverage, safePath, within } from './model.ts';
import type { Project, RunConfig } from './model.ts';
import { PreflightError, isInteractive, promptOn } from './openspec-preflight.ts';
import type { ProcessStatus } from './openspec-preflight.ts';
import type { RunStore } from './run-store.ts';
import { cancellable } from './statistics.ts';
import { pageOffset } from './text-page.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolDefinition, ToolInput } from './harness-adapter.ts';

export const TECHNOLOGY_KINDS = ['language', 'runtime', 'framework', 'build-tool'] as const;
export type TechnologyKind = typeof TECHNOLOGY_KINDS[number];
export interface Thresholds<T> { lines: T; branches: T; functions: T }
export interface ExistingFramework { name: string; evidence: string[]; thresholds: Thresholds<number | null> }
export interface InstallCommand { command: string; args: string[] }
export interface FileChange { path: string; content: string }
export interface Recommendation {
  framework: string;
  rationale: string;
  install: InstallCommand[];
  changes: FileChange[];
  thresholds: Thresholds<number>;
}
export interface Technology {
  name: string;
  kind: TechnologyKind;
  evidence: string[];
  frameworks: ExistingFramework[];
  recommendations: Recommendation[];
}
export interface AnalysisReport { technologies: Technology[] }

export interface TemporaryWorktree {
  /** Creates a detached worktree of origin/<target> outside the repository and returns its path. */
  add(root: string, target: string): string;
  /** Removes the worktree, its temporary directory and the git worktree record. */
  remove(root: string, path: string): void;
}

export interface TestFrameworkDeps {
  signal?: AbortSignal;
  /** True only when both stdin and stderr are TTYs (same rule as the OpenSpec preflight). */
  interactive: boolean;
  /** Asks one question on stderr and resolves with the answer line ('' when stdin closes). */
  ask: (question: string) => Promise<string>;
  /** Writes text to stderr. */
  say: (text: string) => void;
  /** Creates the adapter of the selected harness, model and effort. */
  createAdapter: (options: HarnessOptions) => HarnessAdapter;
  worktree: TemporaryWorktree;
  /** Tracked files of the temporary worktree. */
  files: (tree: string) => string[];
  /** Optional replacement of the whole analysis session; its result is validated like a session report. */
  analyse?: (config: RunConfig, tree: string) => Promise<unknown>;
  /** Runs one install command without a shell, forwarding output to stderr. */
  exec: (program: string, args: string[], cwd: string) => ProcessStatus;
  /** Writes the full content of one file, creating parent directories. */
  writeFile: (path: string, content: string) => void;
  /** Working-tree status and content snapshot: path -> `<XY>:<sha256 | missing>`. */
  snapshot: (root: string) => Map<string, string>;
}

const numberOrNull = { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] };
const thresholdSchema = (value: object) => ({ type: 'object', additionalProperties: false,
  properties: { lines: value, branches: value, functions: value }, required: ['lines', 'branches', 'functions'] });
const strings = { type: 'array', items: { type: 'string' } };

export const testFrameworkReportTool: ToolDefinition = { type: 'function', name: 'test_framework_report',
  description: 'Return the private structured test framework analysis to the automatic controller.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['technologies'], properties: {
    technologies: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['name', 'kind', 'evidence', 'frameworks', 'recommendations'], properties: {
        name: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: [...TECHNOLOGY_KINDS] },
        evidence: { ...strings, minItems: 1 },
        frameworks: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['name', 'evidence', 'thresholds'], properties: { name: { type: 'string', minLength: 1 },
            evidence: { ...strings, minItems: 1 }, thresholds: thresholdSchema(numberOrNull) } } },
        recommendations: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
          required: ['framework', 'rationale', 'install', 'changes', 'thresholds'], properties: {
            framework: { type: 'string', minLength: 1 }, rationale: { type: 'string', minLength: 1 },
            install: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['command', 'args'],
              properties: { command: { type: 'string', minLength: 1 }, args: strings } } },
            changes: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
              required: ['path', 'content'], properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } } } },
            thresholds: thresholdSchema({ type: 'number', minimum: 0, maximum: 100 }) } } } } } } } } };

const METRICS = ['lines', 'branches', 'functions'] as const;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** A technology is prepared when one existing framework enforces all three thresholds of at least the coverage. */
export const isPrepared = (technology: Technology, coverage: number): boolean => technology.frameworks.some(framework =>
  METRICS.every(metric => typeof framework.thresholds[metric] === 'number' && framework.thresholds[metric]! >= coverage));

function evidenceOf(value: unknown, tracked: Set<string>, where: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${where} needs at least one evidence path`);
  for (const path of value) {
    if (typeof path !== 'string' || !tracked.has(path)) throw new Error(`${where} evidence ${JSON.stringify(path)} is not a tracked path`);
  }
  return [...value] as string[];
}

function recommendationOf(value: unknown, coverage: number, where: string): Recommendation {
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  if (!nonempty(value.framework)) throw new Error(`${where} needs a framework name`);
  if (!nonempty(value.rationale) || /[\r\n]/u.test(value.rationale)) throw new Error(`${where} needs a one-sentence rationale`);
  if (!Array.isArray(value.install) || value.install.some(step => !isObject(step) || !nonempty(step.command) ||
      !Array.isArray(step.args) || step.args.some(arg => typeof arg !== 'string'))) {
    throw new Error(`${where} needs install commands as command and argument arrays`);
  }
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.some(change => !isObject(change) ||
      !nonempty(change.path) || typeof change.content !== 'string')) {
    throw new Error(`${where} needs file changes with a path and content`);
  }
  const thresholds = value.thresholds;
  if (!isObject(thresholds) || METRICS.some(metric => thresholds[metric] !== coverage)) {
    throw new Error(`${where} needs line, branch and function thresholds equal to ${coverage}`);
  }
  return { framework: value.framework, rationale: value.rationale,
    install: (value.install as InstallCommand[]).map(({ command, args }) => ({ command, args: [...args] })),
    changes: (value.changes as FileChange[]).map(({ path, content }) => ({ path, content })),
    thresholds: { lines: coverage, branches: coverage, functions: coverage } };
}

/** Validates a session report against the tracked files and the resolved coverage; throws naming the missing part. */
export function validateReport(candidate: unknown, coverage: number, tracked: Set<string>): AnalysisReport {
  if (!isObject(candidate) || !Array.isArray(candidate.technologies) || !candidate.technologies.length) {
    throw new Error('The report needs at least one technology');
  }
  const names = new Set<string>();
  const technologies = candidate.technologies.map((value: unknown, index: number): Technology => {
    if (!isObject(value) || !nonempty(value.name)) throw new Error(`Technology ${index + 1} needs a name`);
    const name = value.name;
    if (names.has(name)) throw new Error(`Technology ${name} is listed twice`);
    names.add(name);
    if (!TECHNOLOGY_KINDS.includes(value.kind as TechnologyKind)) {
      throw new Error(`Technology ${name} needs a kind of ${TECHNOLOGY_KINDS.join(', ')}`);
    }
    const evidence = evidenceOf(value.evidence, tracked, `Technology ${name}`);
    if (!Array.isArray(value.frameworks)) throw new Error(`Technology ${name} needs its existing test frameworks`);
    const frameworks = value.frameworks.map((framework: unknown): ExistingFramework => {
      if (!isObject(framework) || !nonempty(framework.name)) throw new Error(`A framework of ${name} needs a name`);
      const where = `Framework ${framework.name} of ${name}`;
      const thresholds = framework.thresholds;
      if (!isObject(thresholds) || METRICS.some(metric => thresholds[metric] !== null && !percent(thresholds[metric]))) {
        throw new Error(`${where} needs line, branch and function thresholds (a number from 0 to 100 or null)`);
      }
      return { name: framework.name, evidence: evidenceOf(framework.evidence, tracked, where),
        thresholds: { lines: thresholds.lines as number | null, branches: thresholds.branches as number | null,
          functions: thresholds.functions as number | null } };
    });
    const technology: Technology = { name, kind: value.kind as TechnologyKind, evidence, frameworks, recommendations: [] };
    if (isPrepared(technology, coverage)) return technology;
    const recommendations = value.recommendations;
    if (!Array.isArray(recommendations) || recommendations.length < 1 || recommendations.length > 3) {
      throw new Error(`Technology ${name} has no prepared test framework and needs one to three recommendations`);
    }
    technology.recommendations = recommendations.map((recommendation: unknown, position: number) =>
      recommendationOf(recommendation, coverage, `Recommendation ${position + 1} of ${name}`));
    return technology;
  });
  return { technologies };
}

const statusOf = (result: { error?: Error; status: number | null }): ProcessStatus => ({ status: result.error ? null : result.status });
const fileState = (path: string): string => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'missing'; }
};

/** Parses `git status --porcelain -z --untracked-files=all` into path -> `<XY>:<sha256 | missing>`. */
export function workingTreeSnapshot(root: string): Map<string, string> {
  const output = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = output.split('\0'); const snapshot = new Map<string, string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2); const path = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') index++;
    snapshot.set(path, `${status}:${fileState(join(root, path))}`);
  }
  return snapshot;
}

const TEMPORARY_PREFIX = 'outcome-test-framework-';

export const temporaryWorktree: TemporaryWorktree = {
  add(root, target) {
    git(root, 'fetch', 'origin', target);
    const sha = git(root, 'rev-parse', `origin/${target}`);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX)));
    try {
      const primary = dirname(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
      if (within(directory, realpathSync(root)) || within(directory, realpathSync(primary))) {
        throw new Error('The temporary worktree must be outside the repository');
      }
      git(root, 'worktree', 'add', '--detach', join(directory, 'tree'), sha);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      try { git(root, 'worktree', 'prune'); } catch { /* The original failure is reported. */ }
      throw error;
    }
    return join(directory, 'tree');
  },
  remove(root, path) {
    const errors: string[] = [];
    try { git(root, 'worktree', 'remove', '--force', path); } catch (error) { errors.push((error as Error).message); }
    const parent = dirname(path);
    try { rmSync(basename(parent).startsWith(TEMPORARY_PREFIX) ? parent : path, { recursive: true, force: true }); }
    catch (error) { errors.push((error as Error).message); }
    try { git(root, 'worktree', 'prune'); } catch (error) { errors.push((error as Error).message); }
    if (errors.length) throw new Error(`Temporary worktree removal failed: ${errors.join('; ')}`);
  },
};

export function defaultTestFrameworkDeps(): Omit<TestFrameworkDeps, 'createAdapter'> {
  return {
    interactive: isInteractive({ isTTY: isatty(0) }, { isTTY: isatty(2) }),
    ask: question => promptOn(process.stdin, process.stderr)(question),
    say: text => { process.stderr.write(text); },
    worktree: temporaryWorktree,
    files: tree => git(tree, 'ls-files', '-z').split('\0').filter(Boolean),
    exec: (program, args, cwd) => statusOf(spawnSync(program, args, { cwd, shell: false, stdio: ['ignore', 2, 2] })),
    writeFile: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
    snapshot: workingTreeSnapshot,
  };
}

const READ_ONLY = 'Analysis session is read-only';
const refusingStore = new Proxy({}, { get: () => { throw new Error(READ_ONLY); } }) as unknown as RunStore;

export function analysisPrompt(target: string, coverage: number): string {
  return 'OFF. Never ask a person anything. All output is private. ' +
    'Use only backlog_tool operations read_file and context, and test_framework_report. ' +
    'This session is read-only: there is no write_file, no run_checks, no shell and no approval tool. ' +
    'Read files with input {path,offset}; a read returns one page: repeat it with nextOffset until nextOffset is null. ' +
    'context takes input {section:"paths",offset} and lists the tracked files in pages the same way.\n' +
    `Resolved coverage threshold: ${coverage}%.\n` +
    `Analyse the repository at origin/${target}. Call test_framework_report once with technologies: every detected ` +
    'technology (kind language, runtime, framework or build-tool) with the tracked paths that prove it as evidence; ' +
    'for each technology the test frameworks already present with their evidence paths and the line, branch and ' +
    'function coverage thresholds they enforce (a number, or null when not enforced); and, for each technology ' +
    `without a framework enforcing at least ${coverage} for lines, branches and functions, one to three ` +
    'recommendations, each with framework, a one-sentence rationale on one line, install as an array of ' +
    '{command,args} argument arrays, changes as {path,content} with the full new content of each repository file ' +
    `that runs the tests, and thresholds {lines:${coverage},branches:${coverage},functions:${coverage}} enforced by ` +
    'those changes. Do not change any file.';
}

async function analysisSession(config: RunConfig, tree: string, files: string[], coverage: number,
  deps: TestFrameworkDeps): Promise<AnalysisReport> {
  const tracked = new Set(files);
  let recorded: AnalysisReport | undefined; let lastValidation: string | undefined;
  const broker = new CodexFiles({ root: tree, scopes: files.map(path => ({ path, mode: 'read' })), store: refusingStore,
    identity: { purpose: 'test-framework-analysis' }, revalidate: async () => true });
  const handleTool = async (name: string, input: ToolInput): Promise<unknown> => {
    deps.signal?.throwIfAborted();
    if (name === brokerTool.name && input?.operation === 'read_file') return broker.call(name, input);
    if (name === brokerTool.name && input?.operation === 'context') {
      const { section = 'paths', offset } = (input.input ?? {}) as Partial<BrokerInput>;
      if (section !== 'paths') throw new Error(READ_ONLY);
      const start = pageOffset(offset);
      return { section, files: files.slice(start, start + 200), nextOffset: start + 200 < files.length ? start + 200 : null };
    }
    if (name === testFrameworkReportTool.name) {
      try { recorded = validateReport(input, coverage, tracked); lastValidation = undefined; }
      catch (error) { lastValidation = (error as Error).message; throw error; }
      return { status: 'recorded' };
    }
    throw new Error(READ_ONLY);
  };
  const adapter = deps.createAdapter({ cwd: tree, tools: [brokerTool, testFrameworkReportTool], handleTool });
  try {
    if (adapter.probe().status !== 'interface-ready') throw new Error('Selected harness interface unavailable');
    await cancellable(adapter.startAction(analysisPrompt(config.project.target, coverage)), deps.signal);
  } finally {
    try { adapter.close(); } catch { /* Closing never hides the session result. */ }
  }
  if (!recorded) {
    throw new Error(lastValidation ? `Invalid test framework report: ${lastValidation}` :
      'The analysis session ended without a test framework report');
  }
  return recorded;
}

/** Code points HFS+ ignores in file names, so git treats names containing them as the unmarked name. */
const IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/gu;
/**
 * Folds one path component the way case-insensitive filesystems compare it: Unicode NFC, without HFS+ ignorable
 * code points, lower case, and without the trailing dots and spaces that Windows drops.
 */
const foldComponent = (part: string): string =>
  part.normalize('NFC').replace(IGNORABLE, '').toLowerCase().replace(/[. ]+$/u, '');
const foldPath = (path: string): string => path.split('/').map(foldComponent).join('/');
/** `.git` and the variants git itself refuses because such filesystems treat them as `.git` (including `git~1`). */
const isGitComponent = (part: string): boolean => ['.git', 'git~1'].includes(foldComponent(part));

/** Why a repository-relative path touches .git or a protected directory (compared case-insensitively), or null. */
function protectedReason(path: string, project: Project): string | null {
  if (path.split('/').some(isGitComponent)) return 'is inside .git';
  const folded = foldPath(path);
  for (const protectedPath of [project.queue, project.receipts, project.changes]) {
    if (within(folded, foldPath(protectedPath))) return `is inside ${protectedPath}`;
  }
  return null;
}

const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/**
 * Why a recommended file change is refused, or null when it is allowed. `.git` and the queue, receipts and changes
 * directories are compared case-insensitively, on the requested path and on the path after resolving symlinks.
 */
export function refusedChange(root: string, path: string, project: Project): string | null {
  try { safePath(path); } catch { return `${JSON.stringify(path)} is not a safe repository-relative path outside .git`; }
  const literal = protectedReason(path, project);
  if (literal) return `${path} ${literal}`;
  // Resolve the deepest existing ancestor (a symlink counts as existing, even when dangling) through every symlink.
  const requested = join(root, path);
  let ancestor = requested;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  let real: string;
  try { real = relative(root, realpathSync(ancestor)); } catch { return `${path} cannot be resolved inside the repository`; }
  if (real === '..' || real.startsWith(`..${sep}`) || isAbsolute(real)) return `${path} resolves outside the repository`;
  const resolved = [real, relative(ancestor, requested)].filter(Boolean).join(sep).split(sep).join('/');
  const viaLink = protectedReason(resolved, project);
  if (viaLink) return `${path} resolves to ${resolved}, which ${viaLink}`;
  return null;
}

const accepted = (answer: string): boolean => ['y', 'yes'].includes(answer.trim().toLowerCase());
const threshold = (value: number | null) => value === null ? 'none' : `${value}%`;
const describe = (report: AnalysisReport, coverage: number): string =>
  'Detected technologies:\n' + report.technologies.map(technology =>
    `- ${technology.name} (${technology.kind}) ${isPrepared(technology, coverage) ? 'prepared' : 'not prepared'}; ` +
    `evidence: ${technology.evidence.join(', ')}\n` +
    (technology.frameworks.length ? technology.frameworks.map(framework => `  framework ${framework.name} ` +
      `(lines ${threshold(framework.thresholds.lines)}, branches ${threshold(framework.thresholds.branches)}, ` +
      `functions ${threshold(framework.thresholds.functions)}); evidence: ${framework.evidence.join(', ')}\n`).join('') :
      '  no test framework\n')).join('');

const failure = (message: string, details?: unknown) =>
  new PreflightError('test-framework-analysis-failed', `Test framework analysis failed: ${message}`, details);

/**
 * Analyses origin/<target> in one read-only session of the selected harness and requires a test framework
 * enforcing the resolved coverage for every technology. Interactive runs may set up a recommended framework
 * in the working tree; nothing is committed or pushed.
 */
export async function testFrameworkPreflight(config: RunConfig, overrides: Partial<TestFrameworkDeps> = {}): Promise<void> {
  const deps = { ...defaultTestFrameworkDeps(), ...overrides } as TestFrameworkDeps;
  if (!overrides.ask) deps.ask = question => promptOn(process.stdin, process.stderr, deps.signal)(question);
  const ask = deps.ask;
  deps.ask = async question => { const answer = await ask(question); deps.signal?.throwIfAborted(); return answer; };
  deps.signal?.throwIfAborted();
  const coverage = resolveCoverage(config.coverage);
  const project = config.project; const target = project.target;
  const root = realpathSync(config.root);

  let tree: string | undefined; let report: AnalysisReport | undefined; let error: unknown; let failed = false;
  try {
    tree = deps.worktree.add(root, target);
    const files = deps.files(tree);
    if (deps.analyse) report = validateReport(await cancellable(deps.analyse(config, tree), deps.signal), coverage, new Set(files));
    else {
      if (!deps.createAdapter) throw new Error('No harness adapter factory');
      report = await analysisSession(config, tree, files, coverage, deps);
    }
  } catch (caught) { failed = true; error = caught; }
  if (tree !== undefined) {
    try { deps.worktree.remove(root, tree); }
    catch (caught) { if (!failed) { failed = true; error = caught; } }
  }
  if (failed) {
    if (deps.signal?.aborted) throw error;
    const message = (error as Error)?.message ?? String(error);
    throw failure(tree === undefined ? `temporary worktree of origin/${target} unavailable: ${message}` : message,
      { error: message });
  }
  const analysed = report!;

  const unprepared = analysed.technologies.filter(technology => !isPrepared(technology, coverage));
  if (deps.interactive) deps.say(describe(analysed, coverage));
  if (!unprepared.length) return;
  const names = unprepared.map(technology => technology.name);
  if (!deps.interactive) {
    throw new PreflightError('test-framework-missing', `Test framework missing for ${names.join(', ')}: no test framework at ` +
      `origin/${target} enforces line, branch and function coverage of at least ${coverage}%`,
    { unprepared: names, report: analysed });
  }

  const before = deps.snapshot(root);
  const written = new Set<string>(); const left: string[] = [];
  for (const technology of unprepared) {
    const options = technology.recommendations;
    deps.say(`${technology.name} has no test framework enforcing ${coverage}% line, branch and function coverage. ` +
      'Recommendations:\n' + options.map((option, index) => `  ${index + 1}) ${option.framework}: ${option.rationale}\n`).join(''));
    const answer = (await deps.ask(`Choose 1-${options.length} or s to skip [1]: `)).trim();
    const index = answer === '' ? 0 : /^[0-9]+$/u.test(answer) && Number(answer) >= 1 && Number(answer) <= options.length ?
      Number(answer) - 1 : -1;
    if (index < 0) { deps.say(`Skipped ${technology.name}.\n`); left.push(technology.name); continue; }
    const chosen = options[index];
    const refusal = chosen.changes.map(change => refusedChange(root, change.path, project)).find(reason => reason !== null);
    if (refusal) {
      deps.say(`Refused ${chosen.framework} for ${technology.name}: ${refusal}.\n`);
      left.push(technology.name); continue;
    }
    deps.say(`${chosen.framework} for ${technology.name} runs these install commands in ${root} without a shell:\n` +
      (chosen.install.length ? chosen.install.map(step => `  ${JSON.stringify([step.command, ...step.args])}\n`).join('') : '  (none)\n') +
      'and writes these files:\n' +
      chosen.changes.map(change => `--- ${change.path}\n${change.content}${change.content.endsWith('\n') ? '' : '\n'}`).join(''));
    if (!accepted(await deps.ask('Run these commands and apply these changes? [y/N] '))) {
      deps.say(`Declined ${chosen.framework} for ${technology.name}.\n`);
      left.push(technology.name); continue;
    }
    const failedStep = chosen.install.find(step => deps.exec(step.command, step.args, root).status !== 0);
    if (failedStep) {
      deps.say(`Install command failed: ${JSON.stringify([failedStep.command, ...failedStep.args])}; ` +
        `no file changes were applied for ${technology.name}.\n`);
      left.push(technology.name); continue;
    }
    try {
      for (const change of chosen.changes) { deps.writeFile(join(root, change.path), change.content); written.add(change.path); }
    } catch (caught) {
      deps.say(`Writing the file changes for ${technology.name} failed: ${(caught as Error).message}.\n`);
      left.push(technology.name);
    }
  }

  const after = deps.snapshot(root);
  const changedFiles = [...new Set([...[...after].filter(([path, value]) => before.get(path) !== value).map(([path]) => path),
    ...written])].sort();
  const advice = `commit and push them to origin/${target}, then run again`;
  if (left.length) {
    const message = `Test framework missing for ${left.join(', ')}` +
      (changedFiles.length ? `; changed ${changedFiles.join(', ')}; ${advice}` : '');
    deps.say(message + '\n');
    throw new PreflightError('test-framework-missing', message, { unprepared: left, changedFiles });
  }
  const message = `Changed ${changedFiles.join(', ')}; ${advice}`;
  deps.say(message + '\n');
  throw new PreflightError('test-framework-prepared', message, { changedFiles });
}
