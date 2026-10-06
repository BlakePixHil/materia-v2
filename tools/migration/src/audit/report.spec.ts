import { readFileSync } from 'node:fs';

import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { collectSnapshot, memoryReader } from '../legacy/reader.ts';
import type { LegacySnapshot } from '../legacy/snapshot.ts';
import { MappingProfileSchema } from '../profile.ts';
import { renderAuditMarkdown } from './markdown.ts';
import { auditSnapshot, feeUnit, numberRange, type AuditReport } from './report.ts';

const { subject, colleague, departed } = FIXTURE_UIDS;
const options = { generatedAt: '2026-10-06T00:00:00.000Z', source: { project: 'legacy-p', bucket: 'legacy-b' } };
const fixtureProfile = MappingProfileSchema.parse(
  JSON.parse(readFileSync(`${FIXTURE_DIR}mapping-profile.json`, 'utf8')),
);

let snapshot: LegacySnapshot;
let report: AuditReport;

beforeAll(async () => {
  const { docs, objects } = loadLegacyFixtures();
  snapshot = await collectSnapshot(memoryReader(docs, objects), subject);
  report = auditSnapshot(snapshot, options);
});

describe('auditSnapshot', () => {
  it('scopes to the workflows the user owns or administers, and lists the others', () => {
    expect(report.scope).toEqual({
      rule: 'owner_or_admin',
      included: ['Wills & powers', 'Estates', 'Business development'],
      excluded: [{ name: 'Shared board', reason: expect.stringContaining('neither owns nor administers') }],
    });
    expect(report.workflows.find((w) => w.name === 'Estates')).toMatchObject({
      roles: ['admin', 'readWrite'],
      inScope: true,
    });
  });

  it('counts what migrates', () => {
    expect(report.counts).toEqual({
      workflows: { total: 4, inScope: 3, byVisibility: { organisation: 1, private: 2 } },
      cards: { total: 10, archived: 1, active: 9 },
      checklists: 2,
      checklistItems: 4,
      comments: 2,
      history: 2,
      attachments: { count: 7, bytes: 27_854_976 },
      checklistTemplates: 2,
      referrers: 3,
      dashboardItems: 2,
      integrations: 2,
      workspaces: 2,
    });
  });

  it('counts cards per swimlane and label, and the ones that point at nothing', () => {
    const wills = report.workflows.find((w) => w.name === 'Wills & powers');
    expect(wills?.swimlanes.map((s) => [s.title, s.cards, s.archived, s.isDoneSwimlane])).toEqual([
      ['Enquiries', 1, 0, false],
      ['Drafting', 1, 0, false],
      ['Signed, waiting to bill', 1, 0, false],
      ['Closed', 1, 1, true],
    ]);
    expect(wills).toMatchObject({
      cardsInUnknownSwimlane: 1,
      unknownLabelIds: 1,
      otherMembers: 1,
      cardsWithFee: 5,
      cardsBillable: 2,
    });
    expect(wills?.labels).toEqual([
      { id: expect.any(String), name: 'Urgent', color: 'var(--mr-label-1-rgb)', cards: 1 },
      { id: expect.any(String), name: 'Referral', color: 'var(--mr-label-4-rgb)', cards: 0 },
    ]);
    expect(report.workflows.find((w) => w.name === 'Estates')?.labels).toEqual([]);
  });

  it('histograms field shapes, as the ticket asks for assignee', () => {
    expect(report.fields['cards']?.['assignee']).toEqual({
      of: 10,
      shapes: { 'empty-string': 1, null: 1, 'uid:other': 1, 'uid:self': 7 },
    });
    expect(report.fields['cards']?.['matterReference']?.shapes).toEqual({ 'empty-string': 1, null: 5, text: 4 });
    expect(report.fields['workflows']?.['labels']?.shapes).toEqual({ array: 1, 'array:empty': 1, missing: 1 });
  });

  it('counts legacy field names', () => {
    expect(report.legacyFields).toEqual({
      'fee.realisedFees': 1,
      'fee.hasDisbursements': 1,
      'fee.disbursements': 1,
      'checklistItem.calendarSync': 1,
      'checklist.templateExists': 1,
      'workflows.owner': 1,
      'card.dueDate (set)': 1,
      'card.hoursEstimate (set)': 1,
      'card.actualHours (set)': 1,
    });
  });

  it('lists referenced users with their profile names', () => {
    expect(report.people).toEqual([
      { uid: departed, exists: false, name: null, references: { mention: 1 } },
      {
        uid: colleague,
        exists: true,
        name: 'Jordan Ellis',
        references: {
          assignee: 1,
          attachment_uploader: 1,
          comment_author: 1,
          history_actor: 1,
          mention: 1,
          workflow_member: 1,
        },
      },
    ]);
  });

  it('reports billing distributions and money ranges', () => {
    expect(report.billing.billingType).toEqual({
      '(empty)': 1,
      '(no fee)': 4,
      fixed: 2,
      folio: 1,
      hourly: 1,
      nowin: 1,
    });
    expect(report.billing.billableStatus).toEqual({ '(not billable)': 8, billed: 1, pending: 1 });
    expect(report.money.feeValue).toEqual({
      count: 6,
      nonNumeric: 0,
      zero: 2,
      negative: 0,
      decimals: 1,
      min: 0,
      max: 25000,
      median: 2750,
    });
    expect(report.money.budgets).toMatchObject({ count: 2, min: 230000, max: 250000 });
    expect(report.money.unit.guess).toBe('dollars');
  });

  it('finds date anomalies', () => {
    expect(report.dates.fields['cards.createdOn']).toEqual({ invalid: 1, 'iso-utc': 9 });
    expect(report.dates.fields['cards.updatedOn']).toEqual({ 'iso-utc': 9, timestamp: 1 });
    expect(report.dates.fields['cards.billable.billingDate']).toEqual({ 'date-only': 2 });
    expect(report.dates.fields['referrers.createdOn']).toEqual({ 'iso-utc': 1, missing: 2 });
    expect(report.dates.dueDates).toEqual({ melbourneMidnight: 3, utcMidnight: 1, otherTime: 0, differsFromUtc: 3 });
    expect(report.dates.updatedBeforeCreated).toBe(1);
  });

  it('counts rich-text features', () => {
    expect(report.html.description).toMatchObject({
      values: 10,
      empty: 8,
      mentions: 1,
      images: { inlineBase64: 1, remote: 1, other: 0 },
      links: 1,
      unsafe: { script: 1 },
    });
    expect(report.html.comment).toMatchObject({ values: 2, html: 1, plain: 1, mentions: 1 });
    expect(report.html.history.tags).toEqual({ strong: 2 });
  });

  it('reports attachment types, sizes and allow-list gaps', () => {
    expect(report.attachments).toMatchObject({
      count: 7,
      maxBytes: 27_262_976,
      overLegacyLimit: 1,
      byExtension: { docx: 1, jpg: 1, msg: 1, pdf: 3, svg: 1 },
      untyped: 1,
      notOnLegacyAllowList: {},
      notOnV2AllowList: { svg: 1 },
      sizeMismatch: 1,
    });
  });

  it('finds orphans and broken links', () => {
    expect(report.orphans).toEqual({
      attachmentsWithoutObject: [
        'workflows/0b6f1c2e-5d4a-4c3b-9a8e-222222222222/cards/EstateCardAuto000001/attachments/a77a0000-0000-4000-8000-000000000005',
      ],
      objectsWithoutDoc: { count: 2, bytes: 16_000, byKind: { 'card-attachment': 1, 'workflow-attachment': 1 } },
      linkedCards: { total: 6, migrated: 3, inExcludedWorkflow: 1, elsewhere: 1, missing: 1 },
      referrerIdsWithoutReferrer: 1,
    });
  });

  it('reports ids, membership drift, references, titles and priorities', () => {
    expect(report.ids).toEqual({
      cardIds: { 'auto-id': 10 },
      cardIdFieldMismatch: 0,
      cardWorkflowIdMismatch: 0,
      templateIdMismatch: 1,
    });
    expect(report.membership).toEqual({ duplicateUids: 1, uidsUsersDrift: 0 });
    expect(report.matterReference).toMatchObject({
      set: 4,
      empty: 1,
      null: 5,
      missing: 0,
      duplicates: 1,
      invalidAsNumber: 0,
    });
    expect(report.titles).toMatchObject({ empty: 1, needsTrim: 1 });
    expect(report.priorities.cards).toEqual({ 0: 6, 1: 2, 2: 1, 3: 1 });
    expect(report.priorities.checklistItems).toEqual({ 0: 3, 1: 1 });
  });

  it('profiles referrers, the user profile and the rest', () => {
    expect(report.referrers).toEqual({
      total: 3,
      person: 1,
      organisation: 1,
      neither: 1,
      industries: { '(none)': 1, accountant: 1, funeral_director: 1 },
      phones: { 'au-landline': 1, 'au-mobile': 1, empty: 1 },
      emails: { invalid: 1, missing: 1, valid: 1 },
      withoutTimestamps: 2,
      usedByCards: 2,
    });
    expect(report.profile).toEqual({
      exists: true,
      companyName: 'Rivers Wills & Estates',
      hasBudgetFields: true,
      profileImage: true,
    });
    expect(report.integrations).toEqual({ 'calendar/google': 1, 'calendar/microsoft': 1 });
    expect(report.workspaces).toEqual({ total: 2, prime: 1, nonPrime: ['Old workspace'] });
    expect(report.calendar).toEqual({ linkedChecklistItems: 1, legacyCalendarSync: 1 });
    expect(report.auth).toBeNull();
  });

  it('raises a warning code for each hazard found', () => {
    expect(report.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'MIG_A_EXCLUDED_WORKFLOWS',
        'MIG_A_UNKNOWN_SWIMLANE',
        'MIG_A_FOREIGN_ASSIGNEE',
        'MIG_A_TIMESTAMP_VALUES',
        'MIG_A_INVALID_DATES',
        'MIG_A_INLINE_IMAGES',
        'MIG_A_UNSAFE_HTML',
        'MIG_A_ORPHAN_ATTACHMENT',
        'MIG_A_ORPHAN_OBJECT',
        'MIG_A_BROKEN_LINK',
        'MIG_A_LARGE_ATTACHMENT',
        'MIG_A_TYPE_NOT_ON_V2_LIST',
        'MIG_A_LEGACY_FIELDS',
        'MIG_A_TEMPLATE_ID',
        'MIG_A_DUPLICATE_REFERENCE',
        'MIG_A_EMPTY_TITLE',
        'MIG_A_CALENDAR_LINKED',
      ]),
    );
    expect(report.warnings.map((w) => w.code)).not.toContain('MIG_A_PROFILE_INCOMPLETE');
    expect(report.warnings.every((w) => w.count > 0)).toBe(true);
  });

  it('holds no document content', () => {
    const { docs } = loadLegacyFixtures();
    const secrets = new Set<string>();
    for (const doc of docs) {
      const d = doc.data;
      if (doc.path.includes('/cards/') && !doc.path.includes('/attachments/')) {
        for (const key of ['title', 'description'])
          if (typeof d[key] === 'string' && d[key].trim()) secrets.add(d[key].trim());
        for (const c of (d['comments'] as { comment: string }[]) ?? []) secrets.add(c.comment);
      }
      if (doc.path.includes('/attachments/')) secrets.add(String(d['originalFileName']));
      if (doc.path.startsWith('referrers/')) {
        for (const key of ['name', 'company', 'phone', 'email', 'address'])
          if (typeof d[key] === 'string' && d[key]) secrets.add(d[key]);
      }
      if (doc.path.startsWith('profiles/')) secrets.add(String(d['email']));
    }
    secrets.add('Initial call booked');
    secrets.add('Professional fees');
    secrets.add('14 days');
    secrets.add('Send engagement letter');
    secrets.add('not-a-real-token');
    const outputs = [JSON.stringify(report), renderAuditMarkdown(report)];
    for (const secret of secrets) for (const output of outputs) expect(output).not.toContain(secret);
  });
});

