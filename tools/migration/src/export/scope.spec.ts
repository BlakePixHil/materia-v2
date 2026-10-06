import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { memoryReader, type LegacyReader } from '../legacy/reader.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { changedSince, collectExport, EXPORT_FILES, UnmappedWorkflowsError } from './scope.ts';

const UID = FIXTURE_UIDS.subject;
const WILLS = '0b6f1c2e-5d4a-4c3b-9a8e-111111111111';
const SHARED = '0b6f1c2e-5d4a-4c3b-9a8e-444444444444';
const OTHERS = '0b6f1c2e-5d4a-4c3b-9a8e-555555555555';

const { docs, objects } = loadLegacyFixtures();
let profile: MappingProfile;
let reader: LegacyReader;

beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

beforeEach(() => {
  reader = {
    ...memoryReader(docs, [...objects, { name: `profile-images/${UID}0.png`, size: 1 }]),
    authRecord: async () => ({ email: 'alex.rivers@example.com', providers: ['google.com'] }),
  };
});

const counts = (files: Record<string, unknown[]>) =>
  Object.fromEntries(Object.entries(files).map(([file, records]) => [file, records.length]));

describe('collectExport', () => {
  it("reads the user's data the profile keeps", async () => {
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true });
    expect(Object.keys(scope.files)).toEqual([...EXPORT_FILES]);
    expect(counts(scope.files)).toEqual({
      profiles: 1,
      'dashboard-checklist-items': 2,
      integrations: 2,
      workspaces: 2,
      workflows: 3,
      cards: 10,
      attachments: 7,
      'checklist-templates': 2,
      referrers: 3,
      people: 2,
      auth: 1,
      'storage-objects': 9,
    });
    expect(scope.workflows).toEqual({
      exported: [WILLS, '0b6f1c2e-5d4a-4c3b-9a8e-222222222222', '0b6f1c2e-5d4a-4c3b-9a8e-333333333333'],
      excluded: [SHARED],
      unmapped: [],
    });
    expect(scope.notifications).toBe(2);
    expect(scope.warnings).toEqual([]);
  });

  it('leaves out excluded boards, boards the user is not on, and other users', async () => {
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true });
    const paths = Object.values(scope.files).flatMap((records) => records.map((r) => r.path));
    expect(paths.filter((p) => p.includes(SHARED) || p.includes(OTHERS))).toEqual([]);
    expect(paths).not.toContain('referrers/7e7e0000-0000-4000-8000-000000000004');
    expect(scope.files.profiles.map((r) => r.path)).toEqual([`profiles/${UID}`]);
    // Another uid that starts with the user's isn't the user's photo.
    expect(scope.files['storage-objects'].map((r) => r.path)).not.toContain(`profile-images/${UID}0.png`);
    expect(scope.files['storage-objects'].map((r) => r.path)).toContain(`profile-images/${UID}.png`);
  });

  it("keeps only the names from other users' profiles", async () => {
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true });
    expect(scope.files.people).toEqual([
      { path: `profiles/${FIXTURE_UIDS.departed}`, data: null },
      { path: `profiles/${FIXTURE_UIDS.colleague}`, data: { displayName: '', firstName: 'Jordan', lastName: 'Ellis' } },
    ]);
  });

  it('keeps every card, archived ones too, sorted by path, without download tokens', async () => {
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true });
    const paths = scope.files.cards.map((r) => r.path);
    expect(paths).toEqual([...paths].sort());
    expect(scope.files.cards.some((r) => r.data?.['archived'] === true)).toBe(true);
    expect(scope.downloadTokensStripped).toBe(7);
    expect(JSON.stringify(scope.files)).not.toContain('token=');
    expect(scope.files.attachments[0]?.data?.['downloadUrl']).toBe(
      'https://firebasestorage.googleapis.com/v0/b/fictional/o/x?alt=media',
    );
  });

  it('records each Storage object with its checksums', async () => {
    reader = memoryReader(docs, [{ name: `profile-images/${UID}.png`, size: 5, md5Hash: 'bWQ1', generation: '3' }]);
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true });
    expect(scope.files['storage-objects']).toEqual([
      {
        path: `profile-images/${UID}.png`,
        data: { name: `profile-images/${UID}.png`, size: 5, md5Hash: 'bWQ1', generation: '3' },
      },
    ]);
  });

  it('says what it could not read', async () => {
    const noCount: LegacyReader = memoryReader(docs, objects);
    delete noCount.count;
    const scope = await collectExport(noCount, { uid: UID, profile, readAuth: false });
    expect(scope.files.auth).toEqual([]);
    expect(scope.notifications).toBeNull();
    expect(scope.warnings).toEqual([
      "The reader can't count notifications.",
      "These credentials can't read Auth (firebaseauth.users.get), so auth.jsonl is empty.",
    ]);
  });

  it('stops before reading any card when the profile misses a workflow', async () => {
    const partial = { ...profile, workflows: profile.workflows.filter((w) => w.name !== 'Estates') };
    const list = vi.spyOn(reader, 'list');
    const error = await collectExport(reader, { uid: UID, profile: partial, readAuth: true }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnmappedWorkflowsError);
    expect((error as UnmappedWorkflowsError).workflowIds).toEqual(['0b6f1c2e-5d4a-4c3b-9a8e-222222222222']);
    expect(list.mock.calls.filter(([path]) => path.endsWith('/cards'))).toEqual([]);
  });
});

