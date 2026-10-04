import type { JobRecord } from './core/types';

/** A valid job document for tests (fictional ids only). */
export function jobDoc(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    type: 'pdf.merge',
    input: { inputs: [{ storagePath: 'orgs/org-1/matters/m-1/documents/d-1/v1' }] },
    target: { kind: 'matter', matterId: 'm-1', name: 'Bundle', category: 'court_document', privileged: false },
    status: 'queued',
    progress: { done: 0, total: 0 },
    warnings: [],
    attempts: 0,
    createdAt: new Date('2026-10-04T00:00:00Z'),
    createdBy: 'uid-lawyer',
    updatedAt: new Date('2026-10-04T00:00:00Z'),
    updatedBy: 'uid-lawyer',
    schemaVersion: 1,
    ...overrides,
  } as JobRecord;
}
