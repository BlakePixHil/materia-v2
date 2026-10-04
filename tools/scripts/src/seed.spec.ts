import * as D from '@materia/domain';
import { CONFLICT_CONTACTS, CONFLICT_MATTERS } from '@materia/test-utils';

import { busyPorts, devPorts } from './dev.ts';
import {
  buildDataset,
  type FixtureName,
  LOAD_MATTER_COUNT,
  SEED_ACCOUNTS,
  SEED_ORG_ID,
  stripUndefined,
} from './seed/dataset.ts';
import { resolveSeedTarget, SeedGuardError } from './seed/guard.ts';
import { FIXTURE_NAMES, fixtureInfo, renderFixture } from './seed/pdfs.ts';
import { entityRegistry, fromFirestore, main, parseSeedArgs } from './seed.ts';

const CONFLICT_MATTER_COUNT = Object.keys(CONFLICT_MATTERS).length;

const EMULATOR_ENV = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
};

describe('seed safety guard', () => {
  it('requires the Firestore and Auth emulator hosts', () => {
    expect(() => resolveSeedTarget({})).toThrow(SeedGuardError);
    expect(() => resolveSeedTarget({})).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
    expect(() => resolveSeedTarget({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      /FIREBASE_AUTH_EMULATOR_HOST/,
    );
    expect(() => resolveSeedTarget({ FIRESTORE_EMULATOR_HOST: ' ', FIREBASE_AUTH_EMULATOR_HOST: 'x' })).toThrow(
      /FIRESTORE/,
    );
  });

  it('refuses any project that is not a demo- project, even with emulator hosts', () => {
    expect(() => resolveSeedTarget({ ...EMULATOR_ENV, GCLOUD_PROJECT: 'materia-v2-prod' })).toThrow(
      /only demo- projects/,
    );
    expect(() => resolveSeedTarget(EMULATOR_ENV, 'materia-v2-dev')).toThrow(SeedGuardError);
  });

  it('returns the emulator target for demo-materia', () => {
    expect(resolveSeedTarget(EMULATOR_ENV)).toEqual({
      projectId: 'demo-materia',
      firestoreHost: '127.0.0.1:8080',
      authHost: '127.0.0.1:9099',
      storageHost: null,
    });
    expect(
      resolveSeedTarget({
        ...EMULATOR_ENV,
        FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
        GCLOUD_PROJECT: 'demo-other',
      }),
    ).toMatchObject({
      projectId: 'demo-other',
      storageHost: '127.0.0.1:9199',
    });
  });

  it('stops main() before touching anything when the guard fails', async () => {
    const saved = { ...process.env };
    delete process.env['FIRESTORE_EMULATOR_HOST'];
    try {
      await expect(main([])).rejects.toThrow(SeedGuardError);
    } finally {
      process.env = saved;
    }
  });
});

describe('seed arguments', () => {
  it('parses scenarios and flags', () => {
    expect(parseSeedArgs([])).toEqual({ scenario: 'default', ifEmpty: false, verify: false });
    expect(parseSeedArgs(['--minimal'])).toMatchObject({ scenario: 'minimal' });
    expect(parseSeedArgs(['--scenario=empty', '--if-empty', '--verify'])).toEqual({
      scenario: 'empty',
      ifEmpty: true,
      verify: true,
    });
    expect(parseSeedArgs(['--scenario=load'])).toMatchObject({ scenario: 'load' });
    expect(() => parseSeedArgs(['--scenario=prod'])).toThrow(/Unknown scenario/);
    expect(() => parseSeedArgs(['--nope'])).toThrow();
  });
});

describe('seed dataset', () => {
  const fixtures = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixtureInfo(name)])) as Record<
    FixtureName,
    ReturnType<typeof fixtureInfo>
  >;
  const anchor = D.dateOnly('2026-10-03');
  const dataset = buildDataset({ anchor, fixtures });
  const registry = entityRegistry();
  const docsUnder = (collection: string) =>
    dataset.docs.filter((d) => new RegExp(`^orgs/${SEED_ORG_ID}/${collection}/[^/]+$`).test(d.path));

  it('creates the org, one account per role, and members with rates', () => {
    expect(dataset.accounts.map((a) => a.role)).toEqual(['owner', 'lawyer', 'paralegal', 'readonly']);
    const org = dataset.docs.find((d) => d.path === `orgs/${SEED_ORG_ID}`)?.data;
    expect(org).toMatchObject({
      name: 'Harbour & Vine Legal',
      primaryJurisdiction: 'VIC',
      timezone: 'Australia/Melbourne',
      holidayLocality: 'VIC_GREATER_GEELONG',
    });
    const members = docsUnder('members');
    expect(members).toHaveLength(4);
    expect(members.find((m) => m.path.endsWith('user-jordan'))?.data).toMatchObject({
      role: 'lawyer',
      defaultRateCents: 45000,
    });
  });

  it('has about 25 contacts and 12 matters covering every type and status, plus the conflict scenarios', () => {
    expect(docsUnder('contacts').length).toBeGreaterThanOrEqual(24);
    const matters = docsUnder('matters').map((d) => d.data as { type: string; status: string });
    expect(matters).toHaveLength(12 + CONFLICT_MATTER_COUNT);
    expect(new Set(matters.map((m) => m.type))).toEqual(new Set(D.MatterTypeSchema.options));
    expect(new Set(matters.map((m) => m.status))).toEqual(new Set(D.MatterStatusSchema.options));
    for (const sub of ['parties', 'events', 'tasks', 'deadlines', 'notes', 'timeEntries', 'documents']) {
      expect(dataset.docs.some((d) => d.path.includes(`/${sub}/`))).toBe(true);
    }
  });

  it('is schema-valid for every document, and every path has a schema', () => {
    for (const doc of dataset.docs) {
      const entity = registry.find((e) => e.pattern.test(doc.path));
      expect(entity, doc.path).toBeDefined();
      const result = entity?.schema.safeParse(stripUndefined(doc.data));
      expect(result?.success, `${doc.path}: ${JSON.stringify(result?.error?.issues)}`).toBe(true);
    }
  });

  it('gives every matter one client party row per client, at partyDocId ids (CORE-06)', () => {
    const matters = docsUnder('matters');
    for (const matter of matters) {
      const clients = (matter.data as D.Matter).clientContactIds;
      const rows = dataset.docs
        .filter((d) => d.path.startsWith(`${matter.path}/parties/`))
        .map((d) => ({ id: d.path.split('/').at(-1), ...(d.data as D.Party) }));
      expect(D.clientContactIdsFrom(rows), matter.path).toEqual(clients);
      for (const row of rows) expect(row.id, matter.path).toBe(D.partyDocId(row.role, row.contactId));
    }
  });

  it('gives demo matters a stage and key facts that meet the stage’s requirements (CORE-06)', () => {
    const matters = docsUnder('matters').map((d) => d.data as D.Matter);
    const staged = matters.filter((m) => m.stageId);
    expect(staged.length).toBeGreaterThanOrEqual(6);
    for (const matter of staged) {
      const stages = D.matterStages(matter.type);
      expect(
        stages.map((s) => s.id),
        matter.title,
      ).toContain(matter.stageId);
      expect(D.unmetStageRequirements(matter, stages, undefined, matter.stageId as string), matter.title).toEqual([]);
    }
    const doyle = matters.find((m) => m.title === 'Estate of Margaret Doyle');
    expect(doyle).toMatchObject({ stageId: 'grant_application', facts: { willDate: expect.any(String) } });
    expect(matters.some((m) => m.estate?.grantDate && m.estate.grantNo && m.estate.grossValueCents)).toBe(true);
    expect(matters.some((m) => (m.type === 'fp' || m.type === 'contest') && m.facts?.courtFileNo)).toBe(true);
  });

  it('dates deadlines relative to the anchor and denormalises the next deadline', () => {
    const doyle = dataset.docs.find((d) => d.path === `orgs/${SEED_ORG_ID}/matters/m-doyle-estate`)?.data as D.Matter;
    expect(doyle.nextDeadline).toMatchObject({ dueDate: '2026-10-03', title: 'Send costs disclosure update' });
    expect(doyle.openTaskCount).toBe(2);
    expect(doyle.wipCents).toBeGreaterThan(0);
    const overdue = dataset.docs.find((d) => d.path.endsWith('m-nguyen-fp-dl-1'))?.data as D.Deadline;
    expect(overdue.dueDate).toBe('2026-10-01');
  });

  it('links each document record to a fixture PDF with its real size and hash', () => {
    const records = dataset.docs.filter((d) => d.path.includes('/documents/')).map((d) => d.data as D.MatterDocument);
    expect(records).toHaveLength(dataset.files.length);
    for (const file of dataset.files) {
      const record = records.find((r) => r.storagePath === file.storagePath);
      expect(record?.sha256).toBe(fixtures[file.fixture].sha256);
      expect(record?.sizeBytes).toBe(fixtures[file.fixture].sizeBytes);
    }
  });

  it('seeds the calendars and the Victorian rule set in every scenario', () => {
    expect(dataset.docs.filter((d) => d.path.startsWith('calendars/'))).toHaveLength(16);
    expect(dataset.docs.find((d) => d.path === 'ruleSets/vic/versions/1')?.data).toMatchObject({
      ruleSetId: 'vic',
      version: 1,
      published: true,
    });
    const empty = buildDataset({ anchor, fixtures, scenario: 'empty' });
    expect(empty.docs.some((d) => d.path === 'calendars/VIC_GREATER_GEELONG-2026')).toBe(true);
  });

  it('builds minimal and empty scenarios', () => {
    const minimal = buildDataset({ anchor, fixtures, scenario: 'minimal' });
    expect(minimal.docs.filter((d) => /\/matters\/[^/]+$/.test(d.path))).toHaveLength(2);
    const empty = buildDataset({ anchor, fixtures, scenario: 'empty' });
    expect(empty.docs.some((d) => d.path.includes('/matters/'))).toBe(false);
    expect(empty.accounts).toEqual(SEED_ACCOUNTS);
  });

  it('seeds the conflict scenarios with conflicts.enforced on, but not in the minimal scenario (CORE-02)', () => {
    const org = dataset.docs.find((d) => d.path === `orgs/${SEED_ORG_ID}`)?.data;
    expect(org?.['flags']).toEqual({ 'conflicts.enforced': true });
    for (const id of Object.values(CONFLICT_CONTACTS)) {
      expect(docsUnder('contacts').some((d) => d.path.endsWith(`/${id}`))).toBe(true);
    }
    const minimal = buildDataset({ anchor, fixtures, scenario: 'minimal' });
    expect(minimal.docs.some((d) => d.path.includes('/m-cf-'))).toBe(false);
  });

  it('is deterministic for the same anchor', () => {
    expect(buildDataset({ anchor, fixtures })).toEqual(dataset);
  });

  it('numbers matters as matters-createMatter would, with reservations, search and a counter past them (CORE-03)', () => {
    const matters = docsUnder('matters').map((d) => d.data as D.Matter & { deletedAt: unknown });
    const year = D.matterNumberYear(new Date(`${anchor}T00:00:00Z`), 'Australia/Melbourne');
    expect(matters.map((m) => m.number)).toEqual(
      Array.from({ length: 12 + CONFLICT_MATTER_COUNT }, (_, i) =>
        D.formatMatterNumber('HV-{YYYY}-{seq:4}', year, i + 1),
      ),
    );
    for (const matter of matters) {
      expect(matter.deletedAt).toBeNull();
      expect(matter.lastActivityAt).toBeInstanceOf(Date);
      const reservation = docsUnder('matterNumbers').find((d) => d.data['number'] === matter.number);
      expect(reservation?.path).toBe(`orgs/${SEED_ORG_ID}/matterNumbers/${D.matterNumberKey(matter.number)}`);
    }
    expect(new Set(matters.map((m) => m.lastActivityAt?.getTime())).size).toBe(12 + CONFLICT_MATTER_COUNT);
    const doyle = matters.find((m) => m.title === 'Estate of Margaret Doyle');
    // The client's and the deceased's names are searchable, as matters-denormalise writes them.
    expect(doyle?.search).toEqual(expect.arrayContaining(['catherine', 'doyle', 'margaret']));
    expect(docsUnder('counters').map((d) => [d.path.split('/').at(-1), d.data['next']])).toEqual([
      [`matter-${year}`, 13 + CONFLICT_MATTER_COUNT],
    ]);
  });

  it('the load scenario adds 500 varied matters on top of the practice, numbered after it', () => {
    const load = buildDataset({ anchor, fixtures, scenario: 'load' });
    const matters = load.docs.filter((d) => /\/matters\/[^/]+$/.test(d.path)).map((d) => d.data as D.Matter);
    expect(matters).toHaveLength(12 + CONFLICT_MATTER_COUNT + LOAD_MATTER_COUNT);
    expect(new Set(matters.map((m) => m.number)).size).toBe(matters.length);
    expect(new Set(matters.map((m) => m.status))).toEqual(new Set(D.MatterStatusSchema.options));
    expect(new Set(matters.map((m) => m.responsibleUid)).size).toBe(3);
    const counter = load.docs.find((d) => /\/counters\//.test(d.path));
    expect(counter?.data['next']).toBe(13 + CONFLICT_MATTER_COUNT + LOAD_MATTER_COUNT);
    for (const doc of load.docs) {
      const entity = registry.find((e) => e.pattern.test(doc.path));
      expect(entity?.schema.safeParse(stripUndefined(doc.data)).success, doc.path).toBe(true);
    }
  });
});

