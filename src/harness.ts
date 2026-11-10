import { CodexAdapter } from './codex-adapter.ts';
import { ClaudeAdapter } from './claude-adapter.ts';
import type { AdapterOptions, HarnessAdapter, HarnessOptions } from './harness-adapter.ts';
import type { Harness, ResolvedRunConfig, RunConfig } from './model.ts';

interface CodexDefaults { model?: string; effort?: string }
interface EffectiveCodexConfig { config?: { model?: string; model_reasoning_effort?: string } }

export async function codexDefaults(cwd: string,
  create: (options: AdapterOptions) => CodexAdapter = options => new CodexAdapter(options)): Promise<CodexDefaults> {
  const adapter = create({ cwd, tools: [], handleTool: async () => {} });
  try {
    if (adapter.probe().status !== 'interface-ready') throw new Error('Codex defaults unavailable');
    await adapter.connect();
    const result = await adapter.rpc<EffectiveCodexConfig>('config/read', { includeLayers: false, cwd });
    return { model: result.config?.model, effort: result.config?.model_reasoning_effort };
  } finally { adapter.close(); }
}
export async function resolveHarness(config: RunConfig,
  readDefaults: (cwd: string) => Promise<CodexDefaults> = codexDefaults): Promise<ResolvedRunConfig> {
  const harness: Harness = config.harness ?? 'claude';
  if (!['claude', 'codex'].includes(harness)) throw new Error('Unknown outcome harness');
  let { model, effort } = config;
  if (harness === 'claude') {
    model ??= 'claude-opus-5-5'; effort ??= 'medium';
    if (model !== 'claude-opus-5-5' || effort !== 'medium') throw new Error('Claude requires Opus 5.5 medium');
  } else if (!model || !effort) {
    const defaults = await readDefaults(config.root); model ??= defaults.model; effort ??= defaults.effort;
  }
  if (typeof model !== 'string' || !model || !effort || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error('Resolved model and effort are required');
  }
  return { ...config, harness, model, effort };
}
export function createHarness(options: HarnessOptions, config: ResolvedRunConfig): HarnessAdapter {
  const Adapter = config.harness === 'claude' ? ClaudeAdapter : CodexAdapter;
  return new Adapter({ ...options, model: config.model, effort: config.effort });
}
