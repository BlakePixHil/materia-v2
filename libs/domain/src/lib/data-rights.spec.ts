import {
  confirmsOrgName,
  DeleteAccountInput,
  DeletedOrg,
  exportCollectionName,
  exportDataFileName,
  exportStillRunning,
  fromPortable,
  OffboardMemberInput,
  ORG_DELETION_GRACE_DAYS,
  orgDeletionCertificateId,
  orgDeletionCertificatePath,
  orgDeletionDate,
  OrgExportInput,
  OrgExportManifestSchema,
  orgExportFileName,
  orgExportPartPath,
  RequestOrgDeletionInput,
  toPortable,
} from './data-rights';
import { EXPORT_FILE_PATH, exportFileType, GetExportUrlInput, Job } from './schemas/jobs';
import { Org } from './schemas/tenancy';

describe('the full export', () => {
  it('names each collection from its entity path, relative to the practice', () => {
    expect(exportCollectionName('orgs')).toBe('org');
    expect(exportCollectionName('orgs/{orgId}/matters')).toBe('matters');
    expect(exportCollectionName('orgs/{orgId}/matters/{matterId}/tasks')).toBe('matters.tasks');
    expect(exportCollectionName('orgs/{orgId}/members/{uid}/tasks')).toBe('members.tasks');
    expect(exportCollectionName('orgs/{orgId}/matters/{matterId}/documents/{docId}/chunks')).toBe(
      'matters.documents.chunks',
    );
    expect(exportCollectionName('users/{uid}/views')).toBeNull();
    expect(exportCollectionName('calendars')).toBeNull();
  });

  it('continues a large collection in numbered files', () => {
    expect(exportDataFileName('audit')).toBe('data/audit.jsonl');
    expect(exportDataFileName('audit', 2)).toBe('data/audit.2.jsonl');
  });

  it('names the parts for download and storage', () => {
    expect(orgExportFileName('Harbour & Vine Legal', '2026-10-07', 1, 1)).toBe(
      'Harbour & Vine Legal export 2026-10-07.zip',
    );
    expect(orgExportFileName('A/B: "Legal"', '2026-10-07', 2, 3)).toBe('A B Legal export 2026-10-07 (part 2 of 3).zip');
    expect(orgExportPartPath('o1', 'j1', 1)).toBe('orgs/o1/exports/j1.zip');
    expect(orgExportPartPath('o1', 'j1', 3)).toBe('orgs/o1/exports/j1.part-3.zip');
    // The export sweep recognises every part, with its org and job.
    expect(EXPORT_FILE_PATH.exec('orgs/o1/exports/j1.part-3.zip')?.slice(1)).toEqual(['o1', 'j1', 'zip']);
    expect(EXPORT_FILE_PATH.exec('orgs/o1/exports/j1.csv')?.slice(1)).toEqual(['o1', 'j1', 'csv']);
    expect(exportFileType('org.export')).toEqual({ extension: 'zip', contentType: 'application/zip' });
  });

  it('needs the owner to acknowledge privileged material', () => {
    const requestId = '6f0a2c3e-0d5b-4b55-9f0e-3a3c1f1b2a10';
    expect(OrgExportInput.safeParse({ requestId }).success).toBe(false);
    expect(OrgExportInput.parse({ requestId, acknowledgePrivileged: true })).toEqual({
      requestId,
      acknowledgePrivileged: true,
      allVersions: false,
    });
  });

  it('round-trips values through portable JSON', () => {
    const value = {
      at: new Date('2026-10-07T01:02:03.000Z'),
      list: [1, 'two', null, { nested: new Date('2026-01-01T00:00:00.000Z') }],
      skipped: undefined,
      bytes: new Uint8Array([104, 105]),
      odd: Number.NaN,
    };
    const portable = toPortable(value);
    expect(portable).toEqual({
      at: { $date: '2026-10-07T01:02:03.000Z' },
      list: [1, 'two', null, { nested: { $date: '2026-01-01T00:00:00.000Z' } }],
      bytes: { $bytes: 'aGk=' },
      odd: { $number: 'NaN' },
    });
    const back = fromPortable(JSON.parse(JSON.stringify(portable))) as Record<string, unknown>;
    expect(back['at']).toEqual(value.at);
    expect((back['list'] as unknown[])[3]).toEqual({ nested: new Date('2026-01-01T00:00:00.000Z') });
    expect(back['bytes']).toEqual({ $bytes: 'aGk=' });
    expect(Number.isNaN(back['odd'])).toBe(true);
    expect(toPortable(undefined)).toBeNull();
    expect(toPortable(Symbol('x'))).toBeNull();
    expect(toPortable(Number.POSITIVE_INFINITY)).toEqual({ $number: 'Infinity' });
    expect(toPortable(BigInt(3))).toBe(3);
  });

  it('describes the manifest', () => {
    const manifest = {
      format: 'materia.org-export',
      version: 1,
      orgId: 'o1',
      orgName: 'Fictional Legal',
      createdAt: '2026-10-07T00:00:00.000Z',
      createdBy: 'u1',
      allVersions: false,
      parts: 1,
      collections: { matters: 2 },
      entries: [{ path: 'data/matters.jsonl', part: 1, kind: 'data', bytes: 10, sha256: 'a'.repeat(64), records: 2 }],
    };
    expect(OrgExportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(OrgExportManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
  });

  it('keeps a full export’s parts and checkpoint on its job', () => {
    expect(Object.keys(Job.create.shape)).not.toContain('checkpoint');
    const output = { storagePath: 'orgs/o/exports/j.zip', sizeBytes: 1, sha256: 'b'.repeat(64), pages: 0 };
    expect(Job.schema.shape.output.safeParse({ ...output, parts: [output] }).success).toBe(true);
    expect(GetExportUrlInput.parse({ jobId: 'j', part: 2 })).toEqual({ jobId: 'j', part: 2 });
  });
});

describe('deleting a practice', () => {
  it('is 30 days after the request', () => {
    expect(ORG_DELETION_GRACE_DAYS).toBe(30);
    expect(orgDeletionDate(new Date('2026-10-07T00:00:00.000Z')).toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });

  it('accepts the practice name typed loosely, nothing else', () => {
    expect(confirmsOrgName('  harbour &  vine legal ', 'Harbour & Vine Legal')).toBe(true);
    expect(confirmsOrgName('O’Brien Legal', "O'Brien Legal")).toBe(true);
    expect(confirmsOrgName('Harbour', 'Harbour & Vine Legal')).toBe(false);
    expect(confirmsOrgName('', '')).toBe(false);
    expect(RequestOrgDeletionInput.safeParse({ requestId: crypto.randomUUID(), confirmation: ' ' }).success).toBe(
      false,
    );
  });

  it('counts an export as running only while it is heard from', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const recent = new Date('2026-10-07T11:00:00.000Z');
    const stale = new Date('2026-10-07T09:00:00.000Z');
    expect(exportStillRunning({ status: 'running', heartbeatAt: recent }, now)).toBe(true);
    expect(exportStillRunning({ status: 'queued', updatedAt: recent }, now)).toBe(true);
    expect(exportStillRunning({ status: 'queued' }, now)).toBe(true);
    expect(exportStillRunning({ status: 'running', heartbeatAt: stale }, now)).toBe(false);
    expect(exportStillRunning({ status: 'succeeded', heartbeatAt: recent }, now)).toBe(false);
  });

  it('keeps a server-only tombstone and certificate outside the practice', () => {
    expect(DeletedOrg.path).toBe('deletedOrgs');
    expect(Object.keys(DeletedOrg.update.shape)).toEqual([]);
    expect(orgDeletionCertificateId('0123456789abcdef')).toBe('odc-0123456789ab');
    expect(orgDeletionCertificatePath('o1', 'odc-1')).toBe('deletedOrgs/o1/odc-1.pdf');
    expect(Object.keys(Org.create.shape)).not.toContain('deletionScheduledAt');
    expect(Object.keys(Org.create.shape)).not.toContain('deletionRequestedBy');
  });
});

describe('offboarding and account deletion', () => {
  it('validates the offboarding choices', () => {
    const requestId = crypto.randomUUID();
    expect(
      OffboardMemberInput.safeParse({ requestId, uid: 'u2', reassign: { tasks: 'u3' }, personalTasks: 'transfer' })
        .success,
    ).toBe(true);
    expect(OffboardMemberInput.safeParse({ requestId, uid: 'u2', reassign: {}, personalTasks: 'export' }).success).toBe(
      false,
    );
    expect(DeleteAccountInput.safeParse({ confirmation: 'DELETE' }).success).toBe(true);
  });
});
