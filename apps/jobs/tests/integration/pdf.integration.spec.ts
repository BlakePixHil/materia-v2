import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  docPath,
  FIXTURES,
  JOB_FIXTURES,
  jobFolder,
  progressLines,
  qpdfJson,
  readJob,
  runJob,
  uncompressed,
} from './run-job';

const OUTPUT = 'orgs/org-1/matters/m-1/documents/job-job-1/v1';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const matterTarget = { kind: 'matter', matterId: 'm-1', name: 'Court book draft', category: 'court_document' };

/** A fictional n-page PDF with fixed metadata. */
async function samplePdf(pages: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    doc.addPage([595, 842]).drawText(`${label} page ${i + 1}`, { x: 72, y: 760, size: 14, font });
  doc.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  return doc.save();
}

function mergeJob(input: Record<string, unknown>) {
  return { type: 'pdf.merge', input, target: matterTarget };
}

describe('pdf.merge', () => {
  it('merges page ranges, stamps, numbers and bookmarks the result, with progress', async () => {
    const dir = await jobFolder(
      mergeJob({
        inputs: [
          { storagePath: docPath('will') },
          { storagePath: docPath('order'), pageRange: '1' },
          { storagePath: docPath('cert') },
        ],
        stamp: { text: 'Exhibit NN-1 — Nguyễn', position: 'top-right' },
        pageNumbers: { format: 'Page {n} of {total}', start: 1, position: 'bottom-center' },
        bookmarks: [
          { title: 'Will of Lan Nguyễn', pageIndex: 0 },
          { title: 'Orders', pageIndex: 2 },
          { title: 'Past the end', pageIndex: 99 },
        ],
      }),
      {
        [docPath('will')]: join(FIXTURES, 'will.pdf'),
        [docPath('order')]: join(FIXTURES, 'court-order.pdf'),
        [docPath('cert')]: join(FIXTURES, 'death-certificate.pdf'),
      },
    );
    const result = await runJob(dir);
    expect(result.code, result.stdout).toBe(0);

    const job = await readJob(dir);
    expect(job.status).toBe('succeeded');
    expect(job.output).toMatchObject({ storagePath: OUTPUT, documentId: 'job-job-1' });
    expect(job.warnings).toEqual([
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: '1 bookmarks point past the last page' }),
    ]);

    const output = join(dir, 'storage', OUTPUT);
    const pages = job.output.pages;
    const json = await qpdfJson(output, ['pages', 'outlines']);
    expect(json.pages).toHaveLength(pages);
    expect(json.outlines.map((o) => [o.title, o.destpageposfrom1])).toEqual([
      ['Will of Lan Nguyễn', 1],
      ['Orders', 3],
    ]);
    // The stamp font (DejaVu Sans) is embedded and maps the Vietnamese "ễ" (U+1EC5).
    const text = await uncompressed(output);
    expect(text).toContain('/FontName /MateriaStamp-DejaVuSans');
    expect(text).toContain('<1EC5>');

    const document = JSON.parse(
      await readFile(join(dir, 'firestore/orgs/org-1/matters/m-1/documents/job-job-1.json'), 'utf8'),
    );
    expect(document).toMatchObject({
      source: 'generated',
      pageCount: pages,
      sha256: job.output.sha256,
      storagePath: OUTPUT,
    });

    const progress = await progressLines(dir);
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining(['checking inputs', 'merging', 'stamping', 'bookmarks', 'finalising']),
    );
    expect(progress.map((p) => p.done)).toEqual([...progress.map((p) => p.done)].sort((a, b) => a - b));
  });

  it('is deterministic: the same inputs give the same bytes', async () => {
    const run = async () => {
      const dir = await jobFolder(
        mergeJob({
          inputs: [{ storagePath: docPath('will') }],
          pageNumbers: { format: '{n}', start: 1, position: 'bottom-right' },
        }),
        {
          [docPath('will')]: join(FIXTURES, 'will.pdf'),
        },
      );
      expect((await runJob(dir)).code).toBe(0);
      return sha(await readFile(join(dir, 'storage', OUTPUT)));
    };
    expect(await run()).toBe(await run());
  });

  it('fails an unreadable input with PDF_INVALID, or skips it with a warning', async () => {
    const inputs = {
      [docPath('will')]: join(FIXTURES, 'will.pdf'),
      [docPath('junk')]: new TextEncoder().encode('This is not a PDF at all.'),
    };
    const list = [{ storagePath: docPath('will') }, { storagePath: docPath('junk') }];

    const abort = await jobFolder(mergeJob({ inputs: list }), inputs);
    expect((await runJob(abort)).code).toBe(2);
    expect((await readJob(abort)).error).toMatchObject({ code: 'PDF_INVALID', inputIndex: 1, retryable: false });

    const skip = await jobFolder(mergeJob({ inputs: list, onInputError: 'skip' }), inputs);
    expect((await runJob(skip)).code).toBe(0);
    const job = await readJob(skip);
    expect(job).toMatchObject({ status: 'succeeded', output: { pages: 2 } });
    expect(job.warnings).toEqual([expect.objectContaining({ code: 'PDF_INVALID', inputIndex: 1 })]);
  });

  it('repairs a damaged but recoverable input and says so', async () => {
    const whole = await readFile(join(FIXTURES, 'will.pdf'));
    // Cut off the cross-reference table and trailer; qpdf rebuilds them from the objects.
    const damaged = whole.subarray(0, whole.lastIndexOf('xref'));
    const dir = await jobFolder(mergeJob({ inputs: [{ storagePath: docPath('damaged') }] }), {
      [docPath('damaged')]: damaged,
    });
    expect((await runJob(dir)).code).toBe(0);
    const job = await readJob(dir);
    expect(job.output.pages).toBe(2);
    expect(job.warnings).toEqual([
      expect.objectContaining({ code: 'PDF_INVALID', message: 'Input 0 was damaged and has been repaired' }),
    ]);
  });

  it('fails a password-protected input with PDF_ENCRYPTED', async () => {
    const dir = await jobFolder(mergeJob({ inputs: [{ storagePath: docPath('locked') }] }), {
      [docPath('locked')]: join(JOB_FIXTURES, 'encrypted.pdf'),
    });
    expect((await runJob(dir)).code).toBe(2);
    expect((await readJob(dir)).error).toMatchObject({ code: 'PDF_ENCRYPTED', inputIndex: 0 });
  });

  it('exits without redoing a job that already succeeded (duplicate dispatch)', async () => {
    const dir = await jobFolder(mergeJob({ inputs: [{ storagePath: docPath('will') }] }), {
      [docPath('will')]: join(FIXTURES, 'will.pdf'),
    });
    expect((await runJob(dir)).code).toBe(0);
    const before = await progressLines(dir);
    const again = await runJob(dir);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('"reason":"succeeded"');
    expect(await progressLines(dir)).toHaveLength(before.length);
    expect((await readJob(dir)).attempts).toBe(1);
  });

  it('merges 500 pages in under 2 minutes', async () => {
    const inputs: Record<string, Uint8Array> = {};
    const list = [];
    const bookmarks = [];
    for (let i = 0; i < 50; i++) {
      inputs[docPath(`bulk-${i}`)] = await samplePdf(10, `Exhibit ${i + 1}`);
      list.push({ storagePath: docPath(`bulk-${i}`) });
      bookmarks.push({ title: `Exhibit ${i + 1}`, pageIndex: i * 10 });
    }
    const dir = await jobFolder(
      mergeJob({
        inputs: list,
        stamp: { text: 'Court book — fictional', position: 'top-center' },
        pageNumbers: { format: '{n}', start: 1, position: 'bottom-right' },
        bookmarks,
      }),
      inputs,
    );
    const result = await runJob(dir);
    expect(result.code, result.stdout).toBe(0);
    const job = await readJob(dir);
    expect(job.output.pages).toBe(500);
    expect(result.seconds).toBeLessThan(120);
    const done = result.stdout.split('\n').find((line) => line.includes('"succeeded"'));
    // Log evidence for the PR: duration and peak memory.
    console.info(`500-page merge: ${result.seconds.toFixed(1)} s; ${done}`);
    expect(JSON.parse(done ?? '{}').maxRssMb).toBeLessThan(1024);
  }, 180_000);
});

