import { CodexAdapter } from './codex-adapter.ts';
import { ClaudeAdapter } from './claude-adapter.ts';
import { assertSelection, defaultSelection, harnessCatalog, harnesses } from './harness-catalog.ts';
import type { Catalog } from './harness-catalog.ts';
import type { AdapterOptions, HarnessAdapter, HarnessOptions } from './harness-adapter.ts';
import { resolveCoverage } from './model.ts';
import type { Harness, ResolvedRunConfig, RunConfig } from './model.ts';

export interface CodexSelection { model?: string; effort?: string; catalog: Catalog }
interface EffectiveCodexConfig { config?: { model?: string; model_reasoning_effort?: string } }

/** Reads Codex defaults and its model catalog over one short, read-only app-server session. */
export async function codexSelection(cwd: string,
  create: (options: AdapterOptions) => CodexAdapter = options => new CodexAdapter(options)): Promise<CodexSelection> {
  const adapter = create({ cwd, tools: [], handleTool: async () => {} });
  try {
    if (adapter.probe().status !== 'interface-ready') throw new Error('Codex selection unavailable');
    await adapter.connect();
    const result = await adapter.rpc<EffectiveCodexConfig>('config/read', { includeLayers: false, cwd });
    const catalog = await adapter.models();
    return { model: result?.config?.model, effort: result?.config?.model_reasoning_effort, catalog };
  } finally { adapter.close(); }
}
export async function resolveHarness(config: RunConfig,
  readCodex: (cwd: string) => Promise<CodexSelection> = codexSelection): Promise<ResolvedRunConfig> {
  const coverage = resolveCoverage(config.coverage);
  const harness: Harness = config.harness ?? defaultSelection.harness;
  if (!harnesses.includes(harness)) throw new Error(`Unknown outcome harness ${JSON.stringify(harness)}`);
  let { model, effort } = config;
  const codex = harness === 'codex' ? await readCodex(config.root) : undefined;
  if (codex) {
    model ??= codex.model; effort ??= codex.effort;
  } else {
    model ??= defaultSelection.model; effort ??= defaultSelection.effort;
  }
  if (typeof model !== 'string' || !model || typeof effort !== 'string' || !effort) {
    throw new Error('Resolved model and effort are required');
  }
  const catalog = await harnessCatalog(harness, codex && (async () => codex.catalog));
  assertSelection(harness, catalog, model, effort);
  return { ...config, harness, model, effort, coverage };
}
export function createHarness(options: HarnessOptions, config: ResolvedRunConfig): HarnessAdapter {
  const Adapter = config.harness === 'claude' ? ClaudeAdapter : CodexAdapter;
  return new Adapter({ ...options, model: config.model, effort: config.effort });
}
