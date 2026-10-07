import { randomUUID } from 'node:crypto';

import {
  isMigrationReviewCode,
  MIGRATION_REVIEW_CODE_LIST,
  MIGRATION_REVIEW_CODES,
  MigrationReviewInput,
  migrationReviewEntityOf,
  migrationReviewPercent,
  ResolveMigrationReviewInput,
  reviewCodesFixedBy,
  reviewPatch,
} from './migration-review';
import { MigrationMetaShape } from './schemas/common';
import { MigrationRun } from './schemas/migration-runs';

const DELETE = Symbol('delete');

describe('the review code catalogue', () => {
  it('explains every code, with a matter tab for each matter fix', () => {
    for (const code of MIGRATION_REVIEW_CODE_LIST) {
      const info = MIGRATION_REVIEW_CODES[code];
      expect(info.label, code).toMatch(/\S/);
      expect(info.help, code).toMatch(/\.$/);
      if (info.fix === 'matter') expect('tab' in info, code).toBe(true);
    }
    expect(isMigrationReviewCode('title_missing')).toBe(true);
    expect(isMigrationReviewCode('toString')).toBe(false);
  });
});

describe('migrationReviewEntityOf', () => {
  it('names the entity of each path the review covers, and nothing else', () => {
    expect(migrationReviewEntityOf('o1', 'orgs/o1')).toBe('org');
    expect(migrationReviewEntityOf('o1', 'orgs/o1/matters/m1')).toBe('matter');
    expect(migrationReviewEntityOf('o1', 'orgs/o1/contacts/c1')).toBe('contact');
    expect(migrationReviewEntityOf('o1', 'orgs/o1/members/u1')).toBe('member');
    expect(migrationReviewEntityOf('o1', 'orgs/o1/matters/m1/documents/d1')).toBe('document');
    expect(migrationReviewEntityOf('o1', 'orgs/o2/matters/m1')).toBeNull();
    expect(migrationReviewEntityOf('o1', 'orgs/o1/invoices/i1')).toBeNull();
    expect(migrationReviewEntityOf('o1', 'orgs/o1/matters/m1/notes/n1')).toBeNull();
    expect(migrationReviewEntityOf('o1', 'orgs/o1/matters//documents/d1')).toBeNull();
  });
});

describe('reviewCodesFixedBy', () => {
  const before = {
    title: 'Untitled matter (imported)',
    fee: { arrangement: 'hourly' },
    needsReview: ['title_missing'],
  };

  it('clears a code when a field it names changes', () => {
    expect(reviewCodesFixedBy(before, { ...before, title: 'Estate of Fictional Wren' })).toEqual(['title_missing']);
    const fees = { ...before, needsReview: ['fee_type_missing', 'fee_disbursements'] };
    expect(reviewCodesFixedBy(fees, { ...fees, fee: { arrangement: 'fixed', amountCents: 330000 } })).toEqual([
      'fee_type_missing',
    ]);
  });

  it('leaves codes alone when nothing they name changed', () => {
    expect(reviewCodesFixedBy(before, { ...before, fee: { arrangement: 'hourly' } })).toEqual([]);
    expect(reviewCodesFixedBy(before, { ...before, labels: ['urgent'] })).toEqual([]);
    expect(reviewCodesFixedBy(undefined, before)).toEqual([]);
    expect(reviewCodesFixedBy(before, undefined)).toEqual([]);
  });

  it('clears every code once the record is deleted or merged away', () => {
    const contact = { orgName: 'Unnamed referrer (imported)', needsReview: ['referrer_unnamed'], deletedAt: null };
    expect(reviewCodesFixedBy(contact, { ...contact, deletedAt: new Date() })).toEqual(['referrer_unnamed']);
    expect(reviewCodesFixedBy(contact, { ...contact, mergedInto: 'c2' })).toEqual(['referrer_unnamed']);
  });

  it('compares Timestamps and dates by value', () => {
    const at = (ms: number) => ({ ms, isEqual: (other: { ms: number }) => other.ms === ms });
    const closed = { closing: { closedAt: at(1) }, needsReview: ['closed_without_closing_record'] };
    expect(reviewCodesFixedBy(closed, { ...closed, closing: { closedAt: at(1) } })).toEqual([]);
    expect(reviewCodesFixedBy(closed, { ...closed, closing: { closedAt: at(2) } })).toEqual([
      'closed_without_closing_record',
    ]);
  });
});

describe('reviewPatch', () => {
  it('moves the codes to reviewed, removing needsReview once empty', () => {
    const data = { needsReview: ['title_missing', 'client_from_title'], reviewed: ['swimlane_unknown'] };
    expect(reviewPatch(data, ['client_from_title'], DELETE)).toEqual({
      needsReview: ['title_missing'],
      reviewed: ['swimlane_unknown', 'client_from_title'],
    });
    expect(reviewPatch(data, ['title_missing', 'client_from_title'], DELETE)).toEqual({
      needsReview: DELETE,
      reviewed: ['swimlane_unknown', 'title_missing', 'client_from_title'],
    });
  });

  it('is null when none of the codes is open', () => {
    expect(reviewPatch({ reviewed: ['title_missing'] }, ['title_missing'], DELETE)).toBeNull();
    expect(reviewPatch(undefined, ['title_missing'], DELETE)).toBeNull();
  });
});

describe('migrationReviewPercent', () => {
  it('is reviewed over all codes, rounded down so 100 means none open', () => {
    expect(migrationReviewPercent(0, 0)).toBe(100);
    expect(migrationReviewPercent(1, 0)).toBe(0);
    expect(migrationReviewPercent(1, 11)).toBe(91);
    expect(migrationReviewPercent(1, 199)).toBe(99);
    expect(migrationReviewPercent(0, 12)).toBe(100);
  });
});

describe('callable inputs', () => {
  it('takes a code filter and a limit for the queue', () => {
    expect(MigrationReviewInput.safeParse({}).success).toBe(true);
    expect(MigrationReviewInput.safeParse({ code: 'title_missing', limit: 0 }).success).toBe(true);
    expect(MigrationReviewInput.safeParse({ code: 'not_a_code' }).success).toBe(false);
    expect(MigrationReviewInput.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('resolves named records or every record with a code, not both', () => {
    const requestId = randomUUID();
    const items = [{ path: 'orgs/o1/matters/m1', code: 'title_missing' }];
    expect(ResolveMigrationReviewInput.safeParse({ requestId, items }).success).toBe(true);
    expect(ResolveMigrationReviewInput.safeParse({ requestId, code: 'client_from_title' }).success).toBe(true);
    expect(ResolveMigrationReviewInput.safeParse({ requestId }).success).toBe(false);
    expect(ResolveMigrationReviewInput.safeParse({ requestId, items, code: 'title_missing' }).success).toBe(false);
    expect(ResolveMigrationReviewInput.safeParse({ requestId, items: [] }).success).toBe(false);
  });
});

describe('the schemas', () => {
  it('keep reviewed codes on a migrated record and when a run was reviewed', () => {
    expect(MigrationMetaShape.reviewed.safeParse(['title_missing']).success).toBe(true);
    expect(MigrationRun.schema.shape.reviewedAt.safeParse(new Date()).success).toBe(true);
    expect(MigrationRun.update.safeParse({ reviewedAt: new Date() }).success).toBe(false);
  });
});
