import { exportFileType, Job, JobRequestSchema, ZipEntryNameSchema } from './jobs';

/** The Cloud Run job contract (FND-24) for zip downloads (CORE-12b). Fictional ids only. */

const path = (doc: string, version = 1) => `orgs/org-1/matters/m-1/documents/${doc}/v${version}`;
const zip = (
  inputs: { storagePath: string; fileName: string }[],
  target: unknown = { kind: 'export', name: 'Zip' },
) => ({
  type: 'documents.zip',
  input: { inputs },
  target,
});

describe('documents.zip jobs', () => {
  it('takes matter document versions with unique file names, into an export', () => {
    const request = zip([
      { storagePath: path('d-1'), fileName: 'Will.pdf' },
      { storagePath: path('d-2', 3), fileName: 'Will (2).pdf' },
    ]);
    expect(JobRequestSchema.parse(request)).toEqual(request);
  });

  it('refuses other paths, duplicate names, too many or no inputs, and a matter target', () => {
    const outside = zip([{ storagePath: 'orgs/org-1/exports/x.pdf', fileName: 'a.pdf' }]);
    expect(JobRequestSchema.safeParse(outside).success).toBe(false);
    const duplicates = zip([
      { storagePath: path('d-1'), fileName: 'Will.pdf' },
      { storagePath: path('d-2'), fileName: 'WILL.pdf' },
    ]);
    expect(JobRequestSchema.safeParse(duplicates).success).toBe(false);
    expect(JobRequestSchema.safeParse(zip([])).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({ storagePath: path(`d-${i}`), fileName: `${i}.pdf` }));
    expect(JobRequestSchema.safeParse(zip(many.slice(0, 200))).success).toBe(true);
    expect(JobRequestSchema.safeParse(zip(many)).success).toBe(false);
    const matter = { kind: 'matter', matterId: 'm-1', name: 'Zip', category: 'other', privileged: false };
    const toMatter = zip([{ storagePath: path('d-1'), fileName: 'a.pdf' }], matter);
    expect(JobRequestSchema.safeParse(toMatter).success).toBe(false);
  });

  it('keeps zip entry names inside the folder they unzip into', () => {
    for (const bad of ['', '.', '..', '../a.pdf', 'a/b.pdf', 'a\\b.pdf', 'a\u0000.pdf', 'x'.repeat(256)]) {
      expect(ZipEntryNameSchema.safeParse(bad).success).toBe(false);
    }
    expect(ZipEntryNameSchema.safeParse('Will (2).pdf').success).toBe(true);
  });

  it('records a zip job', () => {
    const at = new Date('2026-10-05T00:00:00.000Z');
    const job = {
      type: 'documents.zip',
      input: { inputs: [{ storagePath: path('d-1'), fileName: 'a.pdf' }] },
      target: { kind: 'export', name: 'Documents M-1' },
      status: 'queued',
      progress: { done: 0, total: 0 },
      warnings: [],
      attempts: 0,
      createdAt: at,
      createdBy: 'uid-1',
      updatedAt: at,
      updatedBy: 'uid-1',
      schemaVersion: Job.version,
    };
    expect(Job.schema.safeParse(job).success).toBe(true);
  });

  it('serves a zip job’s file as a zip and anything else as a PDF', () => {
    expect(exportFileType('documents.zip')).toEqual({ extension: 'zip', contentType: 'application/zip' });
    expect(exportFileType('pdf.render')).toEqual({ extension: 'pdf', contentType: 'application/pdf' });
    expect(exportFileType(undefined)).toEqual({ extension: 'pdf', contentType: 'application/pdf' });
  });
});
