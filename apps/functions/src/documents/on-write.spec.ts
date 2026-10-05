import { documentSearchTokens } from '@materia/domain';

import { maintainSearch, onWriteDefinition } from './on-write';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for `documents-onWrite` (CORE-15). Every matter and file name is fictional. */

const DOCS = 'orgs/org-a/matters/m1/documents';
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

function world(docs: Record<string, Record<string, unknown>>) {
  const store = memoryFirestore(docs);
  const trigger = (path: string) => {
    const data = store.docs.get(path);
    const change = { before: undefined, after: data ? { ref: { path }, data: () => data } : undefined };
    const ctx = {
      eventId: 'e1',
      time: new Date('2026-10-05T00:00:00Z'),
      params: { orgId: 'org-a', matterId: 'm1', documentId: path.split('/').at(-1) },
      log: createLog({ fn: 'documents-onWrite' }, () => undefined),
      clock: new FakeClock(),
      db: store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return maintainSearch(change as unknown as TriggerChange, ctx);
  };
  return { ...store, trigger };
}

describe('documents-onWrite', () => {
  it('is declared on matter documents', () => {
    expect(onWriteDefinition).toMatchObject({
      name: 'documents-onWrite',
      on: 'written',
      document: 'orgs/{orgId}/matters/{matterId}/documents/{documentId}',
    });
  });

  it('writes search from the name when it is stale, then is a no-op (no loop)', async () => {
    const w = world({ [`${DOCS}/d1`]: { ...meta, name: 'Grant of probate – Nguyễn.pdf', version: 1 } });
    expect(await w.trigger(`${DOCS}/d1`)).toBe('updated');
    expect(w.docs.get(`${DOCS}/d1`)?.['search']).toEqual(documentSearchTokens('Grant of probate – Nguyễn.pdf'));
    expect(w.docs.get(`${DOCS}/d1`)?.['updatedBy']).toBe('user-lawyer');
    expect(await w.trigger(`${DOCS}/d1`)).toBe('unchanged');
  });

  it('follows a rename and ignores deletes', async () => {
    const w = world({ [`${DOCS}/d1`]: { ...meta, name: 'Scan 001.pdf' } });
    await w.trigger(`${DOCS}/d1`);
    await w.db.doc(`${DOCS}/d1`).update({ name: 'Will of Ada Quill (fictional).pdf' });
    expect(await w.trigger(`${DOCS}/d1`)).toBe('updated');
    expect(w.docs.get(`${DOCS}/d1`)?.['search']).toEqual(expect.arrayContaining(['will', 'quill']));
    expect(w.docs.get(`${DOCS}/d1`)?.['search']).not.toContain('scan');
    expect(await w.trigger(`${DOCS}/missing`)).toBe('deleted');
  });
});
