import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRef, PDFString } from 'pdf-lib';

/**
 * Every generated PDF carries these dates and this producer, so the same input always gives the
 * same bytes (FND-24). The real time lives on the job and document records instead.
 */
export const FIXED_DATE = new Date('2000-01-01T00:00:00Z');
export const PRODUCER = 'Materia';

/** Rewrites a small PDF's document info with the fixed values. */
export async function normaliseMetadata(bytes: Uint8Array, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  if (title) doc.setTitle(title);
  canonicaliseStructureIds(doc);
  return doc.save({ useObjectStreams: false });
}

const text = (value: PDFObject | undefined) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;

/**
 * Chromium names tagged table headers after DOM node ids (`/ID (node00000018)`), which change from
 * one run to the next. Renames them in structure order (`node00000001`, …) and rewrites the cells'
 * `/Headers` and the ID tree to match.
 */
export function canonicaliseStructureIds(doc: PDFDocument): void {
  const context = doc.context;
  const lookup = (value: PDFObject | undefined) => (value instanceof PDFRef ? context.lookup(value) : value);
  const elements = context
    .enumerateIndirectObjects()
    .sort(([a], [b]) => a.objectNumber - b.objectNumber)
    .map(([, object]) => object)
    .filter(
      (object): object is PDFDict =>
        object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('StructElem'),
    );

  const renamed = new Map<string, string>();
  for (const element of elements) {
    const id = text(element.get(PDFName.of('ID')));
    if (id === undefined || renamed.has(id)) continue;
    const name = `node${String(renamed.size + 1).padStart(8, '0')}`;
    renamed.set(id, name);
    element.set(PDFName.of('ID'), PDFString.of(name));
  }
  if (renamed.size === 0) return;
  const rename = (value: PDFObject | undefined) => {
    const id = text(value);
    return id !== undefined && renamed.has(id) ? PDFString.of(renamed.get(id) as string) : value;
  };

  for (const element of elements) {
    const attributes = lookup(element.get(PDFName.of('A')));
    const dicts = attributes instanceof PDFArray ? attributes.asArray().map(lookup) : [attributes];
    for (const dict of dicts) {
      const headers = dict instanceof PDFDict ? lookup(dict.get(PDFName.of('Headers'))) : undefined;
      if (!(headers instanceof PDFArray)) continue;
      for (let i = 0; i < headers.size(); i++) headers.set(i, rename(headers.get(i)) as PDFObject);
    }
  }

  // The ID tree is a name tree: leaves keep sorted /Names pairs, and every node its /Limits.
  const rebuild = (node: PDFObject | undefined): [string, string] | undefined => {
    if (!(node instanceof PDFDict)) return undefined;
    let limits: [string, string] | undefined;
    const names = lookup(node.get(PDFName.of('Names')));
    if (names instanceof PDFArray) {
      const pairs: [string, PDFObject][] = [];
      for (let i = 0; i + 1 < names.size(); i += 2) {
        pairs.push([text(rename(names.get(i))) ?? '', names.get(i + 1)]);
      }
      pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      node.set(PDFName.of('Names'), context.obj(pairs.flatMap(([key, value]) => [PDFString.of(key), value])));
      if (pairs.length > 0) limits = [pairs[0]?.[0] ?? '', pairs[pairs.length - 1]?.[0] ?? ''];
    }
    const kids = lookup(node.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) {
        const range = rebuild(lookup(kid));
        if (!range) continue;
        limits = limits
          ? [range[0] < limits[0] ? range[0] : limits[0], range[1] > limits[1] ? range[1] : limits[1]]
          : range;
      }
    }
    if (limits && node.has(PDFName.of('Limits'))) {
      node.set(PDFName.of('Limits'), context.obj([PDFString.of(limits[0]), PDFString.of(limits[1])]));
    }
    return limits;
  };
  const root = lookup(doc.catalog.get(PDFName.of('StructTreeRoot')));
  if (root instanceof PDFDict) rebuild(lookup(root.get(PDFName.of('IDTree'))));
}
