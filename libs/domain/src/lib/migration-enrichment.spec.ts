import {
  awaitsMigrationEnrichment,
  canApproveEnrichment,
  datesInText,
  enrichmentEstimateText,
  enrichmentProgress,
  quoteStatesDate,
  suggestedAllowanceCents,
} from './migration-enrichment';

/** Clerk reading a migration run (MIG-09, D-21): the helpers the server and the Settings card share. */
describe('migration enrichment', () => {
  it('finds the full dates a text states, day first as Australian files write them', () => {
    expect(datesInText('Margaret died on 12 March 2024 at Geelong.')).toEqual(['2024-03-12']);
    expect(datesInText('Grant made 3/5/2024; notice published 21.06.24.')).toEqual(['2024-05-03', '2024-06-21']);
    expect(datesInText('The will is dated the 1st day of February, 2019.')).toEqual(['2019-02-01']);
    expect(datesInText('Filed March 4, 2025 (2025-03-04).')).toEqual(['2025-03-04']);
    expect(datesInText('Sept. 9, 2023 and 9 Sep 2023')).toEqual(['2023-09-09']);
    // No year, an impossible day, or a version number: not dates.
    expect(datesInText('Expected in June; due 31 June 2024; see clause 1.2.3; 12 March')).toEqual([]);
  });

  it('checks a quote states the date it is cited for', () => {
    expect(quoteStatesDate('She died on 12 March 2024.', '2024-03-12')).toBe(true);
    expect(quoteStatesDate('She died on 12 March 2024.', '2024-12-03')).toBe(false);
    expect(quoteStatesDate('She died last spring.', '2024-03-12')).toBe(false);
  });

  it('leaves a migrated document Clerk hasn’t read to the enrichment', () => {
    const migration = { runId: 'run-1', legacyPath: 'cards/c1', loadedAt: new Date() };
    expect(awaitsMigrationEnrichment({ migration })).toBe(true);
    expect(awaitsMigrationEnrichment({ migration, ingest: { status: 'pending' } })).toBe(true);
    expect(awaitsMigrationEnrichment({ migration, ingest: { status: 'failed', version: 1 } })).toBe(false);
    expect(awaitsMigrationEnrichment({ migration, ingest: { status: 'pending', version: 2 } })).toBe(false);
    expect(awaitsMigrationEnrichment({ ingest: { status: 'pending' } })).toBe(false);
  });

  it('offers the estimate with half again as the allowance, in whole dollars, from US$5', () => {
    expect(suggestedAllowanceCents(0)).toBe(500);
    expect(suggestedAllowanceCents(620)).toBe(1_000);
    expect(suggestedAllowanceCents(4_150)).toBe(6_300);
    expect(suggestedAllowanceCents(10_000_000)).toBe(100_000);
  });

  it('describes the estimate and the progress', () => {
    expect(
      enrichmentEstimateText({
        documents: 71,
        pages: 1_040,
        ocrPages: 220,
        chars: 1,
        unreadable: 2,
        matters: 30,
        costCents: 620,
        model: 'claude-sonnet-5-5',
      }),
    ).toBe('71 documents (about 1,040 pages, 220 of them scanned) and 30 estate matters: about US$6.20');
    expect(
      enrichmentEstimateText({
        documents: 1,
        pages: 0,
        ocrPages: 0,
        chars: 0,
        unreadable: 1,
        matters: 0,
        costCents: 0,
        model: 'claude-sonnet-5-5',
      }),
    ).toBe('1 document: about US$0.00');
    expect(
      enrichmentProgress({
        documents: ['m1/d1', 'm1/d2', 'm2/d3'],
        matters: ['m1', 'm2'],
        progress: { read: 1, skipped: 1, failed: 0, mattersRead: 1, events: 2 },
      }),
    ).toEqual({ documentsDone: 2, documents: 3, mattersDone: 1, matters: 2 });
    expect(canApproveEnrichment({ status: 'awaiting_approval' })).toBe(true);
    expect(canApproveEnrichment({ status: 'paused' })).toBe(true);
    expect(canApproveEnrichment({ status: 'running' })).toBe(false);
  });
});
