import { CodexAdapter } from './codex-adapter.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';

export async function codexDefaults(cwd, create = options => new CodexAdapter(options)) {
  const adapter = create({ cwd, tools: [], handleTool: async () => {} });
  try {
    if (adapter.probe().status !== 'interface-ready') throw new Error('Codex defaults unavailable');
    await adapter.connect();
    const result = await adapter.rpc('config/read', { includeLayers: false, cwd });
    return { model: result.config?.model, effort: result.config?.model_reasoning_effort };
  } finally { adapter.close(); }
}
export async function resolveHarness(config, readDefaults = codexDefaults) {
  const harness = config.harness ?? 'claude';
  if (!['claude', 'codex'].includes(harness)) throw new Error('Unknown outcome harness');
  let { model, effort } = config;
  if (harness === 'claude') {
    model ??= 'claude-opus-5-5'; effort ??= 'medium';
    if (model !== 'claude-opus-5-5' || effort !== 'medium') throw new Error('Claude requires Opus 5.5 medium');
  } else if (!model || !effort) {
    const defaults = await readDefaults(config.root); model ??= defaults.model; effort ??= defaults.effort;
  }
  if (typeof model !== 'string' || !model || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error('Resolved model and effort are required');
  }
  return { ...config, harness, model, effort };
}
export function createHarness(options, config) {
  const Adapter = config.harness === 'claude' ? ClaudeAdapter : CodexAdapter;
  return new Adapter({ ...options, model: config.model, effort: config.effort });
}
