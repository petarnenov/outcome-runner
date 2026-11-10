import type { Harness } from './model.ts';

/** Model identifier mapped to the efforts that model supports. */
export type Catalog = ReadonlyMap<string, readonly string[]>;
export type CatalogRpc = <Result>(method: string, params: object) => Promise<Result>;

interface CodexModelEntry {
  id?: unknown;
  model?: unknown;
  hidden?: unknown;
  supportedReasoningEfforts?: { reasoningEffort?: unknown }[];
}
interface CodexModelPage { data?: CodexModelEntry[]; nextCursor?: unknown }

export const harnesses: readonly Harness[] = ['claude', 'codex'];
export const defaultSelection = { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' } as const;
/** Values accepted by `claude --effort`. */
export const claudeEfforts: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Exact Claude model IDs; update together with the runner when Claude Code accepts new IDs. */
export const claudeModels: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
export const claudeCatalog: Catalog = new Map(claudeModels.map((model): [string, readonly string[]] => [model, claudeEfforts]));

/** Reads every visible Codex model and its reasoning efforts through the app-server RPC `model/list`. */
export async function codexCatalog(rpc: CatalogRpc): Promise<Catalog> {
  const catalog = new Map<string, string[]>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await rpc<CodexModelPage>('model/list', cursor === undefined ?
      { includeHidden: false } : { cursor, includeHidden: false });
    if (!page || typeof page !== 'object' || !Array.isArray(page.data)) throw new Error('Malformed Codex model/list page');
    for (const entry of page.data) {
      if (entry?.hidden === true) continue;
      const id = entry?.model ?? entry?.id;
      if (typeof id !== 'string' || !id) throw new Error('Malformed Codex model/list entry');
      const efforts = (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [])
        .map(option => option?.reasoningEffort)
        .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0);
      catalog.set(id, [...new Set([...(catalog.get(id) ?? []), ...efforts])]);
    }
    const next = page.nextCursor;
    if (next === undefined || next === null || next === '') return catalog;
    if (typeof next !== 'string' || cursors.has(next)) throw new Error('Codex model/list returned an invalid or repeated cursor');
    cursors.add(next); cursor = next;
  }
}

export async function harnessCatalog(harness: Harness, codex?: () => Promise<Catalog>): Promise<Catalog> {
  if (harness === 'claude') return claudeCatalog;
  if (harness === 'codex' && codex) return codex();
  if (harness === 'codex') throw new Error('Codex catalog requires an app-server session');
  throw new Error(`Unknown outcome harness ${JSON.stringify(harness)}`);
}

export function assertSelection(harness: Harness, catalog: Catalog, model: string, effort: string): void {
  const efforts = catalog.get(model);
  if (!efforts) throw new Error(`Model ${JSON.stringify(model)} is not offered by harness ${harness}`);
  if (!efforts.includes(effort)) {
    throw new Error(`Effort ${JSON.stringify(effort)} is not supported by model ${JSON.stringify(model)} of harness ${harness}`);
  }
}