describe('pdf.render', () => {
  const renderJob = {
    type: 'pdf.render',
    input: {
      templateId: 'sample-letter',
      data: {
        title: 'Estate of the late Lan Nguyễn',
        recipient: 'Ms Trần Thị Hương',
        paragraphs: ['We act for the executor of the estate. <b>Not bold</b>', 'This letter is fictional.'],
        items: [{ label: 'Grant of probate', detail: 'Applied for' }],
        extraPages: ['Annexure A'],
      },
    },
    target: { kind: 'export', name: 'Letter to beneficiary' },
  };

  it('renders a template to a deterministic, tagged PDF with Vietnamese names', async () => {
    const shas = [];
    for (let i = 0; i < 2; i++) {
      const dir = await jobFolder(renderJob);
      const result = await runJob(dir);
      expect(result.code, result.stdout).toBe(0);
      const job = await readJob(dir);
      expect(job.output).toMatchObject({ storagePath: 'orgs/org-1/exports/job-1.pdf', pages: 2 });
      const output = join(dir, 'storage/orgs/org-1/exports/job-1.pdf');
      shas.push(sha(await readFile(output)));
      const text = await uncompressed(output);
      expect(text).toContain('<1EC5>'); // ễ
      expect(text).toContain('<1EA7>'); // ầ
      expect(text).toContain('/StructTreeRoot');
      const objects = (await qpdfJson(output, ['qpdf'])).qpdf[1];
      const info = objects[`obj:${objects['trailer']?.value['/Info']}`]?.value;
      expect(info).toMatchObject({ '/Producer': 'u:Materia', '/CreationDate': 'u:D:20000101000000Z' });
    }
    expect(shas[0]).toBe(shas[1]);
  });

  it('fails a missing template with NOT_FOUND', async () => {
    const dir = await jobFolder({ ...renderJob, input: { templateId: 'no-such-template', data: {} } });
    expect((await runJob(dir)).code).toBe(2);
    expect((await readJob(dir)).error).toMatchObject({ code: 'NOT_FOUND' });
  });

  // CORE-17: the safe custody receipt and stocktake print to one page each.
  it.each([
    [
      'safe-custody-receipt',
      {
        firmName: 'Harbour & Vine Legal',
        packetNo: 'SC-000042',
        testatorName: 'Lan Nguyễn',
        receivedOn: '14 Feb 2019',
        items: [{ kind: 'Will', date: '14 Feb 2019', description: 'Last will', current: true }],
        issuedOn: '5 Oct 2026',
      },
    ],
    [
      'safe-custody-stocktake',
      {
        firmName: 'Harbour & Vine Legal',
        count: 1,
        preparedOn: '5 Oct 2026',
        sites: [
          {
            site: 'Geelong',
            cabinets: [
              { cabinet: 'Safe A', packets: [{ slot: '2', packetNo: 'SC-000042', testatorName: 'Lan Nguyễn' }] },
            ],
          },
        ],
      },
    ],
  ])('renders %s', async (templateId, data) => {
    const dir = await jobFolder({ ...renderJob, input: { templateId, data } });
    const result = await runJob(dir);
    expect(result.code, result.stdout).toBe(0);
    expect((await readJob(dir)).output).toMatchObject({ pages: 1 });
  });
});
