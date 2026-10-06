import { domain } from '../domain.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import type { MatterRef } from './comments.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';
import { LEGACY_HISTORY_KIND, mapHistory } from './history.ts';

const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const CARD = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/WillsCardAuto0000001';
const AS_OF = new Date('2026-10-06T21:00:00.123Z');

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map([[COLLEAGUE, 'Jordan Ellis']]),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

const matter: MatterRef = {
  orgId: 'org1',
  matterId: migId(CARD),
  cardPath: CARD,
  createdAt: new Date('2025-01-10T00:30:00.000Z'),
  updatedAt: new Date('2025-02-10T00:30:00.000Z'),
};

/** The fixture card's history (WillsCardAuto0000001). */
const history = [
  {
    id: '41570001-0000-4000-8000-000000000000',
    action: {
      id: 'ac710000-0000-4000-8000-000000000001',
      name: 'Created card',
      description: '<strong>Alex Rivers</strong> created card',
    },
    uid: UID,
    date: '2025-01-10T00:30:00.000Z',
  },
  {
    id: '41570002-0000-4000-8000-000000000000',
    action: {
      id: 'ac710000-0000-4000-8000-000000000002',
      name: 'Moved card',
      description: '<strong>Jordan Ellis</strong> moved card from <em>Drafting</em> to <em>Signed</em>',
    },
    uid: COLLEAGUE,
    date: '2025-01-11T00:30:00.000Z',
  },
];

describe('mapHistory', () => {
  it("turns the card's history into the matter's activity feed", () => {
    const ctx = makeCtx();
    const [created, moved, ...rest] = mapHistory(ctx, matter, history);
    expect(rest).toEqual([]);
    const createdPath = `${CARD}#history/41570001-0000-4000-8000-000000000000`;
    expect(created?.entity).toBe('activity');
    expect(created?.legacyPath).toBe(createdPath);
    expect(created?.path).toBe(`orgs/org1/matters/${matter.matterId}/activity/${migId(createdPath)}`);
    const at = new Date('2025-01-10T00:30:00.000Z');
    expect(created?.data).toEqual({
      kind: LEGACY_HISTORY_KIND,
      summary: 'Alex Rivers created card',
      actorUid: UID,
      at,
      refs: { legacyAction: 'Created card' },
      createdAt: at,
      createdBy: UID,
      updatedAt: at,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: createdPath, loadedAt: AS_OF },
    });
    expect(moved?.data).toMatchObject({
      kind: 'legacy_history',
      // HTML stripped; the display name frozen in it stays as text.
      summary: 'Jordan Ellis moved card from Drafting to Signed',
      actorUid: 'migration',
      at: new Date('2025-01-11T00:30:00.000Z'),
      createdBy: 'migration',
      updatedBy: 'migration',
      refs: { legacyAction: 'Moved card' },
    });
    for (const record of [created, moved]) {
      expect(domain.ActivitySchema.parse(record?.data)).toEqual(record?.data);
    }
    expect(warned(ctx)).toEqual({});
  });

  it('removes scripts with their content from the summary', () => {
    const [record] = mapHistory(makeCtx(), matter, [
      { id: 'h1', action: { name: 'Edited', description: 'Edited <script>alert(1)</script>the title' }, uid: UID },
    ]);
    expect(record?.data?.['summary']).toBe('Edited the title');
  });

  it("falls back to the action's name when the description has no text", () => {
    const records = mapHistory(makeCtx(), matter, [
      { id: 'h1', action: { name: '  Archived   card ', description: '<p> </p>' }, uid: UID },
      { id: 'h2', action: { name: 'Renamed card' }, uid: UID },
      { id: 'h3', action: { name: 'Labelled', description: 42 }, uid: UID },
    ]);
    expect(records.map((record) => record.data?.['summary'])).toEqual(['Archived card', 'Renamed card', 'Labelled']);
    expect(records.map((record) => record.data?.['refs'])).toEqual([
      { legacyAction: 'Archived card' },
      { legacyAction: 'Renamed card' },
      { legacyAction: 'Labelled' },
    ]);
  });

  it('says "Updated (imported)" when there is neither, with no legacy action', () => {
    const records = mapHistory(makeCtx(), matter, [
      { id: 'h1', action: { name: '', description: '' }, uid: UID },
      { id: 'h2', uid: UID },
      { id: 'h3', action: 'moved', uid: UID },
    ]);
    expect(records.map((record) => record.data?.['summary'])).toEqual([
      'Updated (imported)',
      'Updated (imported)',
      'Updated (imported)',
    ]);
    expect(records.map((record) => record.data?.['refs'])).toEqual([{}, {}, {}]);
    for (const record of records) expect(() => domain.ActivitySchema.parse(record.data)).not.toThrow();
  });

  it("is the migration's for anyone but the user, including no one", () => {
    const records = mapHistory(makeCtx(), matter, [
      { id: 'h1', action: { name: 'A' }, uid: COLLEAGUE },
      { id: 'h2', action: { name: 'B' } },
      { id: 'h3', action: { name: 'C' }, uid: 42 },
      { id: 'h4', action: { name: 'D' }, uid: UID },
    ]);
    expect(records.map((record) => record.data?.['actorUid'])).toEqual(['migration', 'migration', 'migration', UID]);
  });

  it.each([undefined, 'not a date', '2025-02-30T00:00:00.000Z'])(
    'dates an entry with a missing or invalid date (%j) at the export time, with a warning',
    (date) => {
      const ctx = makeCtx();
      const [record] = mapHistory(ctx, matter, [{ id: 'h1', action: { name: 'A' }, uid: UID, date }]);
      expect(record?.data).toMatchObject({ at: AS_OF, createdAt: AS_OF, updatedAt: AS_OF });
      expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${CARD}#history/h1`] });
    },
  );

  it('reads a Firestore Timestamp date', () => {
    const [record] = mapHistory(makeCtx(), matter, [
      { id: 'h1', action: { name: 'A' }, uid: UID, date: { $timestamp: '2025-01-11T00:30:00Z' } },
    ]);
    expect(record?.data?.['at']).toEqual(new Date('2025-01-11T00:30:00Z'));
  });

  it("keys an entry without an id by its index, and skips entries that aren't objects", () => {
    const records = mapHistory(makeCtx(), matter, [
      null,
      { action: { name: 'A' }, uid: UID, date: '2025-01-11T00:30:00Z' },
      7,
      { id: '', action: { name: 'B' }, uid: UID, date: '2025-01-11T00:30:00Z' },
    ]);
    expect(records.map((record) => record.legacyPath)).toEqual([`${CARD}#history/1`, `${CARD}#history/3`]);
  });

  it.each([undefined, null, {}, 'history'])('makes nothing of a history that is not a list (%j)', (raw) => {
    expect(mapHistory(makeCtx(), matter, raw)).toEqual([]);
  });
});
