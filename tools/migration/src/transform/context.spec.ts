import { domain } from '../domain.ts';
import { FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { FILE_MISSING, FILE_NOT_COPIED } from '../load/run-files.ts';
import type { MappingProfile } from '../profile.ts';
import {
  cutAt,
  ENTITIES,
  fit,
  MIG_NAMESPACE,
  MIGRATION_ACTOR,
  migId,
  migratedMeta,
  personName,
  plainMeta,
  REVIEW_CODES,
  WARNING_CODES,
  WARNINGS,
  Warnings,
} from './context.ts';
import { loadSpecProfile, SPEC_AS_OF, specContext, warned } from './spec-helpers.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const CARD = 'workflows/wf1/cards/Card0000000000000001';

describe('migId', () => {
  it('is the deterministic id of the legacy path in the mig namespace', () => {
    expect(MIG_NAMESPACE).toBe('mig');
    expect(migId(CARD)).toBe(domain.deterministicId('mig', CARD));
    expect(migId(CARD)).toMatch(/^[0-9A-Za-z]{20}$/);
  });

  it('gives the same id for the same key, every time', () => {
    expect(migId(CARD)).toBe(migId(CARD));
    expect(migId(`${CARD}#client`)).toBe(migId(`${CARD}#client`));
  });

  it('gives different ids for different keys and parts', () => {
    const ids = new Set([
      migId(CARD),
      migId(`${CARD}#client`),
      migId('workflows/wf1/cards/Card0000000000000002'),
      migId(''),
    ]);
    expect(ids.size).toBe(4);
    expect(migId(CARD)).not.toBe(domain.deterministicId('other', CARD));
  });
});

describe('Warnings', () => {
  it('records a code against a path and answers has()', () => {
    const warnings = new Warnings();
    expect(warnings.has('MIG_W_DATE_INVALID', CARD)).toBe(false);
    warnings.add('MIG_W_DATE_INVALID', CARD);
    expect(warnings.has('MIG_W_DATE_INVALID', CARD)).toBe(true);
    expect(warnings.has('MIG_W_DATE_INVALID', 'workflows/wf1/cards/other')).toBe(false);
    expect(warnings.has('MIG_W_LABEL_UNKNOWN', CARD)).toBe(false);
  });

  it('summarises every code, zero counts included, with its meaning', () => {
    const summary = new Warnings().summary();
    expect(Object.keys(summary)).toEqual(WARNING_CODES);
    expect(WARNING_CODES).toEqual(Object.keys(WARNINGS));
    for (const code of WARNING_CODES) {
      expect(summary[code]).toEqual({ count: 0, meaning: WARNINGS[code], paths: [] });
    }
  });

  it('counts each path once and lists the paths sorted', () => {
    const warnings = new Warnings();
    warnings.add('MIG_W_LABEL_UNKNOWN', 'workflows/wf1/cards/c3');
    warnings.add('MIG_W_LABEL_UNKNOWN', 'workflows/wf1/cards/c1');
    warnings.add('MIG_W_LABEL_UNKNOWN', 'workflows/wf1/cards/c3');
    warnings.add('MIG_W_LABEL_UNKNOWN', 'workflows/wf1/cards/c2');
    warnings.add('MIG_W_PRIORITY_UNKNOWN', 'workflows/wf1/cards/c1');
    const summary = warnings.summary();
    expect(summary.MIG_W_LABEL_UNKNOWN).toEqual({
      count: 3,
      meaning: WARNINGS.MIG_W_LABEL_UNKNOWN,
      paths: ['workflows/wf1/cards/c1', 'workflows/wf1/cards/c2', 'workflows/wf1/cards/c3'],
    });
    expect(summary.MIG_W_PRIORITY_UNKNOWN.count).toBe(1);
    expect(summary.MIG_W_DATE_INVALID.count).toBe(0);
  });

  it('sorts paths by code unit, not locale', () => {
    const warnings = new Warnings();
    for (const path of ['b', 'a', 'B', 'A']) warnings.add('MIG_W_UNTITLED', path);
    expect(warnings.summary().MIG_W_UNTITLED.paths).toEqual(['A', 'B', 'a', 'b']);
  });
});

describe('review codes and entities', () => {
  it('are unique', () => {
    expect(new Set(REVIEW_CODES).size).toBe(REVIEW_CODES.length);
    expect(new Set(ENTITIES).size).toBe(ENTITIES.length);
  });

  // The app's review queue (MIG-08) lists and explains each code the transform and load stamp.
  it('are all codes the review queue knows, the load’s for a file not brought too', () => {
    for (const code of [...REVIEW_CODES, FILE_MISSING, FILE_NOT_COPIED]) {
      expect(domain.isMigrationReviewCode(code), code).toBe(true);
    }
  });
});

describe('personName', () => {
  it("is the subject's own name for the subject, the people map's otherwise", () => {
    const ctx = specContext(profile, {
      people: new Map([
        [FIXTURE_UIDS.colleague, 'Jordan Ellis'],
        [FIXTURE_UIDS.departed, null],
      ]),
    });
    expect(personName(ctx, FIXTURE_UIDS.subject, 'Alex Rivers')).toBe('Alex Rivers');
    expect(personName(ctx, FIXTURE_UIDS.colleague, 'Alex Rivers')).toBe('Jordan Ellis');
    expect(personName(ctx, FIXTURE_UIDS.departed, 'Alex Rivers')).toBeNull();
    expect(personName(ctx, FIXTURE_UIDS.stranger, 'Alex Rivers')).toBeNull();
  });
});

describe('migratedMeta', () => {
  const createdAt = new Date('2024-02-01T01:00:00.000Z');
  const updatedAt = new Date('2025-05-01T01:00:00.000Z');

  it('stamps the record with its writer, dates, schema version and migration', () => {
    const ctx = specContext(profile);
    expect(migratedMeta(ctx, { legacyPath: CARD, createdAt, updatedAt, by: FIXTURE_UIDS.subject })).toEqual({
      createdAt,
      createdBy: FIXTURE_UIDS.subject,
      updatedAt,
      updatedBy: FIXTURE_UIDS.subject,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: CARD, loadedAt: SPEC_AS_OF },
    });
  });

  it('names the migration actor for someone who is not a member', () => {
    const ctx = specContext(profile);
    const meta = migratedMeta(ctx, { legacyPath: CARD, createdAt, updatedAt, by: MIGRATION_ACTOR });
    expect(meta).toMatchObject({ createdBy: 'migration', updatedBy: 'migration' });
  });

  it('lists each review code once, in first-seen order', () => {
    const ctx = specContext(profile);
    const meta = migratedMeta(ctx, {
      legacyPath: CARD,
      createdAt,
      updatedAt,
      by: FIXTURE_UIDS.subject,
      needsReview: ['swimlane_unknown', 'fee_type_missing', 'swimlane_unknown', 'title_missing', 'fee_type_missing'],
    });
    expect(meta['needsReview']).toEqual(['swimlane_unknown', 'fee_type_missing', 'title_missing']);
  });

  it('leaves needsReview out when there is nothing to review', () => {
    const ctx = specContext(profile);
    const base = { legacyPath: CARD, createdAt, updatedAt, by: FIXTURE_UIDS.subject };
    expect(migratedMeta(ctx, { ...base, needsReview: [] })).not.toHaveProperty('needsReview');
    expect(migratedMeta(ctx, base)).not.toHaveProperty('needsReview');
  });

  it('validates as the meta of a v2 contact', () => {
    const ctx = specContext(profile);
    const meta = migratedMeta(ctx, {
      legacyPath: 'referrers/r1',
      createdAt,
      updatedAt,
      by: FIXTURE_UIDS.subject,
      needsReview: ['referrer_unnamed'],
    });
    const contact = {
      kind: 'organisation',
      orgName: 'Fictional Funeral Services',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: true,
      matterRoles: [],
      search: ['fictional'],
      dedupeKey: 'org:fictional funeral services',
      sortName: 'fictional funeral services',
      ...meta,
    };
    expect(domain.ContactSchema.safeParse(contact).success).toBe(true);
  });
});

