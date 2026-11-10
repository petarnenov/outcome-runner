import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hash, safePath } from './model.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('/');
};
export const brokerTool = {
  type: 'function', name: 'backlog_tool',
  description: 'Read or write an authorized file; no command execution or human interaction.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { operation: { type: 'string' }, input: { type: 'object' } },
    required: ['operation', 'input'] },
};

export class CodexFiles {
  constructor({ root, scopes, store, identity, revalidate }) {
    this.root = realpathSync(root); this.scopes = scopes; this.store = store;
    this.identity = identity; this.revalidate = revalidate;
  }

  path(path, write = false) {
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

  async call(name, request) {
    if (name !== 'backlog_tool' || !request || typeof request.input !== 'object') {
      throw new Error('Unknown broker request');
    }
    if (await this.revalidate(this.identity) !== true) throw new Error('Owner or authority changed');
    const { operation, input } = request;
    if (operation === 'read_file') {
      const target = this.path(input.path);
      return existsSync(target) ? { content: readFileSync(target, 'utf8'),
        hash: digest(readFileSync(target)) } : { content: null, hash: null };
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
