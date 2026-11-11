import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('secret scanning permits only the literal /etc/passwd test fixture exception', () => {
  const actual = readFileSync(new URL('../.gitguardian.yaml', import.meta.url), 'utf8');
  const expected = [
    'version: 2',
    'secret:',
    '  ignored_matches:',
    '    - name: /etc/passwd test fixture',
    '      match: /etc/passwd',
  ].join('\n');

  // Compare the entire document: extra keys, entries and exclusions must fail.
  // Permit CRLF and one optional final newline, but no other formatting changes.
  assert.equal(actual.replace(/\r\n/g, '\n').replace(/\n$/, ''), expected);
});