describe('a delta', () => {
  it('keeps the cards changed since, with all their attachments, and lists every path', async () => {
    const since = '2025-02-05T00:00:00.000Z';
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true, since });
    // WillsCardAuto0000003 was last updated 1 February (a Timestamp) and has no readable createdOn.
    expect(scope.files.cards.map((r) => r.path)).not.toContain(`workflows/${WILLS}/cards/WillsCardAuto0000003`);
    // WillsCardAuto0000004 was "updated" before it was created on 1 March, so it counts as changed.
    expect(scope.files.cards.map((r) => r.path)).toContain(`workflows/${WILLS}/cards/WillsCardAuto0000004`);
    expect(scope.files.cards).toHaveLength(9);
    expect(scope.files.attachments).toHaveLength(7);
    expect(scope.files.workflows).toHaveLength(3);
    expect(scope.delta).toEqual({
      since,
      paths: expect.any(Array),
      unchanged: { cards: 1, attachments: 0 },
      nonUniform: { cards: 1 },
    });
    expect(scope.delta?.paths).toHaveLength(17);
    expect(scope.delta?.paths.every((r) => r.data === null)).toBe(true);
  });

  it('keeps nothing unchanged after the last change', async () => {
    const scope = await collectExport(reader, { uid: UID, profile, readAuth: true, since: '2026-01-01T00:00:00Z' });
    expect(scope.files.cards).toEqual([]);
    expect(scope.files.attachments).toEqual([]);
    expect(scope.files.referrers).toHaveLength(3);
  });

  it('counts a record with no readable date as changed', () => {
    const since = Date.parse('2025-01-01T00:00:00Z');
    expect(changedSince({ updatedOn: '2025-02-01T00:00:00.000Z' }, since)).toBe(true);
    expect(changedSince({ updatedOn: '2024-02-01T00:00:00.000Z' }, since)).toBe(false);
    expect(changedSince({ updatedOn: { $timestamp: '2025-02-01T00:00:00Z' } }, since)).toBe(true);
    expect(changedSince({ updatedOn: '2024-02-01T00:00:00Z', createdOn: '2025-03-01T00:00:00Z' }, since)).toBe(true);
    expect(changedSince({ updatedOn: 'yesterday' }, since)).toBe(true);
    expect(changedSince({}, since)).toBe(true);
    expect(changedSince(null, since)).toBe(true);
  });
});
