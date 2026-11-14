import { fileAt, git } from './git.ts';
import type { MergeEligibility } from './git.ts';
import { hash } from './model.ts';

/** How long the merge stage waits for pending required checks before it blocks with `merge-not-eligible`. */
export const MERGE_ELIGIBILITY_WAIT_MS = 30 * 60 * 1000;
/** The default delay between two pull request views while required checks are pending. */
export const MERGE_ELIGIBILITY_POLL_MS = 15000;

/** The merge status of a pull request that can be merged now. */
export const CLEAN = 'CLEAN';
/** The merge status of a pull request whose branch is behind the target. */
export const BEHIND = 'BEHIND';
/** The eligibility of a host that does not report one. */
export const ELIGIBLE: MergeEligibility = Object.freeze({ status: CLEAN, checks: [] });

/**
 * `eligible`: merge now. `behind`: catch up with the target. `pending`: wait for required checks. `failed`: a
 * required check failed or was cancelled. `refused`: a status that waiting cannot fix.
 */
export type EligibilityClass = 'eligible' | 'behind' | 'pending' | 'failed' | 'refused';

/** The statuses that may still become `CLEAN` while required checks finish. */
const WAITABLE: readonly string[] = ['BLOCKED', 'UNSTABLE', 'UNKNOWN'];

/**
 * Classifies a merge eligibility, first match wins: `CLEAN` is eligible, `BEHIND` behind; `BLOCKED`, `UNSTABLE` or
 * `UNKNOWN` with a failed or cancelled required check is failed (the sorted names of those checks), with a pending
 * one pending (the sorted pending names); `UNKNOWN` without either is pending with no checks; anything else is
 * refused.
 */
export function classifyEligibility({ status, checks }: MergeEligibility): { kind: EligibilityClass; checks: string[] } {
  if (status === CLEAN) return { kind: 'eligible', checks: [] };
  if (status === BEHIND) return { kind: 'behind', checks: [] };
  if (WAITABLE.includes(status)) {
    const names = (buckets: string[]): string[] => [...new Set((checks ?? [])
      .filter(check => buckets.includes(check.bucket)).map(check => check.name))].sort();
    const failed = names(['fail', 'cancel']);
    if (failed.length) return { kind: 'failed', checks: failed };
    const pending = names(['pending']);
    if (pending.length) return { kind: 'pending', checks: pending };
    if (status === 'UNKNOWN') return { kind: 'pending', checks: [] };
  }
  return { kind: 'refused', checks: [] };
}

/** A task blocked because its pull request cannot become mergeable: the last status and the failed or pending checks. */
export class MergeNotEligible extends Error {
  status: string;
  checks: string[];
  constructor(status: string, checks: string[] = []) {
    super('merge-not-eligible');
    this.name = 'MergeNotEligible';
    this.status = status;
    this.checks = [...checks];
  }
}

/** The subject `scripts/release.ts` writes for a release commit. */
const RELEASE_SUBJECT = /^chore\(release\): v\d+\.\d+\.\d+$/u;
const RELEASE_PATHS: readonly string[] = ['package.json', 'package-lock.json', 'CHANGELOG.md'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** `package.json` without its top-level `version`. */
const withoutVersion = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  const { version: _version, ...rest } = value;
  return rest;
};
/** `package-lock.json` without its top-level `version` and `packages[""].version`. */
const withoutLockVersions = (value: unknown): unknown => {
  const rest = withoutVersion(value);
  if (!isObject(rest) || !isObject(rest.packages) || !isObject(rest.packages[''])) return rest;
  return { ...rest, packages: { ...rest.packages, '': withoutVersion(rest.packages['']) } };
};
const STRIP: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  'package.json': withoutVersion, 'package-lock.json': withoutLockVersions });

/**
 * Whether the target advanced from `from` to `to` only by release commits: `from` is a proper ancestor of `to`,
 * every commit between them is a non-merge commit with a `chore(release): vX.Y.Z` subject, and the changed paths
 * are only `package.json` and `package-lock.json` (differing only in their version fields) and `CHANGELOG.md`.
 * Any Git or JSON error gives false, so the advance then counts toward the attempt limit.
 */
export function releaseOnlyAdvance(cwd: string, from: string, to: string): boolean {
  try {
    if (!from || !to || from === to) return false;
    const start = git(cwd, 'rev-parse', '--verify', `${from}^{commit}`);
    const end = git(cwd, 'rev-parse', '--verify', `${to}^{commit}`);
    if (start === end) return false;
    git(cwd, 'merge-base', '--is-ancestor', start, end);
    const commits = git(cwd, 'rev-list', '--parents', `${start}..${end}`).split('\n').filter(Boolean);
    for (const line of commits) {
      const [commit, ...parents] = line.split(' ');
      if (parents.length !== 1) return false;
      if (!RELEASE_SUBJECT.test(git(cwd, 'log', '-1', '--format=%s', commit))) return false;
    }
    const changed = git(cwd, 'diff', '--name-only', start, end).split('\n').filter(Boolean);
    if (!changed.length || changed.some(path => !RELEASE_PATHS.includes(path))) return false;
    for (const [path, strip] of Object.entries(STRIP)) {
      if (!changed.includes(path)) continue;
      const before = JSON.parse(fileAt(cwd, start, path).toString());
      const after = JSON.parse(fileAt(cwd, end, path).toString());
      if (hash(strip(before)) !== hash(strip(after))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
