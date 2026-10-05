import { REMOVED_DOCUMENT_LABEL, SCANNING_DELAYED_MESSAGE } from '@materia/domain';

import {
  DEFAULT_SORT,
  documentCount,
  documentFileName,
  documentFileType,
  documentStatus,
  duplicateText,
  fileProblem,
  fileTypeIcon,
  fileTypeOf,
  formatBytes,
  hasFilters,
  isReadable,
  matchesFilters,
  NO_FILTERS,
  parseTags,
  previewKind,
  rowName,
  sortDocuments,
  versionSummary,
  type DocumentRow,
} from './documents-view';
import { docRow, pipelineUpload, storedVersion } from './testing';

/** The Documents tab's view logic (CORE-12). Fictional data only. */

const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
const upload = (status: string, extra = {}) => pipelineUpload(status, extra) as never;

describe('documentStatus', () => {
  it('says where a document is in the pipeline, in plain words', () => {
    expect(documentStatus(docRow('d1', 'Will.pdf'))).toMatchObject({ kind: 'ready', label: 'Ready' });
    expect(documentStatus(docRow('d1', 'Will.pdf', { deletedAt: at(3) }))).toMatchObject({ kind: 'removed' });
    expect(documentStatus(docRow('d1', 'Will.pdf', { upload: upload('scanning') }))).toMatchObject({
      label: 'Scanning…',
      tone: 'info',
    });
    expect(documentStatus(docRow('d1', 'Will.pdf', { upload: upload('delayed') }))).toMatchObject({
      kind: 'delayed',
      label: SCANNING_DELAYED_MESSAGE,
    });
    expect(documentStatus(docRow('d1', 'Will.pdf', { upload: upload('infected') }))).toMatchObject({
      label: 'Quarantined',
      tone: 'danger',
    });
    expect(
      documentStatus(docRow('d1', 'Will.pdf', { version: 0, scan: { status: 'infected' } } as never)),
    ).toMatchObject({
      kind: 'infected',
    });
    expect(
      documentStatus(docRow('d1', 'Will.pdf', { upload: upload('rejected', { reason: 'type_mismatch' }) })).detail,
    ).toBe('The file’s contents don’t match its name. Check it opens, then save it with the right extension.');
    expect(documentStatus(docRow('d1', 'Will.pdf', { upload: upload('rejected') })).detail).toBe(
      'The file couldn’t be accepted.',
    );
    expect(documentStatus(docRow('d1', 'Will.pdf', { upload: upload('expired') }))).toMatchObject({
      label: 'Not checked',
    });
    expect(documentStatus(docRow('d1', 'Will.pdf', { version: 0, versions: [] }))).toMatchObject({
      kind: 'scanning',
    });
    expect(documentStatus(docRow('d1', 'Will.pdf', { duplicateOf: 'd0' }))).toMatchObject({
      kind: 'duplicate',
      label: 'Duplicate',
    });
  });

  it('opens only stored, clean, live documents', () => {
    expect(isReadable(docRow('d1', 'Will.pdf'))).toBe(true);
    expect(isReadable(docRow('d1', 'Will.pdf', { version: 0 }))).toBe(false);
    expect(isReadable(docRow('d1', 'Will.pdf', { scan: { status: 'pending' } }))).toBe(false);
    expect(isReadable(docRow('d1', 'Will.pdf', { deletedAt: at(2) }))).toBe(false);
  });

  it('names the original of a duplicate, or says it was removed', () => {
    expect(duplicateText(docRow('d0', 'Will.pdf'))).toBe('Duplicate of Will.pdf');
    expect(duplicateText(docRow('d0', 'Will.pdf', { deletedAt: at(2) }))).toBe(
      `Duplicate of ${REMOVED_DOCUMENT_LABEL}`,
    );
    expect(rowName(docRow('d0', 'Will.pdf'))).toBe('Will.pdf');
    expect(rowName(docRow('d0', 'Will.pdf', { deletedAt: at(2) }))).toBe(`${REMOVED_DOCUMENT_LABEL} (Will.pdf)`);
    expect(duplicateText(undefined)).toBe(`Duplicate of ${REMOVED_DOCUMENT_LABEL}`);
  });
});

