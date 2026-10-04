import { PDFDocument } from 'pdf-lib';

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
  return doc.save({ useObjectStreams: false });
}