describe('plainMeta', () => {
  it('stamps server-only documents with the export time and the migration actor', () => {
    const ctx = specContext(profile);
    expect(plainMeta(ctx)).toEqual({
      createdAt: SPEC_AS_OF,
      createdBy: 'migration',
      updatedAt: SPEC_AS_OF,
      updatedBy: 'migration',
      schemaVersion: 1,
    });
  });
});

describe('fit', () => {
  it('keeps text within the limit as it is, without a warning', () => {
    const ctx = specContext(profile);
    expect(fit(ctx, 'Estate of Sam Example', 40, CARD)).toBe('Estate of Sam Example');
    expect(fit(ctx, 'exactly10!', 10, CARD)).toBe('exactly10!');
    expect(fit(ctx, '', 0, CARD)).toBe('');
    expect(warned(ctx)).toEqual({});
  });

  it('cuts longer text to the limit, trims the cut end and warns', () => {
    const ctx = specContext(profile);
    expect(fit(ctx, 'Will and powers of attorney', 9, CARD)).toBe('Will and');
    expect(fit(ctx, 'abcdefghij', 4, `${CARD}#group`)).toBe('abcd');
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [CARD, `${CARD}#group`] });
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const ctx = specContext(profile);
    expect(fit(ctx, 'Plan 😀 meeting', 6, CARD)).toBe('Plan');
    expect(fit(ctx, 'Plan 😀 meeting', 7, CARD)).toBe('Plan 😀');
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [CARD] });
  });
});

describe('cutAt', () => {
  it('keeps the first max UTF-16 units', () => {
    expect(cutAt('Estate of Sam Example', 6)).toBe('Estate');
    expect(cutAt('short', 10)).toBe('short');
    expect(cutAt('trailing  ', 9)).toBe('trailing ');
    expect(cutAt('', 3)).toBe('');
  });

  it('drops a high surrogate the cut would leave at the end', () => {
    expect(cutAt('a😀b', 2)).toBe('a');
    expect(cutAt('a😀b', 3)).toBe('a😀');
    expect(cutAt('😀', 1)).toBe('');
  });
});
