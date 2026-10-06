import { domain } from '../domain.ts';
import { readRawRun } from '../transform.ts';
import { migId, WARNING_CODES, type TransformedRecord } from './context.ts';
import { untagDates } from './output.ts';
import { IDMAP_FILE, REPORT_FILE, runTransform, TransformRefusedError, validateRecords, type RawRun } from './run.ts';
import { exportFixtureRun, FIXTURE_RUN_ID } from './testing.ts';
import { memorySink } from '../export/sink.ts';
import { FIXTURE_UIDS } from '../legacy/fixtures.ts';
import type { MappingProfile } from '../profile.ts';

/**
 * The transform end to end (MIG-03) on the synthetic legacy fixtures, exported the way MIG-02
 * does it: everything validates, the output matches the committed golden files byte for byte,
 * and the same run (in any input order) always gives the same bytes.
 */

const GOLDEN = '../../fixtures/golden/';
const args = (profile: MappingProfile, over: Partial<Parameters<typeof runTransform>[1]> = {}) => ({
  runId: FIXTURE_RUN_ID,
  profile,
  profileHash: 'fixture-profile',
  targetOrg: 'new',
  toolVersion: '0.0.0+test',
  ...over,
});

let raw: RawRun;
let profile: MappingProfile;
beforeAll(async () => {
  const run = await exportFixtureRun();
  profile = run.profile;
  raw = await readRawRun(memorySink(FIXTURE_RUN_ID, run.files));
});

const lines = (text: string | undefined) =>
  (text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => untagDates(JSON.parse(line)) as TransformedRecord);

