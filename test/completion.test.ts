import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletion, validCompletion } from '../src/completion.ts';

test('completion validates every grade and rejects malformed supplied values', () => {
  for (const grade of ['A', 'B', 'C', 'D', 'E']) {
    assert.equal(validCompletion({ summary: 'Changed behavior. Added coverage.', grade }), true);
  }
  for (const value of [null, undefined, [], '', 1, {}, { summary: 'Text' }, { grade: 'A' },
    { summary: 1, grade: 'A' }, { summary: '', grade: 'A' }, { summary: '  ', grade: 'A' },
    { summary: 'Text', grade: 'F' }, { summary: 'Text', grade: 'a' }, { summary: 'Text', grade: 1 }]) {
    assert.equal(validCompletion(value), false);
    assert.throws(() => buildCompletion(value, '2026-01-01', '2026-01-02'), /completion/u);
  }
});

test('duration floors fractions, clamps backwards clocks, and retains hours beyond 24', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (const [elapsed, seconds, text] of [
    [999, 0, '0h 0m 0s'], [90005000, 90005, '25h 0m 5s'],
    [-5000, 0, '0h 0m 0s'], [4325999, 4325, '1h 12m 5s'],
  ] as const) {
    for (const summary of ['Changed behavior. Added coverage.', 'Changed behavior. Added coverage. Updated docs.']) {
      const completion = buildCompletion({ summary, grade: 'B' },
        new Date(start).toISOString(), new Date(start + elapsed).toISOString());
      assert.deepEqual(completion, { summary: `${summary} The task took ${text} from claim to acceptance and has complexity grade B.`,
        durationSeconds: seconds, grade: 'B' });
    }
  }
  assert.throws(() => buildCompletion({ summary: 'Text', grade: 'A' }, 'invalid', '2026-01-01'), /timestamp/u);
});
