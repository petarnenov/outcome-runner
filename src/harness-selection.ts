import { cancellable } from './statistics.ts';
import type { Setting, Settings, Source, Sources } from './statistics.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import { ClaudeAdapter } from './claude-adapter.ts';
import { CodexAdapter } from './codex-adapter.ts';
import { claudeCatalog, defaultSelection, harnesses } from './harness-catalog.ts';
import type { Catalog } from './harness-catalog.ts';
import { codexSelection } from './harness.ts';
import type { CodexSelection } from './harness.ts';
import { isInteractive, promptOn } from './openspec-preflight.ts';
import type { AdapterOptions, ToolDefinition } from './harness-adapter.ts';
import type { Harness, RunConfig } from './model.ts';

export type Availability =
  { harness: Harness; available: true; version: string } |
  { harness: Harness; available: false; reason: string; version?: string };

export interface Selection { harness: Harness; model: string; effort: string; coverage: number; statisticsSources?: Sources }

export interface SelectionDeps {
  /** True only when both stdin and stderr are TTYs, as in the OpenSpec preflight. */
  interactive: boolean;
  /** Asks one question on stderr and resolves with the answer line ('' when stdin closes). */
  ask: (question: string) => Promise<string>;
  /** Writes harness statuses, choices and corrections to stderr. */
  say: (text: string) => void;
  /** Checks one harness with its existing version probe; never throws. */
  probe: (harness: Harness) => Availability;
  /** Reads Codex defaults and catalog; called at most once per start and only for Codex. */
  readCodex: (cwd: string) => Promise<CodexSelection>;
  /** Returns the selection recorded in an existing invocation state, or null. */
  signal?: AbortSignal;
  sources?: Sources;
  onSetting?: (key: Setting, value: Settings[Setting]['value'], source: Source) => void;
  onResolved?: (config: RunConfig, sources: Sources, version?: string) => void;
  recorded: (stateDirectory: string) => Partial<Selection> | null;
}

export interface SelectionResult {
  config: RunConfig;
  /** The Codex read of this start; set exactly when the selected harness is codex. */
  codex?: CodexSelection;
}

/** A startup refusal reported with exit code 4 and diagnostics reason `harness-unavailable`. */
export class HarnessUnavailableError extends Error {
  reason = 'harness-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'HarnessUnavailableError';
  }
}

export const DEFAULT_COVERAGE = 85;
const probeTool: ToolDefinition = { type: 'function', name: 'probe', description: 'Version probe only.',
  inputSchema: { type: 'object' } };

/**
 * Runs the existing adapter version probe for one harness. A missing executable is `not-installed`,
 * any other probe failure is `probe-failed`; the probe never fails the run by itself.
 */
export function probeHarness(harness: Harness, executable?: string): Availability {
  const options: AdapterOptions = { cwd: process.cwd(), tools: [probeTool], handleTool: async () => ({}),
    ...(executable ? { executable } : {}) };
  try {
    const result = (harness === 'claude' ? new ClaudeAdapter(options) : new CodexAdapter(options)).probe();
    if (result.status === 'interface-ready') return { harness, available: true, version: result.version ?? '' };
    return { harness, available: false, reason: result.reason ?? 'unavailable',
      ...(result.version ? { version: result.version } : {}) };
  } catch (error) {
    return { harness, available: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'probe-failed' };
  }
}

/** Reads `<stateDirectory>/state.json` read-only; the selection counts only when all four fields are recorded. */
export function recordedSelection(stateDirectory: string): Partial<Selection> | null {
  if (!stateDirectory) return null;
  const file = join(stateDirectory, 'state.json');
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const identity = state?.identity ?? {};
    const { harness, model, effort, coverage } = identity as Record<string, unknown>;
    if (typeof harness !== 'string' || typeof model !== 'string' || typeof effort !== 'string' ||
        typeof coverage !== 'number') return null;
    return { harness: harness as Harness, model, effort, coverage,
      ...(state.statisticsSources ? { statisticsSources: state.statisticsSources } : {}) };
  } catch {
    // Advisory only: the run store still decides whether the state is compatible.
    return null;
  }
}

