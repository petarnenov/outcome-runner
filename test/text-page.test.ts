import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, git, gitPage } from '../src/git.ts';
import { PAGE_BYTES, pageOffset, readPage } from '../src/text-page.ts';
import type { TextPage } from '../src/text-page.ts';

async function readAllPages(read: (offset: number) => Promise<TextPage>): Promise<TextPage[]> {
  const pages: TextPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: TextPage = await read(offset);
    pages.push(page); offset = page.nextOffset;
  }
  return pages;
}

const joined = (pages: TextPage[]): string => pages.map(page => page.content).join('');

function largeDiffRepository(t: TestContext): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'text-page-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'file.txt'), 'start\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'file.txt'), 'changed line\n'.repeat(12_000));
  return { root, base };
}

test('a short source is one page without a next offset', async () => {
  assert.deepEqual(await readPage([Buffer.from('short')], 0), { content: 'short', offset: 0, nextOffset: null });
});

test('an exact page has no next offset', async () => {
  const page = await readPage([Buffer.alloc(PAGE_BYTES, 'a')], 0);
  assert.equal(page.nextOffset, null);
  assert.equal(page.content.length, PAGE_BYTES);
});

test('an offset past the end is an empty final page', async () => {
  assert.deepEqual(await readPage([Buffer.from('short')], 99), { content: '', offset: 99, nextOffset: null });
});

test('pages never split a multibyte character and rebuild the text', async () => {
  for (const padding of [0, 1, 2, 3]) {
    const text = 'x'.repeat(padding) + 'жюя€😀'.repeat(PAGE_BYTES);
    const source = Buffer.from(text);
    const pages = await readAllPages(offset => readPage([source], offset));
    assert.ok(pages.length > 1);
    assert.equal(joined(pages), text);
    assert.ok(pages.every(page => !page.content.includes('�')));
    assert.ok(pages.every(page => Buffer.byteLength(page.content) <= PAGE_BYTES));
  }
});

test('chunk boundaries do not change the pages', async () => {
  const source = Buffer.from('abcdefghij'.repeat(PAGE_BYTES));
  const chunked = (offset: number) => readPage(function* () {
    for (let start = 0; start < source.length; start += 1000) yield source.subarray(start, start + 1000);
  }(), offset);
  assert.equal(joined(await readAllPages(chunked)), source.toString());
});

test('reading stops as soon as the page is proven incomplete', async () => {
  let produced = 0;
  const page = await readPage(function* () {
    for (;;) { produced += 1; yield Buffer.alloc(1024, 'a'); }
  }(), 0);
  assert.equal(page.nextOffset, PAGE_BYTES);
  assert.equal(produced, 25);
});

test('page offsets must be nonnegative integers', () => {
  assert.equal(pageOffset(undefined), 0);
  assert.equal(pageOffset(7), 7);
  for (const offset of [-1, 1.5, '1', null]) assert.throws(() => pageOffset(offset), /offset/u);
});

test('a git diff larger than a page is rebuilt from bounded pages', async t => {
  const { root, base } = largeDiffRepository(t);
  const pages = await readAllPages(offset => gitPage(root, offset, 'diff', base));
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => Buffer.byteLength(page.content) <= PAGE_BYTES));
  assert.equal(joined(pages).trim(), command(root, 'git', ['diff', base]));
});

test('a failed git command is not reported as an empty page', async t => {
  const { root } = largeDiffRepository(t);
  await assert.rejects(gitPage(root, 0, 'diff', 'no-such-revision'), /git diff failed/u);
});