describe('file types', () => {
  it('reads the type from the stored file name', () => {
    expect(fileTypeOf('Statement.XLSX')).toBe('spreadsheet');
    expect(fileTypeOf('letter.eml')).toBe('email');
    expect(fileTypeOf('script.exe')).toBeNull();
    const renamed = docRow('d1', 'Renamed without extension');
    expect(documentFileName(renamed)).toBe('Renamed without extension');
    const stored = docRow('d1', 'Renamed', {
      versions: [storedVersion('d1', 1, 'photo.heic')],
    });
    expect(documentFileName(stored)).toBe('photo.heic');
    expect(documentFileType(stored)).toBe('image');
    expect(documentFileType(renamed)).toBe('text');
    expect(fileTypeIcon('email')).toBe('mail');
    expect(documentFileName(docRow('d1', 'Upload', { version: 0, versions: [], upload: upload('scanning') }))).toBe(
      'Statement.pdf',
    );
  });

  it('previews each kind its own way', () => {
    expect(
      ['a.pdf', 'b.PNG', 'c.jpeg', 'd.webp', 'e.heic', 'f.msg', 'g.csv', 'h.docx', 'i.zip'].map(previewKind),
    ).toEqual(['pdf', 'image', 'image', 'image', 'heic', 'message', 'text', 'office', 'none']);
  });

  it('formats sizes and versions', () => {
    expect([undefined, 0, 1, 999, 64_000, 1_250_000].map(formatBytes)).toEqual([
      '—',
      '0 bytes',
      '1 byte',
      '999 bytes',
      '64 KB',
      '1.3 MB',
    ]);
    expect(versionSummary({ version: 3, sizeBytes: 1_200_000, pageCount: 14 })).toBe('v3 · 1.2 MB · 14 pages');
    expect(versionSummary({ version: 1, sizeBytes: 900, pageCount: 1 })).toBe('v1 · 900 bytes · 1 page');
    expect(versionSummary({ version: 1, sizeBytes: 900 })).toBe('v1 · 900 bytes');
  });

  it('refuses files before sending them', () => {
    expect(fileProblem({ name: 'tool.exe', size: 10 })).toMatch(/can’t be added/);
    expect(fileProblem({ name: 'big.pdf', size: 51 * 1024 * 1024 })).toBe('This file is over 50 MB.');
    expect(fileProblem({ name: 'empty.txt', size: 0 })).toBe('This file is empty.');
    expect(fileProblem({ name: 'will.pdf', size: 10 })).toBeNull();
  });
});

describe('filters and sorting', () => {
  const rows = [
    docRow('d1', 'Will.pdf', { createdAt: at(1), sizeBytes: 300 }),
    docRow('d2', 'advice.docx', { category: 'correspondence', privileged: true, createdAt: at(3), sizeBytes: 100 }),
    docRow('d3', 'Bank statement.xlsx', { category: 'financial', createdAt: at(2), sizeBytes: 200 }),
    docRow('d4', 'Old will.pdf', { deletedAt: at(4), createdAt: at(4) }),
  ];
  const names = (list: DocumentRow[]) => list.map((row) => row.name);

  it('filters by category, type, privilege and removal', () => {
    const pick = (filters: Partial<typeof NO_FILTERS>) =>
      names(rows.filter((row) => matchesFilters(row, { ...NO_FILTERS, ...filters })));
    expect(pick({})).toEqual(['Will.pdf', 'advice.docx', 'Bank statement.xlsx']);
    expect(pick({ removed: true })).toHaveLength(4);
    expect(pick({ categories: ['financial', 'will'] })).toEqual(['Will.pdf', 'Bank statement.xlsx']);
    expect(pick({ types: ['word'] })).toEqual(['advice.docx']);
    expect(pick({ privileged: 'yes' })).toEqual(['advice.docx']);
    expect(pick({ privileged: 'no' })).toEqual(['Will.pdf', 'Bank statement.xlsx']);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, removed: true })).toBe(true);
  });

  it('sorts by any column, newest first by default, with stable ties', () => {
    const live = rows.slice(0, 3);
    expect(names(sortDocuments(live, DEFAULT_SORT))).toEqual(['advice.docx', 'Bank statement.xlsx', 'Will.pdf']);
    expect(names(sortDocuments(live, { key: 'name', direction: 'asc' }))).toEqual([
      'advice.docx',
      'Bank statement.xlsx',
      'Will.pdf',
    ]);
    expect(names(sortDocuments(live, { key: 'size', direction: 'asc' }))).toEqual([
      'advice.docx',
      'Bank statement.xlsx',
      'Will.pdf',
    ]);
    expect(names(sortDocuments(live, { key: 'category', direction: 'desc' }))).toEqual([
      'Will.pdf',
      'Bank statement.xlsx',
      'advice.docx',
    ]);
    expect(names(sortDocuments(live, { key: 'type', direction: 'asc' }))).toEqual([
      'Will.pdf',
      'Bank statement.xlsx',
      'advice.docx',
    ]);
    const twins = [docRow('d9', 'Same.pdf'), docRow('d8', 'Same.pdf')];
    expect(sortDocuments(twins, { key: 'name', direction: 'asc' }).map((row) => row.id)).toEqual(['d8', 'd9']);
  });

  it('counts and parses tags', () => {
    expect(documentCount(1)).toBe('1 document');
    expect(documentCount(3)).toBe('3 documents');
    expect(parseTags(' original, estate ,, original ')).toEqual(['original', 'estate']);
  });
});
