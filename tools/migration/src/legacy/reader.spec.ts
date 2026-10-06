import { FIXTURE_UIDS, loadLegacyFixtures } from './fixtures.ts';
import { collectSnapshot, memoryReader, type LegacyReader } from './reader.ts';

const { subject, colleague, departed, stranger } = FIXTURE_UIDS;

describe('collectSnapshot', () => {
  const { docs, objects } = loadLegacyFixtures();

  it("reads the user's workflows (as member or legacy owner) with their cards, files and templates", async () => {
    const snapshot = await collectSnapshot(memoryReader(docs, objects), subject);
    expect(snapshot.workflows.map((w) => w.data['name'])).toEqual([
      'Wills & powers',
      'Estates',
      'Business development',
      'Shared board',
    ]);
    expect(snapshot.cards).toHaveLength(11);
    expect(snapshot.cards.some((c) => c.path.includes('OtherCardAuto'))).toBe(false);
    expect(snapshot.attachments).toHaveLength(8);
    expect(snapshot.checklistTemplates).toHaveLength(2);
    expect(snapshot.profile?.path).toBe(`profiles/${subject}`);
    expect(snapshot.dashboardItems).toHaveLength(2);
    expect(snapshot.integrations).toHaveLength(2);
    expect(snapshot.workspaces).toHaveLength(2);
    expect(snapshot.referrers.map((r) => r.data['uids'])).not.toContainEqual([stranger]);
    expect(snapshot.referrers).toHaveLength(3);
    expect(snapshot.storageObjects.map((o) => o.name)).toContain(`profile-images/${subject}.png`);
    expect(snapshot.auth).toBeUndefined();
  });

  it('keeps only the names of the other users the data references', async () => {
    const snapshot = await collectSnapshot(memoryReader(docs, objects), subject);
    expect(snapshot.people).toEqual({
      [colleague]: { exists: true, name: 'Jordan Ellis' },
      [departed]: { exists: false, name: null },
    });
    expect(JSON.stringify(snapshot.people)).not.toContain('@example.com');
  });

  it('checks whether linked cards outside the snapshot still exist', async () => {
    const snapshot = await collectSnapshot(memoryReader(docs, objects), subject);
    expect(snapshot.linkedCardsElsewhere).toEqual({
      '0b6f1c2e-5d4a-4c3b-9a8e-111111111111/MissingCardAuto00001': false,
      '0b6f1c2e-5d4a-4c3b-9a8e-555555555555/OtherCardAuto0000001': true,
    });
  });

  it('includes the Auth summary when the reader can see Auth', async () => {
    const auth = {
      found: true,
      providers: ['google.com'],
      hasPassword: false,
      mfaEnrolled: false,
      disabled: false,
      emailVerified: true,
    };
    const reader: LegacyReader = { ...memoryReader(docs, objects), authUser: async () => auth };
    expect((await collectSnapshot(reader, subject)).auth).toEqual(auth);
  });

  it('returns an empty snapshot for a user with no data', async () => {
    const snapshot = await collectSnapshot(memoryReader(docs, objects), 'NobodyAtAllLegacyUid00000000');
    expect(snapshot).toMatchObject({ profile: null, workflows: [], cards: [], referrers: [], people: {} });
  });
});

describe('memoryReader', () => {
  const reader = memoryReader(
    [
      { path: 'workflows/a', data: { uids: ['u1'], owner: 'u2' } },
      { path: 'workflows/a/cards/c', data: {} },
      { path: 'other/b', data: { uids: ['u1'] } },
    ],
    [{ name: 'x/1', size: 1 }],
  );

  it('lists direct children only and filters top-level queries', async () => {
    expect((await reader.list('workflows')).map((d) => d.path)).toEqual(['workflows/a']);
    expect((await reader.query('workflows', 'uids', 'array-contains', 'u1')).map((d) => d.path)).toEqual([
      'workflows/a',
    ]);
    expect(await reader.query('workflows', 'owner', '==', 'u2')).toHaveLength(1);
    expect(await reader.query('workflows', 'owner', '==', 'u1')).toHaveLength(0);
    expect(await reader.get('workflows/missing')).toBeNull();
    expect(await reader.objects('x/')).toEqual([{ name: 'x/1', size: 1 }]);
  });
});
