import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash } from './model.ts';
import type { BudgetExhaustion, RetryRecord, RunConfig, Work } from './model.ts';
import { compareIdentity, invocationIdentity } from './invocation-identity.ts';
import type { InvocationIdentity } from './invocation-identity.ts';
import { runnerVersion } from './runner-version.ts';

/** The legacy (schema 1) identity: the whole resolved configuration with `root` and `leaves`. */
export interface RunIdentity { leaves: string[]; [detail: string]: unknown }

export interface OperationResult { status: string; acceptanceId?: string; [detail: string]: unknown }

export interface Operation {
  id: string;
  action: unknown;
  fingerprint: string;
  status: string;
  result?: OperationResult;
}

/**
 * A blocked task: the private reason, the paths it concerns (for example unresolved conflicts), the budget that ran
 * out (when a review or check budget is exhausted) and its work.
 */
export interface BlockedEntry { reason: string; paths?: string[]; budget?: BudgetExhaustion; work: Work }

/** The record `outcome-runner dispose` leaves: when it last disposed and the unaccepted work it disposed. */
export interface DisposedRecord { at: string; tasks: Record<string, Work> }

/** A recorded change of an unfinished invocation; receipts written afterwards list them in `invocationChanges`. */
export type InvocationChange =
  | { kind: 'identity-upgraded'; from: 1; to: 2; at: string }
  | { kind: 'setting-added'; setting: string; at: string }
  | { kind: 'tasks-added'; tasks: string[]; at: string };

export interface RunState {
  version: number;
  /**
   * The version of the runner that last wrote this state. Absent in states of older runners; it is never part of the
   * identity, so a runner update never makes a resume incompatible.
   */
  runnerVersion?: string;
  /** `2` for the projected identity; absent for legacy state whose identity is the whole configuration. */
  identitySchema?: 2;
  identityHash: string;
  identity: InvocationIdentity | RunIdentity;
  /** The key of operation ids: the identity hash under which the invocation started. */
  operationKey?: string;
  /** The required settings recorded for this invocation: their dot path and the hash of their value. */
  settings?: Record<string, string>;
  changes?: InvocationChange[];
  frozen: string[];
  operations: Record<string, Operation>;
  accepted: Record<string, string>;
  status: string;
  cancelled: boolean;
  sequence: number;
  owner?: { host: string; pid: number; startedAt: string; token: string };
  claimant?: string;
  current?: Work | null;
  completed?: Record<string, Work>;
  blocked?: Record<string, BlockedEntry>;
  baselineDone?: string[];
  statisticsSources?: import('./statistics.ts').Sources;
  disposed?: DisposedRecord;
  /** Every owner retry (`--retry <task id>`) of the invocation, oldest first. */
  retries?: RetryRecord[];
}

export interface RunStoreOptions {
  repositoryRoot?: string | null;
  /** The clock of the change records; default `Date.now`. */
  now?: () => number;
  /** The runner version stamped on every write; default `runnerVersion`. */
  version?: () => string;
}

const INCOMPATIBLE = 'Run state is incompatible; reconcile it without discarding history';

