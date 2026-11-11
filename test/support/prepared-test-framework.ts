import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestFrameworkDeps } from '../../src/test-framework-preflight.ts';

/**
 * A scripted test framework preflight for runner tests that do not exercise it: a scratch directory stands in for
 * the temporary worktree, and the analysis reports one technology whose framework enforces 100% coverage.
 * test/test-framework-preflight.test.ts covers the real session, worktree and setup.
 */
export const preparedTestFramework: Partial<TestFrameworkDeps> = {
  interactive: false,
  worktree: {
    add: () => mkdtempSync(join(tmpdir(), 'prepared-analysis-')),
    remove: (_root, path) => rmSync(path, { recursive: true, force: true }),
  },
  files: () => ['package.json'],
  analyse: async () => ({ technologies: [{ name: 'Node.js', kind: 'runtime', evidence: ['package.json'],
    frameworks: [{ name: 'node:test', evidence: ['package.json'], thresholds: { lines: 100, branches: 100, functions: 100 } }],
    recommendations: [] }] }),
};
