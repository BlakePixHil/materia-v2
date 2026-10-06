import { Timestamp } from 'firebase-admin/firestore';

import { isMigrationWrite, migrationRunOf } from './migration';

const AT = new Date('2026-10-06T10:00:00.000Z');
const LATER = new Date('2026-10-07T10:00:00.000Z');
const meta = (runId: string, at: Date) => ({ migration: { runId, legacyPath: 'workflows/w/cards/c', loadedAt: at } });

describe('isMigrationWrite', () => {
  it('is the load creating a document, reloading it, or another run loading it', () => {
    expect(isMigrationWrite(undefined, { title: 'Call executor', ...meta('run-1', AT) })).toBe(true);
    expect(isMigrationWrite({ ...meta('run-1', AT) }, { ...meta('run-1', LATER) })).toBe(true);
    expect(isMigrationWrite({ ...meta('run-1', AT) }, { ...meta('run-2', AT) })).toBe(true);
    expect(isMigrationWrite({ title: 'Made in v2' }, { title: 'Made in v2', ...meta('run-1', AT) })).toBe(true);
  });

  it('is not a person editing a migrated document, a trigger stamping one, a delete, or any other write', () => {
    const loaded = { title: 'Call executor', ...meta('run-1', AT) };
    expect(isMigrationWrite(loaded, { ...loaded, title: 'Call the executor' })).toBe(false);
    const stamped = {
      ...loaded,
      migration: { ...loaded.migration, loadedAt: Timestamp.fromDate(AT) },
    };
    expect(isMigrationWrite(stamped, { ...stamped, countedOpen: true })).toBe(false);
    expect(isMigrationWrite(loaded, undefined)).toBe(false);
    expect(isMigrationWrite(undefined, { title: 'New' })).toBe(false);
    expect(isMigrationWrite(undefined, { migration: { runId: '' } })).toBe(false);
  });

  it('compares load times as instants, whether Dates or Timestamps', () => {
    const before = { migration: { runId: 'run-1', loadedAt: Timestamp.fromDate(AT) } };
    expect(isMigrationWrite(before, { migration: { runId: 'run-1', loadedAt: Timestamp.fromDate(AT) } })).toBe(false);
    expect(isMigrationWrite(before, { migration: { runId: 'run-1', loadedAt: Timestamp.fromDate(LATER) } })).toBe(true);
  });
});

describe('migrationRunOf', () => {
  it('names the run that loaded a document', () => {
    expect(migrationRunOf(meta('run-1', AT))).toBe('run-1');
    expect(migrationRunOf({})).toBeUndefined();
    expect(migrationRunOf(undefined)).toBeUndefined();
  });
});
