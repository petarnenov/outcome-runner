import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { release } from './release.ts';

export function command(cwd: string, program: string, args: string[]): string {
  return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
type Hooks = {
  validate?: (cwd: string) => void;
  push?: (cwd: string, tag: string) => void;
  notes?: (cwd: string, tag: string, section: string) => void;
  inspect?: (cwd: string, tag: string) => string;
};
export function validate(cwd: string): void {
  for (const args of [['ci'], ['run', 'typecheck'], ['test']]) command(cwd, 'npm', args);
}
export function atomicPush(cwd: string, tag: string): void {
  command(cwd, 'git', ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/' + tag]);
}

/** Each invocation owns a disposable clone; the caller's checkout and tags are untouched. */
export function publish(cwd: string, hooks: Hooks = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-release-'));
  const work = join(root, 'checkout');
  const git = (...args: string[]) => command(work, 'git', args);
  try {
    const remote = command(cwd, 'git', ['remote', 'get-url', 'origin']);
    command(cwd, 'git', ['clone', '--no-checkout', '--no-local', remote, work]);
    for (const key of ['user.name', 'user.email']) {
      git('config', key, command(cwd, 'git', ['config', key]));
    }
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    for (let attempt = 1; attempt <= 3; attempt++) {
      git('fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', '--tags');
      const base = git('rev-parse', 'refs/remotes/origin/main');
      git('checkout', '--detach', base);
      (hooks.validate ?? validate)(work);
      const output = release(work);
      if (output === 'no release\n') return output;
      const split = output.indexOf('\n');
      const tag = 'v' + output.slice(0, split);
      const section = output.slice(split + 1);
      const commit = git('rev-parse', 'HEAD');
      const object = git('rev-parse', 'refs/tags/' + tag);
      try {
        (hooks.push ?? atomicPush)(work, tag);
      } catch (error) {
        let refs: Map<string, string>;
        try {
          const listing = (hooks.inspect ?? ((dir, name) => command(dir, 'git',
            ['ls-remote', 'origin', 'refs/heads/main', 'refs/tags/' + name, 'refs/tags/' + name + '^{}'])))(work, tag);
          refs = new Map(listing.split('\n').filter(Boolean).map(line => {
            const [oid, ref] = line.split(/\s+/);
            return [ref, oid];
          }));
          if (!refs.has('refs/heads/main')) throw new Error('Missing main');
        } catch {
          throw new Error('Publication uncertain; inspect remote main and tag before recovery. ' + String(error));
        }
        const head = refs.get('refs/heads/main')!;
        const publishedTag = refs.get('refs/tags/' + tag);
        // A transport error may follow an accepted push. Confirm both refs, including
        // a later descendant of the generated release, before creating notes.
        git('fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main');
        const contains = (ancestor: string, descendant: string): boolean => {
          try { git('merge-base', '--is-ancestor', ancestor, descendant); return true; }
          catch { return false; }
        };
        if (publishedTag === object && contains(commit, head)) {
          // Confirmed publication: do not generate a second release.
        } else {
          if (publishedTag === object || contains(commit, head)) {
            throw new Error('Publication uncertain; inspect partial remote refs before recovery.');
          }
          const rejection = String(error) + String((error as { stderr?: unknown }).stderr ?? '');
          if (head === base || !contains(base, head) || !/rejected|non-fast-forward|fetch first/i.test(rejection)) {
            throw new Error('Publication rejected without recoverable main advancement; inspect remote and rerun a fresh validated release. ' + rejection);
          }
          // Delete only the owned unpublished object in this disposable clone.
          git('update-ref', '-d', 'refs/tags/' + tag, object);
          if (attempt === 3) throw new Error('Release exhausted three total attempts; inspect current main and run a fresh validated release.');
          continue;
        }
      }
      try {
        if (hooks.notes) hooks.notes(work, tag, section);
        else {
          const file = join(root, 'notes.md');
          writeFileSync(file, section);
          command(work, 'gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', file]);
        }
      } catch (error) {
        throw new Error('Published ' + tag + '; restore only missing GitHub Release notes, never move the tag. ' + String(error));
      }
      return output;
    }
    throw new Error('Release attempt budget exhausted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { process.stdout.write(publish(process.cwd())); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