export function defaultSelectionDeps(): SelectionDeps {
  return {
    interactive: isInteractive({ isTTY: isatty(0) }, { isTTY: isatty(2) }),
    ask: question => promptOn(process.stdin, process.stderr)(question),
    say: text => { process.stderr.write(text); },
    probe: probeHarness,
    readCodex: codexSelection,
    recorded: recordedSelection,
  };
}

export const describeAvailability = (status: Availability): string => status.available ?
  `${status.harness}: available (${status.version})` :
  `${status.harness}: unavailable (${status.reason}${status.version ? `, ${status.version}` : ''})`;

const refusalList = (statuses: Availability[]): string => statuses.map(status => status.available ?
  `${status.harness}: available (${status.version})` :
  `${status.harness}: ${status.reason}${status.version ? ` (${status.version})` : ''}`).join('; ');

/** The Codex default model: its configured model, else the model/list default, else the first catalog model. */
export function codexDefaultModel(codex: CodexSelection, models: readonly string[]): string | undefined {
  return [codex.model, codex.defaultModel].find(model => model !== undefined && models.includes(model)) ?? models[0];
}

/** `medium` when supported, else the model's default effort, else the configured effort, else the first listed. */
export function defaultEffort(efforts: readonly string[], model: string, codex?: CodexSelection): string | undefined {
  return ['medium', codex?.defaultEfforts?.get(model), codex?.effort]
    .find(effort => effort !== undefined && efforts.includes(effort)) ?? efforts[0];
}

/**
 * Checks both harnesses and decides harness, model, effort and coverage: given flag/JSON values first,
 * then a recorded selection on restart, then interactive answers or the non-interactive defaults.
 * Only an absent coverage counts as not given; any other value is left to harness resolution to validate.
 */
