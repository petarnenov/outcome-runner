import test from 'node:test';
import assert from 'node:assert/strict';
import { runnerFixture } from './support/runner-fixture.ts';

/** Collects step lines without their newline. */
function capture() {
  const lines: string[] = [];
  return { lines, steps: (line: string) => { assert.ok(line.endsWith('\n')); lines.push(line.slice(0, -1)); } };
}
/** The part of a step line after `[outcome-runner] HH:MM:SS `. */
const body = (line: string) => line.slice('[outcome-runner] 09:05:03 '.length);

// Grade D

test('D (required): a throwing OpenSpec preflight logs run start, the OpenSpec preflight and run end unavailable', async t => {
  const f = runnerFixture(t); const { lines, steps } = capture();
  await assert.rejects(f.run(f.config('one', { leaves: ['A'] }),
    { steps, openspec: { probe: () => ({ status: 1 }), interactive: false } }), /OpenSpec CLI unavailable/u);
  assert.deepEqual(lines.map(body), [
    'run start: invocation=one harness=claude model=claude-opus-5-5 effort=medium',
    'run preflight: checking OpenSpec',
    'run end: outcome unavailable',
  ]);
});