describe('runTransform on the fixtures', () => {
  it('validates every record, rejects none, and matches the golden files', async () => {
    const output = runTransform(raw, args(profile));
    expect(output.rejected).toBe(false);
    expect(output.report.rejects).toEqual([]);
    for (const [name, text] of [...output.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await expect(text).toMatchFileSnapshot(`${GOLDEN}${name}`);
    }
  });

  it('gives byte-identical output on a re-run, whatever order the records arrive in', () => {
    const first = runTransform(raw, args(profile));
    const reversed: RawRun = {
      manifest: raw.manifest,
      files: Object.fromEntries(Object.entries(raw.files).map(([name, list]) => [name, [...(list ?? [])].reverse()])),
    };
    const again = runTransform(reversed, args(profile));
    expect([...again.files.keys()].sort()).toEqual([...first.files.keys()].sort());
    for (const [name, text] of first.files) expect(again.files.get(name)).toBe(text);
  });

  it('reports every warning code with its count and legacy paths only', () => {
    const { report } = runTransform(raw, args(profile));
    expect(Object.keys(report.warnings).sort()).toEqual([...WARNING_CODES].sort());
    const raised = Object.entries(report.warnings).filter(([, w]) => w.count > 0);
    expect(raised.length).toBeGreaterThan(25);
    for (const [, warning] of raised) {
      expect(warning.paths).toHaveLength(warning.count);
      for (const path of warning.paths) expect(path).toMatch(/^(profiles|workflows|referrers|workspaces)\//);
    }
    // No titles, names or text from the data leak into the report: only paths, codes and counts.
    const text = JSON.stringify(report);
    for (const secret of ['Fictional Client', 'Jordan', 'bowls club', 'not-an-email', 'alex.rivers@']) {
      expect(text).not.toContain(secret);
    }
    expect(report.counts.out.matters).toBe(8);
    expect(report.counts.in.cards).toBe(10);
    expect(report.needsReview.records).toBeGreaterThan(0);
    // Every matter's client is flagged: the untitled card's is the placeholder.
    expect(report.needsReview.byCode).toMatchObject({ client_from_title: 7, client_placeholder: 1 });
    expect(report.storage.orphans.map((o) => o.name)).toEqual([
      'workflows/0b6f1c2e-5d4a-4c3b-9a8e-222222222222/attachments/a77a0000-0000-4000-8000-000000000098.pdf',
      'workflows/0b6f1c2e-5d4a-4c3b-9a8e-222222222222/cards/EstateCardAuto000002/attachments/a77a0000-0000-4000-8000-000000000099.pdf',
    ]);
    expect(report.integrations).toEqual([
      { provider: 'google', type: 'calendar', connected: true },
      { provider: 'microsoft', type: 'calendar', connected: false },
    ]);
    expect(report.workspaces).toEqual({ prime: 1, nonPrime: ['workspaces/f0000000-0000-4000-8000-000000000002'] });
  });

  it('maps ids deterministically and lists every record in the id map', () => {
    const output = runTransform(raw, args(profile));
    const orgId = migId(`profiles/${FIXTURE_UIDS.subject}#org`);
    expect(output.report.orgId).toBe(orgId);
    const matters = lines(output.files.get('transformed/matters.jsonl'));
    for (const matter of matters) expect(matter.path).toBe(`orgs/${orgId}/matters/${migId(matter.legacyPath)}`);
    const idmap = lines(output.files.get(IDMAP_FILE)) as unknown as { legacyPath: string; v2Path: string }[];
    const total = Object.values(output.report.counts.out).reduce((sum, n) => sum + n, 0);
    expect(idmap).toHaveLength(total);
    expect(idmap).toContainEqual({ legacyPath: matters[0]?.legacyPath, v2Path: matters[0]?.path });
    // The report goes at the run's root, where the copy (MIG-05) reads it.
    expect(output.files.has(REPORT_FILE)).toBe(true);
  });

  it('links matters to the migrated cards they linked, and drops the rest', () => {
    const output = runTransform(raw, args(profile));
    const matters = new Map(lines(output.files.get('transformed/matters.jsonl')).map((m) => [m.legacyPath, m]));
    const card = (id: string) => `workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/${id}`;
    const ids = (path: string) => matters.get(path)?.data?.['relatedMatterIds'];
    expect(ids(card('WillsCardAuto0000001'))).toEqual([migId(card('WillsCardAuto0000002'))]);
    expect(output.report.warnings.MIG_W_LINK_DROPPED.paths).toEqual([
      card('WillsCardAuto0000001'),
      card('WillsCardAuto0000002'),
    ]);
  });

  it('loads into an existing org without creating one', () => {
    const output = runTransform(raw, args(profile, { targetOrg: 'org-existing' }));
    expect(output.report.counts.out.orgs).toBe(0);
    expect(output.report.targetOrg).toBe('existing');
    for (const matter of lines(output.files.get('transformed/matters.jsonl'))) {
      expect(matter.path.startsWith('orgs/org-existing/matters/')).toBe(true);
    }
  });

  it('notes when the profile differs from the one the run was exported under', () => {
    expect(runTransform(raw, args(profile, { profileHash: 'edited' })).report.profileChanged).toBe(true);
  });
});

describe('runTransform refuses', () => {
  it("another user's profile", () => {
    const other = { ...profile, subject: { ...profile.subject, legacyUid: 'SomeoneElse' } };
    expect(() => runTransform(raw, args(other))).toThrow(TransformRefusedError);
  });

  it('a delta without its base run, and an unreadable readTime', () => {
    const delta: RawRun = { ...raw, manifest: { ...raw.manifest, kind: 'delta' } };
    expect(() => runTransform(delta, args(profile))).toThrow(/--base-run/);
    const broken: RawRun = { ...raw, manifest: { ...raw.manifest, readTime: 'later' } };
    expect(() => runTransform(broken, args(profile))).toThrow(/readTime/);
  });
});

describe('a delta', () => {
  it("keeps the base run's numbers, links to unchanged matters, and continues the counters", async () => {
    const full = runTransform(raw, args(profile));
    const numbers = (output: ReturnType<typeof runTransform>) =>
      new Map(
        lines(output.files.get('transformed/matters.jsonl')).map((m) => [m.legacyPath, String(m.data?.['number'])]),
      );
    const baseNumbers = new Map(
      lines(full.files.get('transformed/matter-numbers.jsonl')).map((r) => [
        String(r.data?.['matterId']),
        { number: String(r.data?.['number']), year: Number(r.data?.['year']) },
      ]),
    );
    const base = { numbers: baseNumbers, counters: new Map([[2025, 7]]) };

    // Only WillsCardAuto0000004 (created 1 March) changed after 15 February. Linking it to
    // WillsCardAuto0000001, which is unchanged and so only in paths.jsonl, checks the delta's links.
    const run = await exportFixtureRun({ runId: 'delta-run', since: '2025-02-15T00:00:00.000Z' });
    const delta = await readRawRun(memorySink('delta-run', run.files));
    expect(delta.manifest.kind).toBe('delta');
    const wills = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/WillsCardAuto000000';
    for (const card of delta.files.cards ?? []) {
      if (card.path === `${wills}4`) card.data = { ...card.data, linkedCardIds: ['WillsCardAuto0000001'] };
    }
    const output = runTransform(delta, args(profile, { runId: 'delta-run', base }));
    expect(output.report.rejects).toEqual([]);
    const changed = numbers(output);
    expect([...changed.keys()]).toEqual([`${wills}4`]);
    expect(changed.get(`${wills}4`)).toBe(numbers(full).get(`${wills}4`));
    // Nothing new was numbered, so no reservation or counter is written again.
    expect(output.report.counts.out['matter-numbers']).toBe(0);
    expect(output.report.counts.out.counters).toBe(0);
    const matter = lines(output.files.get('transformed/matters.jsonl'))[0];
    expect(matter?.data?.['relatedMatterIds']).toEqual([migId(`${wills}1`)]);

    // A card the base never numbered, with no reference to adopt, continues after the base's counter.
    const without = new Map(baseNumbers);
    without.delete(migId(`${wills}4`));
    for (const card of delta.files.cards ?? []) {
      if (card.path === `${wills}4`) card.data = { ...card.data, matterReference: '' };
    }
    const continued = runTransform(delta, args(profile, { runId: 'delta-run', base: { ...base, numbers: without } }));
    expect(numbers(continued).get(`${wills}4`)).toBe('M-2025-0007');
    expect(lines(continued.files.get('transformed/counters.jsonl')).map((c) => c.data?.['next'])).toEqual([8]);
    expect(lines(continued.files.get('transformed/matter-numbers.jsonl')).map((r) => r.data?.['number'])).toEqual([
      'M-2025-0007',
    ]);
  });
});

describe('validateRecords', () => {
  const orgId = 'org1';
  const meta = {
    createdAt: new Date('2025-01-01T00:00:00Z'),
    createdBy: 'u1',
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    updatedBy: 'u1',
    schemaVersion: 1,
  };

  it('rejects a record that fails its schema, with the records under it and its number', () => {
    const matterPath = `orgs/${orgId}/matters/m1`;
    const records: TransformedRecord[] = [
      { entity: 'matters', path: matterPath, legacyPath: 'workflows/w/cards/c', data: { title: '' } },
      {
        entity: 'notes',
        path: `${matterPath}/notes/n1`,
        legacyPath: 'workflows/w/cards/c#description',
        data: { bodyMd: 'x', mentions: { uids: [], matterIds: [] }, pinned: false, privileged: false, ...meta },
      },
      {
        entity: 'matter-numbers',
        path: `orgs/${orgId}/matterNumbers/M-2025-0001`,
        legacyPath: 'workflows/w/cards/c',
        data: { number: 'M-2025-0001', matterId: 'm1', year: 2025, ...meta },
      },
      {
        entity: 'checklist-templates',
        path: `orgs/${orgId}/checklistTemplates/t1`,
        legacyPath: 'workflows/w/checklist-templates/t1',
        data: { name: 'Will intake', items: ['Take instructions'], ...meta },
      },
      {
        entity: 'checklist-templates',
        path: `orgs/${orgId}/checklistTemplates/t1`,
        legacyPath: 'workflows/w/checklist-templates/t1',
        data: { name: 'Will intake', items: ['Take instructions'], ...meta },
      },
      {
        entity: 'avatars',
        path: 'users/u1/avatar.png',
        legacyPath: 'profile-images/u1.png',
        copy: {
          source: 'a',
          content: { encoding: 'base64', data: 'eA==', sha256: 'f'.repeat(64) },
          target: 't',
          fileName: 'f',
          mime: 'image/png',
          sizeBytes: 1,
        },
      },
    ];
    const { kept, rejects } = validateRecords(records);
    expect(kept.map((r) => r.path)).toEqual([`orgs/${orgId}/checklistTemplates/t1`]);
    const byPath = Object.fromEntries(rejects.map((r) => [r.path, r.issues.map((i) => i.code)]));
    expect(byPath[`${matterPath}/notes/n1`]).toEqual(['parent_rejected']);
    expect(byPath[`orgs/${orgId}/matterNumbers/M-2025-0001`]).toEqual(['parent_rejected']);
    expect(byPath['users/u1/avatar.png']).toEqual(['custom']);
    expect(rejects.find((r) => r.entity === 'checklist-templates')?.issues[0]?.code).toBe('duplicate_path');
    // Issues name the field, never its value.
    const matter = rejects.find((r) => r.path === matterPath);
    expect(matter?.issues.some((issue) => issue.path === 'data.title')).toBe(true);
  });

  it("keeps the schema's output, defaults filled in", () => {
    const { kept } = validateRecords([
      {
        entity: 'checklist-templates',
        path: 'orgs/o/checklistTemplates/t',
        legacyPath: 'l',
        data: { name: 'N', items: ['a'], ...meta },
      },
    ]);
    expect(domain.ChecklistTemplateSchema.parse(kept[0]?.data)).toEqual(kept[0]?.data);
  });
});
