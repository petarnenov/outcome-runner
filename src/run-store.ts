import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash } from './model.ts';
import type { Work } from './model.ts';

export interface RunIdentity { leaves: string[]; [detail: string]: unknown }

export interface OperationResult { status: string; acceptanceId?: string; [detail: string]: unknown }

export interface Operation {
  id: string;
  action: unknown;
  fingerprint: string;
  status: string;
  result?: OperationResult;
}

export interface BlockedEntry { reason: string; work: Work }

/** The record `outcome-runner dispose` leaves: when it last disposed and the unaccepted work it disposed. */
export interface DisposedRecord { at: string; tasks: Record<string, Work> }

export interface RunState {
  version: number;
  identityHash: string;
  identity: RunIdentity;
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
}

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

  constructor(directory: string, identity: RunIdentity,
    { repositoryRoot = null }: { repositoryRoot?: string | null } = {}) {
    this.directory = resolve(directory);
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
      if (existsSync(this.file)) {
        this.state = JSON.parse(readFileSync(this.file, 'utf8'));
        if (this.state.version !== 2 || this.state.identityHash !== hash(identity) ||
            !this.state.operations || Array.isArray(this.state.operations) ||
            !this.state.accepted || Array.isArray(this.state.accepted) ||
            hash(this.state.frozen) !== hash(identity.leaves) ||
            !Number.isSafeInteger(this.state.sequence) || typeof this.state.cancelled !== 'boolean') {
          throw new Error('Run state is incompatible; reconcile it without discarding history');
        }
      } else {
        this.state = { version: 2, identityHash: hash(identity), identity: structuredClone(identity),
          frozen: [...identity.leaves], operations: {}, accepted: {},
          status: 'starting', cancelled: false, sequence: 0 };
      }
      this.update({ owner: { host: hostname(), pid: process.pid,
        startedAt: new Date(performance.timeOrigin).toISOString(), token: randomUUID() } });
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  update(fields: Partial<RunState>): RunState {
    const next = { ...this.state, ...fields, sequence: this.state.sequence + 1 };
    writeStateFile(this.directory, next);
    this.state = next;
    return next;
  }

  intend(action: unknown, fingerprint: string): Operation {
    const id = `run-${hash({ identity: this.state.identityHash, action, fingerprint })}`;
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
