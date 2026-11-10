import { execFileSync } from 'node:child_process';
import { digest, safePath } from './model.mjs';

const runOptions = () => ({ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID'].includes(key))), CI: 'true', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
export const command = (cwd, program, args) => execFileSync(program, args, {
  ...runOptions(), cwd, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
export const gitWithInput = (cwd, input, ...args) => execFileSync('git', args, {
  ...runOptions(), cwd, input, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
export const git = (cwd, ...args) => command(cwd, 'git', args);
export function fileAt(root, revision, path) {
  return execFileSync('git', ['show', `${revision}:${path}`], {
    cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function receiptAt(root, revision, path, taskHash, authority) {
  const files = git(root, 'ls-tree', '-r', '--name-only', revision, '--', path).split('\n');
  if (!files.includes(path)) return null;
  const bytes = fileAt(root, revision, path);
  const first = git(root, 'log', '--first-parent', '--diff-filter=A', '--reverse', '--format=%H',
    revision, '--', path).split('\n')[0];
  if (!first || digest(fileAt(root, first, path)) !== digest(bytes)) throw new Error('Receipt provenance changed');
  const receipt = JSON.parse(bytes);
  if (receipt.version !== 1 || receipt.taskHash !== taskHash ||
      !receipt.authority || authority && receipt.authority !== authority || !receipt.review?.accepted ||
      !receipt.checks?.length || receipt.checks.some(check => check.outcome !== 'passed') ||
      !receipt.specification || !Object.keys(receipt.specification).length || !receipt.manifest?.length) {
    throw new Error('Invalid accepted outcome receipt');
  }
  const paths = new Set();
  for (const entry of receipt.manifest) {
    safePath(entry.path);
    if (paths.has(entry.path)) throw new Error('Duplicate receipt path');
    paths.add(entry.path);
    if (digest(fileAt(root, first, entry.path)) !== entry.hash) throw new Error('Accepted result differs from receipt');
  }
  for (const [path, expected] of Object.entries(receipt.specification)) {
    safePath(path);
    if (!paths.has(path) || digest(fileAt(root, first, path)) !== expected) {
      throw new Error('Accepted specification differs from exact binding');
    }
  }
  return receipt;
}
export class GitHubHost {
  constructor(root, project) {
    if (!project.repository) throw new Error('Explicit PR repository is required');
    this.root = root; this.project = project;
  }
  gh(...args) { return command(this.root, 'gh', [...args, '--repo', this.project.repository]); }
  find(branch) {
    const rows = JSON.parse(this.gh('pr', 'list', '--state', 'all', '--head', branch,
      '--base', this.project.target, '--json', 'number,state,headRefOid,baseRefName'));
    if (rows.length > 1) throw new Error('Multiple PRs match the outcome branch');
    return rows[0] ?? null;
  }
  create(work, body) {
    this.gh('pr', 'create', '--base', this.project.target, '--head', work.branch,
      '--title', `feat(${this.project.commitScope ?? 'work-queue'}): complete ${work.id}${this.project.commitSuffix ?? ''}`, '--body-file', body);
    return this.find(work.branch);
  }
  merge(pr, head) {
    const row = JSON.parse(this.gh('pr', 'view', String(pr.number), '--json',
      'headRefOid,baseRefName,mergeStateStatus,state,isDraft'));
    if (row.state !== 'OPEN' || row.headRefOid !== head || row.baseRefName !== this.project.target ||
        row.mergeStateStatus !== 'CLEAN' || row.isDraft) throw new Error('PR protection or identity blocks merge');
    this.gh('pr', 'merge', String(pr.number), '--merge', '--match-head-commit', head);
  }
}