describe('seed helpers', () => {
  it('strips undefined values deeply, leaving dates and arrays alone', () => {
    const at = new Date(0);
    expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: [1, { f: undefined }] }, at })).toEqual({
      a: 1,
      c: { e: [1, {}] },
      at,
    });
  });

  it('turns Timestamps back into Dates', () => {
    const at = new Date(0);
    expect(fromFirestore({ t: { toDate: () => at }, list: [{ toDate: () => at }], n: 1, s: 'x', nil: null })).toEqual({
      t: at,
      list: [at],
      n: 1,
      s: 'x',
      nil: null,
    });
  });

  it('renders the fixture PDFs deterministically, matching the committed files', async () => {
    for (const name of FIXTURE_NAMES) {
      const bytes = await renderFixture(name);
      expect(bytes.length).toBe(fixtureInfo(name).sizeBytes);
      expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    }
  });
});

describe('dev ports', () => {
  it('lists the emulator ports from firebase.json and the web port', () => {
    const ports = devPorts();
    expect(ports).toEqual(
      expect.arrayContaining([
        { name: 'auth', port: 9099 },
        { name: 'firestore', port: 8080 },
        { name: 'pubsub', port: 8085 },
        { name: 'ui', port: 4000 },
        { name: 'web', port: 4200 },
      ]),
    );
  });

  it('reports busy ports by name', async () => {
    const busy = await busyPorts(
      [
        { name: 'firestore', port: 8080 },
        { name: 'web', port: 4200 },
      ],
      async (port) => port !== 8080,
    );
    expect(busy).toEqual([{ name: 'firestore', port: 8080 }]);
  });
});
