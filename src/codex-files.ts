import { closeSync, createReadStream, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import { hash, safePath } from './model.ts';
import { pageOffset, readPage } from './text-page.ts';
import type { RunStore } from './run-store.ts';
import type { ToolDefinition, ToolInput } from './harness-adapter.ts';

export interface FileScope { path: string; mode: string }

interface CodexFilesOptions<Identity> {
  root: string;
  scopes: FileScope[];
  store: RunStore;
  identity: Identity;
  revalidate: (identity: Identity) => Promise<boolean>;
}

const digest = (value: BinaryLike): string => createHash('sha256').update(value).digest('hex');
async function fileDigest(path: string): Promise<string> {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest('hex');
}
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('/');
};
export const brokerTool: ToolDefinition = {
  type: 'function', name: 'backlog_tool',
  description: 'Read or write an authorized file; no command execution or human interaction.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { operation: { type: 'string' }, input: { type: 'object' } },
    required: ['operation', 'input'] },
};

export class CodexFiles<Identity = unknown> {
  root: string;
  scopes: FileScope[];
  store: RunStore;
  identity: Identity;
  revalidate: (identity: Identity) => Promise<boolean>;

  constructor({ root, scopes, store, identity, revalidate }: CodexFilesOptions<Identity>) {
    this.root = realpathSync(root); this.scopes = scopes; this.store = store;
    this.identity = identity; this.revalidate = revalidate;
  }

  path(path: string, write = false): string {
    safePath(path);
    if (!this.scopes.some(scope => (!write || scope.mode === 'write') &&
      (path === scope.path || path.startsWith(`${scope.path}/`)))) throw new Error('Path outside reserved scope');
    const target = join(this.root, path);
    let component = this.root;
    for (const part of path.split('/')) {
      component = join(component, part);
      if (existsSync(component) && lstatSync(component).isSymbolicLink()) {
        throw new Error('Scoped paths cannot traverse symlinks');
      }
    }
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!inside(this.root, realpathSync(ancestor))) throw new Error('Path escapes the worktree');
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe scoped file');
    }
    return target;
  }

  async call(name: string, request: ToolInput) {
    if (name !== 'backlog_tool' || !request || typeof request.input !== 'object') {
      throw new Error('Unknown broker request');
    }
    if (await this.revalidate(this.identity) !== true) throw new Error('Owner or authority changed');
    const { operation } = request; const input = request.input!;
    if (operation === 'read_file') {
      const target = this.path(input.path);
      const offset = pageOffset(input.offset);
      if (!existsSync(target)) return { content: null, hash: null };
      return { ...await readPage(createReadStream(target), offset), hash: await fileDigest(target) };
    }
    if (operation === 'write_file') {
      if (typeof input.content !== 'string' || input.content.length > 4 * 1024 * 1024 ||
          input.expectedHash !== null && !/^[a-f0-9]{64}$/u.test(input.expectedHash ?? '')) {
        throw new Error('Write requires bounded content and expected prior hash');
      }
      const target = this.path(input.path, true);
      const contentHash = digest(input.content);
      const op = this.store.intend({ tool: operation, identity: this.identity,
        path: input.path, contentHash, expectedHash: input.expectedHash }, hash(input));
      const existing = existsSync(target) ? digest(readFileSync(target)) : null;
      if (existing !== contentHash) {
        if (existing !== input.expectedHash) throw new Error('Scoped file changed before write');
        mkdirSync(dirname(target), { recursive: true });
        this.path(input.path, true);
        const temporary = join(dirname(target), `.backlog-${randomUUID()}.tmp`);
        const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o644;
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, input.content); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, target);
        const dir = openSync(dirname(target), 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      const result = { status: 'completed', path: input.path, contentHash };
      this.store.outcome(op.id, result);
      return result;
    }
    throw new Error('Unknown fixed operation');
  }
}