export async function selectHarness(config: RunConfig, overrides: Partial<SelectionDeps> = {}): Promise<SelectionResult> {
  const deps: SelectionDeps = { ...defaultSelectionDeps(), ...overrides };
  if (!overrides.ask) deps.ask = question => promptOn(process.stdin, process.stderr, deps.signal)(question);
  if (!overrides.readCodex) deps.readCodex = cwd => codexSelection(cwd, undefined, deps.signal);
  deps.signal?.throwIfAborted();
  const statuses = harnesses.map(harness => deps.probe(harness));
  const available = statuses.filter(status => status.available).map(status => status.harness);
  if (deps.interactive) deps.say(statuses.map(status => `${describeAvailability(status)}\n`).join(''));
  const refuse = (prefix: string): never => { throw new HarnessUnavailableError(`${prefix}: ${refusalList(statuses)}`); };

  const selected: RunConfig = { ...config };
  const sources: Sources = { ...deps.sources };
  for (const key of ['harness', 'model', 'effort', 'coverage', 'maxAccepted', 'leaves'] as const) {
    sources[key] ??= config[key] !== undefined ? 'invocation-json' : 'default';
  }
  const recorded = deps.recorded(config.stateDirectory);
  if (recorded) {
    // Saved provenance is advisory metadata, never part of frozen config identity.
    Object.assign(sources, recorded.statisticsSources ?? Object.fromEntries(
      ['harness', 'model', 'effort', 'coverage', 'maxAccepted', 'leaves'].map(key => [key, 'default'])));
    selected.harness ??= recorded.harness; selected.model ??= recorded.model; selected.effort ??= recorded.effort;
    if (selected.coverage === undefined) selected.coverage = recorded.coverage;
  }
  const observe = (key: Setting, value: Settings[Setting]['value']) =>
    deps.onSetting?.(key, value, (key === 'harnessCliVersion' ? sources.harness : sources[key]) ?? 'default');
  const prompting = deps.interactive && !recorded;
  const choose = async (label: 'Harness' | 'Model' | 'Effort', options: readonly string[], preselected: string): Promise<string> => {
    deps.say(`${label} options: ${options.map((option, index) => `${index + 1}) ${option}`).join('  ')}\n`);
    for (;;) {
      const answer = (await cancellable(deps.ask(`${label} [${preselected}]: `), deps.signal)).trim();
      const key = label.toLowerCase() as 'harness' | 'model' | 'effort';
      sources[key] = answer ? 'interactive-answer' : 'default';
      const chosen = !answer ? preselected : options.includes(answer) ? answer :
        /^\d+$/u.test(answer) && Number(answer) >= 1 && Number(answer) <= options.length ? options[Number(answer) - 1] : undefined;
      if (chosen !== undefined) { observe(key, chosen); return chosen; }
      deps.say(`Choose one of ${options.join(', ')} or press Enter for ${preselected}.\n`);
    }
  };

  if (!available.length) refuse('No available harness');
  if (selected.harness == null) {
    selected.harness = prompting ?
      await choose('Harness', available, available.includes('claude') ? 'claude' : available[0]) as Harness :
      defaultSelection.harness;
  }
  // An unknown harness name is left to harness resolution, which names it in its refusal.
  if (!harnesses.includes(selected.harness)) return { config: selected };
  if (!available.includes(selected.harness)) refuse(`Harness ${selected.harness} is unavailable`);

  observe('harness', selected.harness);
  const observed = statuses.find(status => status.harness === selected.harness);
  if (observed?.version !== undefined) observe('harnessCliVersion', observed.version);
  deps.onResolved?.(selected, sources, observed?.version);
  const codex = selected.harness === 'codex' ? await cancellable(deps.readCodex(config.root), deps.signal) : undefined;
  const catalog: Catalog = codex ? codex.catalog : claudeCatalog;
  if (prompting && selected.model === undefined) {
    const models = [...catalog.keys()];
    const preselected = codex ? codexDefaultModel(codex, models) : defaultSelection.model;
    if (preselected !== undefined) selected.model = await choose('Model', models, preselected);
  }
  if (selected.model && catalog.has(selected.model)) observe('model', selected.model);
  const efforts = selected.model === undefined ? undefined : catalog.get(selected.model);
  if (prompting && selected.effort === undefined && efforts?.length) {
    selected.effort = await choose('Effort', efforts, defaultEffort(efforts, selected.model!, codex)!);
  }
  if (selected.effort && efforts?.includes(selected.effort)) observe('effort', selected.effort);
  if (prompting && selected.coverage === undefined) {
    for (;;) {
      const answer = (await cancellable(deps.ask(`Coverage threshold (1-100) [${DEFAULT_COVERAGE}]: `), deps.signal)).trim();
      sources.coverage = answer ? 'interactive-answer' : 'default';
      if (!answer) { selected.coverage = DEFAULT_COVERAGE; break; }
      if (/^\d+$/u.test(answer) && Number(answer) >= 1 && Number(answer) <= 100) { selected.coverage = Number(answer); break; }
      deps.say('Coverage must be an integer from 1 to 100.\n');
    }
  }
  if (!codex) { selected.model ??= defaultSelection.model; selected.effort ??= defaultSelection.effort; }
  if (selected.coverage === undefined) selected.coverage = DEFAULT_COVERAGE;
  if (selected.model && catalog.has(selected.model)) observe('model', selected.model);
  if (selected.effort && selected.model && catalog.get(selected.model)?.includes(selected.effort)) observe('effort', selected.effort);
  if (Number.isInteger(selected.coverage) && selected.coverage >= 1 && selected.coverage <= 100) observe('coverage', selected.coverage);
  deps.onResolved?.(selected, sources, observed?.version);
  return codex ? { config: selected, codex } : { config: selected };
}
