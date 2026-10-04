import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { canonicaliseStructureIds } from './determinism';

/** A tagged table the way Chromium writes it: header ids from DOM node ids, cells pointing at them. */
async function canonical(ids: [string, string]) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const headers = ids.map((id) => context.register(context.obj({ Type: 'StructElem', S: 'TH', ID: PDFString.of(id) })));
  for (const id of ids) {
    context.register(
      context.obj({ Type: 'StructElem', S: 'TD', A: [context.obj({ O: 'Table', Headers: [PDFString.of(id)] })] }),
    );
  }
  const sorted = ids.map((id, i) => ({ id, ref: headers[i] })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const leaf = context.obj({
    Limits: [PDFString.of(sorted[0]?.id ?? ''), PDFString.of(sorted[1]?.id ?? '')],
    Names: sorted.flatMap(({ id, ref }) => [PDFString.of(id), ref ?? null]),
  });
  const root = context.obj({ Type: 'StructTreeRoot', IDTree: context.obj({ Kids: [context.register(leaf)] }) });
  doc.catalog.set(PDFName.of('StructTreeRoot'), context.register(root));
  canonicaliseStructureIds(doc);
  const [first, second] = headers.map((ref) => ref?.objectNumber);
  return { bytes: await doc.save({ useObjectStreams: false }), first, second };
}

describe('canonicaliseStructureIds', () => {
  it('gives the same bytes whatever node ids Chromium picked', async () => {
    const { bytes: a } = await canonical(['node00000018', 'node00000003']);
    const { bytes: b } = await canonical(['node00000016', 'node00000017']);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('renames in structure order and keeps headers and the ID tree pointing at the same cells', async () => {
    const { bytes, first, second } = await canonical(['node00000018', 'node00000003']);
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).not.toContain('node00000018');
    expect(text).toMatch(/\/S \/TH\s*\/ID \(node00000001\)/);
    expect(text).toMatch(/\/Headers \[ \(node00000001\) \]/);
    expect(text).toMatch(/\/Limits \[ \(node00000001\) \(node00000002\) \]/);
    expect(text).toContain(`/Names [ (node00000001) ${first} 0 R (node00000002) ${second} 0 R ]`);
  });

  it('leaves an untagged document alone', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const before = await doc.save({ useObjectStreams: false });
    canonicaliseStructureIds(doc);
    expect(Buffer.from(await doc.save({ useObjectStreams: false })).equals(Buffer.from(before))).toBe(true);
  });
});
