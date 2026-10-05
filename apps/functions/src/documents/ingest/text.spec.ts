import { chunkPages, normaliseText } from '@materia/clerk';

import { chunkId } from './chunks';
import { chunkDocumentText, joinOverlapping, pagesFromChunks } from './text';
import { memoryFirestore } from '../../orgs/testing';

/** Document text read back from chunks for Clerk's context (AI-03 ← AI-04). Text is fictional. */

const sentence = (i: number) => `Clause ${i}: the trustee of the fictional Sample estate holds parcel ${i} on trust. `;
const longPage = Array.from({ length: 120 }, (_, i) => sentence(i)).join('');

describe('pagesFromChunks', () => {
  it('rebuilds each page from its overlapping chunks', () => {
    const pages = [
      { page: 1, text: longPage },
      { page: 2, text: 'Schedule: nothing further.' },
    ];
    const chunks = chunkPages(pages);
    expect(chunks.filter((c) => c.page === 1).length).toBeGreaterThan(2);
    expect(pagesFromChunks([...chunks].reverse())).toEqual(
      pages.map(({ page, text }) => ({ page, text: normaliseText(text) })),
    );
  });

  it('joins chunks without an overlap with a space', () => {
    expect(joinOverlapping('first part', 'second part')).toBe('first part second part');
    expect(joinOverlapping('', 'only')).toBe('only');
    expect(joinOverlapping('one two three', 'two three four')).toBe('one two three four');
  });
});

describe('chunkDocumentText', () => {
  it("reads one version's pages; another version has none yet", async () => {
    const base = 'orgs/o1/matters/m1/documents/d1/chunks';
    const docs: Record<string, Record<string, unknown>> = {};
    for (const c of chunkPages([{ page: 1, text: longPage }]))
      docs[`${base}/${chunkId(2, c.ordinal)}`] = { ...c, docVersion: 2 };
    const db = memoryFirestore(docs).db;
    const port = chunkDocumentText(db);
    expect(await port.pages({ orgId: 'o1', matterId: 'm1', documentId: 'd1', version: 2 })).toEqual([
      { page: 1, text: normaliseText(longPage) },
    ]);
    expect(await port.pages({ orgId: 'o1', matterId: 'm1', documentId: 'd1', version: 3 })).toEqual([]);
  });
});