/** Writes `state` to `<directory>/state.json` atomically: a synced temporary file renamed over it, then a synced directory. */
export function writeStateFile(directory: string, state: RunState): void {
  const temporary = join(directory, `state-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, join(directory, 'state.json'));
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class RunStore {
  directory: string;
  file: string;
  lock: DatabaseSync;
  state!: RunState;
  now: () => number;
  version: () => string;
  /** Whether this store created the state file. */
  created = false;

  constructor(directory: string, identity: InvocationIdentity,
    { repositoryRoot = null, now = Date.now, version = runnerVersion }: RunStoreOptions = {}) {
    this.directory = resolve(directory);
    this.now = now;
    this.version = version;
    if (!Array.isArray(identity?.leaves) || !identity.leaves.length ||
        identity.leaves.some(id => typeof id !== 'string' || !id) ||
        new Set(identity.leaves).size !== identity.leaves.length) {
      throw new Error('Run identity needs a nonempty unique frozen leaf set');
    }
    if (repositoryRoot) {
      const path = relative(resolve(repositoryRoot), this.directory);
      if (!(path === '..' || path.startsWith('../') || path.startsWith('/'))) {
        throw new Error('Run state must live outside the repository');
      }
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Run directory cannot be a symlink');
    this.directory = realpathSync(this.directory);
    if (repositoryRoot) {
      const path = relative(realpathSync(repositoryRoot), this.directory);
      if (!(path === '..' || path.startsWith('../') || path.startsWith('/'))) {
        throw new Error('Run state must live outside the repository');
      }
    }
    this.file = join(this.directory, 'state.json');
    const lockFile = join(this.directory, 'lock.sqlite');
    for (const path of [this.file, lockFile]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Unsafe run-state link');
    }
    this.lock = new DatabaseSync(lockFile);
    try {
      this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
      let opened: Partial<RunState> = {};
      if (existsSync(this.file)) {
        this.state = JSON.parse(readFileSync(this.file, 'utf8'));
        opened = this.open(identity);
      } else {
        const identityHash = hash(identity);
        this.state = { version: 2, identitySchema: 2, identityHash, identity: structuredClone(identity),
          operationKey: identityHash, frozen: [...identity.leaves], operations: {}, accepted: {},
          status: 'starting', cancelled: false, sequence: 0 };
        this.created = true;
      }
      this.update({ ...opened, owner: { host: hostname(), pid: process.pid,
        startedAt: new Date(performance.timeOrigin).toISOString(), token: randomUUID() } });
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  /**
   * Checks existing state against `next` without writing and returns the fields to update: an intact legacy identity
   * is migrated, and added tasks update the identity. Anything else incompatible throws.
   */
  private open(next: InvocationIdentity): Partial<RunState> {
    const state = this.state;
    if (state?.version !== 2 || !state.operations || typeof state.operations !== 'object' ||
        Array.isArray(state.operations) || !state.accepted || typeof state.accepted !== 'object' ||
        Array.isArray(state.accepted) || !Number.isSafeInteger(state.sequence) || typeof state.cancelled !== 'boolean' ||
        !state.identity || typeof state.identity !== 'object' || !Array.isArray(state.identity.leaves) ||
        !Array.isArray(state.frozen) || state.changes !== undefined && !Array.isArray(state.changes)) {
      throw new Error(INCOMPATIBLE);
    }
    const legacy = state.identitySchema === undefined;
    if (!legacy && state.identitySchema !== 2) throw new Error(INCOMPATIBLE);
    // The recorded identity must be intact before it is trusted.
    if (state.identityHash !== hash(state.identity) || hash(state.frozen) !== hash(state.identity.leaves)) {
      throw new Error(INCOMPATIBLE);
    }
    const stored = legacy ? invocationIdentity(state.identity as unknown as RunConfig & { leaves: string[] }) :
      state.identity as InvocationIdentity;
    const comparison = compareIdentity(stored, next);
    if (comparison.kind === 'incompatible') throw new Error(INCOMPATIBLE);
    if (!legacy && comparison.kind === 'same') return {};
    const at = new Date(this.now()).toISOString();
    const changes: InvocationChange[] = [...(state.changes ?? [])];
    if (legacy) changes.push({ kind: 'identity-upgraded', from: 1, to: 2, at });
    if (comparison.kind === 'tasks-added') changes.push({ kind: 'tasks-added', tasks: comparison.tasks, at });
    return { identitySchema: 2, identity: structuredClone(next), identityHash: hash(next), frozen: [...next.leaves],
      operationKey: state.operationKey ?? state.identityHash, changes };
  }

  /** Writes the state with `fields`, the next sequence number and the version of this runner. */
  update(fields: Partial<RunState>): RunState {
    const next = { ...this.state, ...fields, runnerVersion: this.version(), sequence: this.state.sequence + 1 };
    writeStateFile(this.directory, next);
    this.state = next;
    return next;
  }

  /**
   * Records the required settings present in the invocation (dot path to value hash). A new state records them
   * without a change; on resume, every path not recorded before appends a `setting-added` change. Values are never
   * stored.
   */
  recordSettings(present: Record<string, string>): RunState {
    const known = this.state.settings ?? {};
    if (this.created) {
      return this.state.settings && hash(known) === hash(present) ? this.state : this.update({ settings: present });
    }
    const added = Object.keys(present).filter(path => !Object.hasOwn(known, path)).sort();
    if (!added.length) return this.state;
    const at = new Date(this.now()).toISOString();
    return this.update({ settings: { ...known, ...present }, changes: [...(this.state.changes ?? []),
      ...added.map(setting => ({ kind: 'setting-added', setting, at }) as InvocationChange)] });
  }

  intend(action: unknown, fingerprint: string): Operation {
    const id = `run-${hash({ identity: this.state.operationKey ?? this.state.identityHash, action, fingerprint })}`;
    if (!this.state.operations[id]) {
      this.update({ operations: { ...this.state.operations,
        [id]: { id, action, fingerprint, status: 'intended' } } });
    }
    return this.state.operations[id];
  }

  outcome(id: string, result: OperationResult): RunState {
    const operation = this.state.operations[id];
    if (!operation) throw new Error('Outcome has no durable intent');
    const accepted = { ...this.state.accepted };
    if (result.status === 'accepted' && result.acceptanceId) accepted[result.acceptanceId] = id;
    return this.update({ operations: { ...this.state.operations,
      [id]: { ...operation, status: result.status === 'unresolved' ? 'pending' : 'resolved', result } }, accepted });
  }

  cancel(): void { this.update({ cancelled: true, status: 'cancelled' }); }
  close(): void { this.lock.close(); }
}
