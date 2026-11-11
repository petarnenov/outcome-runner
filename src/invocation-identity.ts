import { hash } from './model.ts';
import type { CommandSpec, Harness, RunConfig } from './model.ts';

/** The version of the identity projection; a new identity field needs a new schema and a migration. */
export const IDENTITY_SCHEMA = 2;

/**
 * What the owner authorised for an invocation. Runner defaults (such as the archive command), operational settings
 * (`maxAccepted`, `commitScope`, `commitSuffix`, `repository`, `mode`, `stateDirectory`) and settings a newer runner
 * adds are never part of it. `harness`, `model`, `effort` and `coverage` stay at the top level, where
 * `recordedSelection` reads them.
 */
export interface InvocationIdentity {
  schema: 2;
  invocation: string;
  root: string;
  authority: { reference: string; instruction: string; target: string; tasks: Record<string, string> };
  project: { target: string; queue: string; changes: string; receipts: string;
    checks: CommandSpec[]; planningCheck: CommandSpec; setup: CommandSpec[] };
  harness: Harness; model: string; effort: string; coverage: number;
  leaves: string[];
}

/** The schema 2 identity of a resolved configuration with its repository root and leaves. */
export function invocationIdentity(config: RunConfig & { leaves: string[] }): InvocationIdentity {
  const { authority, project } = config;
  return structuredClone({
    schema: IDENTITY_SCHEMA as 2,
    invocation: config.invocation,
    root: config.root,
    authority: { reference: authority?.reference, instruction: authority?.instruction, target: authority?.target,
      tasks: authority?.tasks },
    project: { target: project?.target, queue: project?.queue, changes: project?.changes, receipts: project?.receipts,
      checks: project?.checks, planningCheck: project?.planningCheck, setup: project?.setup ?? [] },
    harness: config.harness!, model: config.model!, effort: config.effort!, coverage: config.coverage!,
    leaves: config.leaves,
  });
}

export type IdentityComparison = { kind: 'same' } | { kind: 'tasks-added'; tasks: string[] } | { kind: 'incompatible' };

/**
 * `same` for equal identities; `tasks-added` when only tasks or leaves were added (every stored task keeps its hash
 * and every stored leaf stays); `incompatible` for anything else.
 */
export function compareIdentity(stored: InvocationIdentity, next: InvocationIdentity): IdentityComparison {
  if (hash(stored) === hash(next)) return { kind: 'same' };
  const rest = (identity: InvocationIdentity) => ({ ...identity, leaves: [],
    authority: { ...identity?.authority, tasks: {} } });
  if (hash(rest(stored)) !== hash(rest(next))) return { kind: 'incompatible' };
  const storedTasks = stored.authority?.tasks ?? {}; const nextTasks = next.authority?.tasks ?? {};
  const storedLeaves = stored.leaves ?? []; const nextLeaves = next.leaves ?? [];
  if (Object.entries(storedTasks).some(([id, taskHash]) => !Object.hasOwn(nextTasks, id) || nextTasks[id] !== taskHash) ||
      storedLeaves.some(leaf => !nextLeaves.includes(leaf))) return { kind: 'incompatible' };
  const tasks = [...new Set([...Object.keys(nextTasks).filter(id => !Object.hasOwn(storedTasks, id)),
    ...nextLeaves.filter(leaf => !storedLeaves.includes(leaf))])].sort();
  return tasks.length ? { kind: 'tasks-added', tasks } : { kind: 'incompatible' };
}

/** A setting a runner requires in the invocation file: its dot path and an example value. */
export interface RequiredSetting { path: string; example: unknown }

/** The settings this runner requires; it declares none. */
export const REQUIRED_SETTINGS: readonly RequiredSetting[] = [];

/** The value at a dot-separated path, or `undefined`. */
export function settingAt(config: unknown, path: string): unknown {
  let value: unknown = config;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The first required setting whose value is `undefined` in `config`. */
export function missingSetting(config: unknown, required: readonly RequiredSetting[]): RequiredSetting | undefined {
  return required.find(setting => settingAt(config, setting.path) === undefined);
}

/** `{ a: { b: example } }` for the path `a.b`. */
const nested = (path: string, example: unknown): unknown =>
  path.split('.').reduceRight<unknown>((value, key) => ({ [key]: value }), example);

/** A refusal (exit code 4) naming the setting the invocation lacks and an example of it. */
export class MissingSettingError extends Error {
  reason = 'missing-setting' as const;
  setting: string;
  example: unknown;
  constructor({ path, example }: RequiredSetting) {
    super(`The invocation lacks the setting ${path} that this runner requires; add it, for example ` +
      JSON.stringify(nested(path, example)));
    this.name = 'MissingSettingError';
    this.setting = path;
    this.example = example;
  }
}
