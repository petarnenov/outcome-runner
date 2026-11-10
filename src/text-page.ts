// Harness tool results have a size limit, and JSON escaping inflates the text.
export const PAGE_BYTES = 24 * 1024;

export interface TextPage { content: string; offset: number; nextOffset: number | null }

export function pageOffset(offset: unknown = 0): number {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid page offset');
  return offset as number;
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;
const sequenceLength = (lead: number): number => lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

function cutCharacterBytes(page: Buffer): number {
  let back = 1;
  while (back < 4 && back < page.length && isContinuationByte(page[page.length - back])) back += 1;
  return sequenceLength(page[page.length - back]) > back ? back : 0;
}

// Stops reading once one byte past the page proves that another page exists.
export async function readPage(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  offset: number): Promise<TextPage> {
  const wanted = PAGE_BYTES + 1;
  const chunks: Uint8Array[] = [];
  let position = 0; let collected = 0;
  for await (const chunk of source) {
    const start = Math.max(offset - position, 0);
    position += chunk.length;
    if (start >= chunk.length) continue;
    const part = chunk.subarray(start, start + wanted - collected);
    chunks.push(part); collected += part.length;
    if (collected === wanted) break;
  }
  const window = Buffer.concat(chunks);
  if (window.length < wanted) return { content: window.toString('utf8'), offset, nextOffset: null };
  const page = window.subarray(0, PAGE_BYTES);
  const complete = page.subarray(0, page.length - cutCharacterBytes(page));
  return { content: complete.toString('utf8'), offset, nextOffset: offset + complete.length };
}
