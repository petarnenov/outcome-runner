import { git } from '../../src/git.ts';

/**
 * Gives a freshly initialized repository a bare `origin` next to it and pushes one empty commit of the current
 * branch there, so that the runner's start-branch target resolution finds the branch on origin.
 */
export function publishToOrigin(root: string, branch = git(root, 'symbolic-ref', '--short', 'HEAD')): string {
  const remote = `${root}.origin.git`;
  git(root, 'init', '--bare', '-q', remote);
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty',
    '-m', 'test: initial');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return remote;
}
