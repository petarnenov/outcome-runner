import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP_LINE_LIMIT, createStepLog, formatStep, runStartMessage } from '../src/step-log.ts';

const nineOhFive = new Date(2026, 10, 11, 9, 5, 3);
const LINE = /^\[outcome-runner\] \d{2}:\d{2}:\d{2} \S+ [a-z ]+: .+$/u;

// Grade E

test('E (required): formatStep writes the fixed prefix, zero-padded local time, subject and step', () => {
  assert.equal(formatStep(nineOhFive, 'OR-17', 'claim', 'claiming the task'),
    '[outcome-runner] 09:05:03 OR-17 claim: claiming the task');
  assert.equal(formatStep(new Date(2026, 0, 1, 23, 59, 9), 'run', 'end', 'outcome exhausted'),
    '[outcome-runner] 23:59:09 run end: outcome exhausted');
  assert.match(formatStep(nineOhFive, 'OR-17', 'planning check', 'validating'), LINE);
});

test('E (required): a long message is cut to exactly 120 characters and control characters become spaces', () => {
  const line = formatStep(nineOhFive, 'OR-17', 'check', 'x'.repeat(300));
  assert.equal(line.length, STEP_LINE_LIMIT); assert.equal(STEP_LINE_LIMIT, 120);
  assert.ok(line.endsWith('...'));
  assert.ok(line.startsWith('[outcome-runner] 09:05:03 OR-17 check: xxx'));
  const exact = formatStep(nineOhFive, 'A', 'b', 'y'.repeat(120 - '[outcome-runner] 09:05:03 A b: '.length));
  assert.equal(exact.length, 120); assert.ok(!exact.endsWith('...'));
  const cleaned = formatStep(nineOhFive, 'OR\n17', 'cl\raim', 'one\ntwo\r\nthree\u001b[31m red\tend');
  assert.equal(cleaned, '[outcome-runner] 09:05:03 OR 17 cl aim: one two three [31m red end');
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(cleaned));
});

test('E (required): the run start line keeps all four values within 120 characters', () => {
  const invocation = `inv-${'i'.repeat(56)}`; const model = `model-${'m'.repeat(54)}`;
  assert.equal(invocation.length, 60); assert.equal(model.length, 60);
  const message = runStartMessage({ invocation, harness: 'claude', model, effort: 'medium' });
  const line = formatStep(nineOhFive, 'run', 'start', message);
  assert.ok(line.length <= 120, line);
  assert.ok(line.includes(`invocation=${invocation.slice(0, 13)}...`), line);
  assert.ok(line.includes('harness=claude')); assert.ok(line.includes(`model=${model.slice(0, 13)}...`));
  assert.ok(line.includes('effort=medium'));
  const widest = formatStep(nineOhFive, 'run', 'start', runStartMessage({ invocation, harness: 'h'.repeat(30),
    model, effort: 'e'.repeat(30) }));
  assert.equal(widest.length, 120);
  assert.ok(widest.includes('harness=hhhhh...') && widest.endsWith('effort=eeeee...'), widest);
  assert.equal(runStartMessage({}), 'invocation=auto harness=auto model=auto effort=auto');
  assert.equal(runStartMessage({ invocation: 'one', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' }),
    'invocation=one harness=claude model=claude-opus-5-5 effort=medium');
});

test('E (coverage-only): attempt 2 appends the attempt, attempt 1 does not, and resuming prefixes the message', () => {
  const lines: string[] = [];
  const step = createStepLog({ write: line => { lines.push(line); }, now: () => nineOhFive.getTime() });
  step('OR-17', 'implementation', 'starting the implementation session', { attempt: 2 });
  step('OR-17', 'implementation', 'starting the implementation session', { attempt: 1 });
  step('OR-17', 'check', 'running 1/2: node');
  step('OR-17', 'implementation', 'starting the implementation session', { resuming: true, attempt: 3 });
  assert.deepEqual(lines, [
    '[outcome-runner] 09:05:03 OR-17 implementation: starting the implementation session (attempt 2)\n',
    '[outcome-runner] 09:05:03 OR-17 implementation: starting the implementation session\n',
    '[outcome-runner] 09:05:03 OR-17 check: running 1/2: node\n',
    '[outcome-runner] 09:05:03 OR-17 implementation: resuming starting the implementation session (attempt 3)\n',
  ]);
});

test('E (coverage-only): a throwing output is swallowed and the default output is stderr', () => {
  const step = createStepLog({ write: () => { throw new Error('closed'); } });
  assert.doesNotThrow(() => step('run', 'start', 'message'));
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { createStepLog({ now: () => nineOhFive.getTime() })('run', 'end', 'outcome exhausted'); }
  finally { process.stderr.write = original; }
  assert.deepEqual(written, ['[outcome-runner] 09:05:03 run end: outcome exhausted\n']);
});
