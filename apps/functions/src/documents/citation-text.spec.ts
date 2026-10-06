import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { CitationTextResult, Role } from '@materia/domain';

import { citationTextDefinition } from './citation-text';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** `documents-citationText` (AI-05). Every org, matter and document is fictional. */

const ORG = 'org-c';
const DOCS = `orgs/${ORG}/matters/m1/documents`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
type Data = Record<string, unknown>;

const document = (extra: Data = {}): Data => ({
  ...meta,
  name: 'Letter to the executor (fictional).docx',
  privileged: false,
  version: 2,
  versions: [{ version: 1 }, { version: 2 }],
  scan: { status: 'clean' },
  deletedAt: null,
  ...extra,
});
const chunk = (version: number, page: number, ordinal: number, text: string, ocr = false): Data => ({
  docVersion: version,
  page,
  ordinal,
  text,
  ...(ocr ? { ocr } : {}),
});

function world() {
  const store = memoryFirestore({
    [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active' },
    [`orgs/${ORG}/members/user-paralegal`]: { ...meta, role: 'paralegal', status: 'active' },
    [`orgs/${ORG}/matters/m1`]: { ...meta, title: 'Estate of Fictional Vale', privileged: false, deletedAt: null },
    [`${DOCS}/d-letter`]: document(),
    [`${DOCS}/d-letter/chunks/002-00000`]: chunk(2, 1, 0, 'Dear Harper, the estate account holds'),
    [`${DOCS}/d-letter/chunks/002-00001`]: chunk(2, 1, 1, 'the estate account holds $12,000 (fictional).'),
    [`${DOCS}/d-letter/chunks/002-00002`]: chunk(2, 2, 2, 'Scanned annexure text.', true),
    [`${DOCS}/d-letter/chunks/001-00000`]: chunk(1, 1, 0, 'An earlier draft.'),
    [`${DOCS}/d-advice`]: document({ privileged: true }),
    [`${DOCS}/d-removed`]: document({ deletedAt: new Date('2026-10-01T00:00:00Z') }),
    [`${DOCS}/d-pending`]: document({ scan: { status: 'pending' } }),
  });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock: new FakeClock(new Date('2026-10-05T00:00:00Z')),
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  return (data: Data, role: Role = 'lawyer') =>
    runCallable(
      citationTextDefinition as unknown as CallableDefinition<never, CitationTextResult>,
      {
        data: { matterId: 'm1', requestId: randomUUID(), ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(),
    );
}

async function failure(promise: Promise<unknown>): Promise<HttpsError & { details: Data }> {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details: Data };
  }
  throw new Error('expected a failure');
}

describe('documents-citationText', () => {
  it('returns the current version’s pages from its chunks, overlaps merged, OCR marked', async () => {
    const call = world();
    expect(await call({ docId: 'd-letter' })).toEqual({
      version: 2,
      pages: [
        { page: 1, text: 'Dear Harper, the estate account holds $12,000 (fictional).', ocr: false },
        { page: 2, text: 'Scanned annexure text.', ocr: true },
      ],
      truncated: false,
    });
  });

  it('reads the cited version and only the pages asked for', async () => {
    const call = world();
    expect(await call({ docId: 'd-letter', version: 1 })).toMatchObject({
      version: 1,
      pages: [{ page: 1, text: 'An earlier draft.' }],
    });
    expect((await call({ docId: 'd-letter', pages: [2] })).pages.map((p) => p.page)).toEqual([2]);
    expect(await call({ docId: 'd-letter', version: 7 }).catch((e: HttpsError) => e.code)).toBe('not-found');
  });

  it('hides privileged documents from roles without privileged.view, and removed or unscanned ones', async () => {
    const call = world();
    expect((await failure(call({ docId: 'd-advice' }, 'paralegal'))).code).toBe('not-found');
    expect((await call({ docId: 'd-advice' })).pages).toEqual([]);
    expect((await failure(call({ docId: 'd-removed' }))).code).toBe('not-found');
    expect((await failure(call({ docId: 'd-pending' }))).code).toBe('failed-precondition');
  });
});