describe('auditSnapshot with a mapping profile', () => {
  it('takes scope from the profile and checks it covers the data', () => {
    const withProfile = auditSnapshot(snapshot, { ...options, profile: fixtureProfile });
    expect(withProfile.scope.rule).toBe('profile');
    expect(withProfile.scope.excluded).toEqual([{ name: 'Shared board', reason: "Alex doesn't own it" }]);
    expect(withProfile.workflows.find((w) => w.name === 'Business development')?.mode).toBe('personal_tasks');
    expect(withProfile.profileCoverage).toEqual({
      ok: true,
      unmappedWorkflows: [],
      unknownWorkflows: [],
      unmappedSwimlanes: [],
      unknownSwimlanes: [],
    });
  });

  it('warns when the profile misses a swimlane', () => {
    const partial = MappingProfileSchema.parse({
      ...fixtureProfile,
      workflows: fixtureProfile.workflows.map((w) =>
        w.mode === 'matters' && w.name === 'Estates' ? { ...w, swimlanes: w.swimlanes.slice(0, 2) } : w,
      ),
    });
    const withProfile = auditSnapshot(snapshot, { ...options, profile: partial });
    expect(withProfile.profileCoverage?.unmappedSwimlanes).toEqual([{ workflow: 'Estates', swimlane: 'Done' }]);
    expect(withProfile.warnings.map((w) => w.code)).toContain('MIG_A_PROFILE_INCOMPLETE');
  });
});

describe('money helpers', () => {
  it('summarises numbers, ignoring missing values', () => {
    expect(numberRange([3, 1, 2, null, 'x', undefined])).toEqual({
      count: 3,
      nonNumeric: 2,
      zero: 0,
      negative: 0,
      decimals: 0,
      min: 1,
      max: 3,
      median: 2,
    });
    expect(numberRange([])).toMatchObject({ count: 0, min: null, median: null });
  });

  it('reads amounts as dollars unless the data looks like cents', () => {
    expect(feeUnit(numberRange([3300, 5500]))).toMatchObject({ guess: 'dollars' });
    expect(feeUnit(numberRange([]))).toMatchObject({ guess: 'dollars' });
    expect(feeUnit(numberRange([330000, 550000, 1200000]))).toMatchObject({ guess: 'unclear' });
  });
});
