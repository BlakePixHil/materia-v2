import { DATA_CLOCK } from '@materia/data-access';
import {
  MIGRATION_REVIEW_CODE_LIST,
  migrationReviewPercent,
  type MigrationReviewCode,
  type MigrationReviewItem,
} from '@materia/domain';

import { ADMIN, cleanUpOverlays, LAWYER, meta, openMatter, ORG } from '../matter-detail/testing';
import { DEVICE_TIME_ZONE } from '../today/today-data';

/**
 * The migration review (MIG-08): Settings → Import from materia, the review queue with a fix path
 * for every code, marking records reviewed one by one, selected or all at once, progress, the
 * rollback banner and Today's card. A fictional imported practice only.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const M = `orgs/${ORG}/matters`;
const RUN = `orgs/${ORG}/migrations/run-cutover`;
const LOADED = new Date('2026-10-02T21:00:00Z');

const run = (extra: Seed = {}): Seed => ({
  ...meta,
  runId: 'run-cutover',
  mode: 'cutover',
  status: 'succeeded',
  startedAt: LOADED,
  finishedAt: new Date('2026-10-02T21:40:00Z'),
  counts: { orgs: 1, members: 1, contacts: 318, matters: 42, parties: 120, documents: 640, notes: 210 },
  warnings: [
    { code: 'MIG_C_USER_EDITED', path: `${M}/m-x`, message: 'changed in v2 after the load' },
    { code: 'MIG_C_USER_EDITED', path: `${M}/m-y`, message: 'changed in v2 after the load' },
  ],
  ...extra,
});

const item = (path: string, entity: MigrationReviewItem['entity'], title: string, codes: MigrationReviewCode[]) => {
  const id = path.split('/').at(-1) as string;
  const matterId = entity === 'matter' ? id : entity === 'document' ? path.split('/')[3] : undefined;
  return { path, entity, id, title, codes, ...(matterId ? { matterId } : {}) } as MigrationReviewItem;
};

/** One record for every code. */
const RECORDS = (): MigrationReviewItem[] => [
  item(`${M}/m-whitfield`, 'matter', 'Untitled matter (imported)', ['title_missing']),
  item(`${M}/m-client`, 'matter', 'Estate of Fictional Wren', [
    'client_placeholder',
    'swimlane_unknown',
    'fee_type_missing',
  ]),
  item(`${M}/m-title`, 'matter', 'Fictional Finch – will', ['client_from_title', 'fee_amount_missing']),
  item(`${M}/m-nowin`, 'matter', 'Fictional Lark v Fictional Owl', ['fee_conditional_terms', 'fee_disbursements']),
  {
    ...item(`${M}/m-closed`, 'matter', 'Estate of Fictional Crane', ['closed_without_closing_record']),
    readOnly: true,
  },
  item(`orgs/${ORG}/contacts/c-referrer`, 'contact', 'Unnamed referrer (imported)', ['referrer_unnamed']),
  item(`orgs/${ORG}`, 'org', 'Materia Technologies', ['org_name_unconfirmed']),
  item(`orgs/${ORG}/members/user-priya`, 'member', 'Priya Fictional', ['budgets_imported']),
  item(`${M}/m-title/documents/d-missing`, 'document', 'Will (signed).pdf', ['MIG_W_ATTACHMENT_OBJECT_MISSING']),
  item(`${M}/m-title/documents/d-uncopied`, 'document', 'Letter.pdf', ['MIG_W_ATTACHMENT_NOT_COPIED']),
  item(`${M}/m-title/documents/d-msg`, 'document', 'Email.msg', ['MIG_W_DOCUMENT_UNREADABLE']),
];

/** migration-review and migration-resolveReview as the server answers them, over `records`. */
function reviewServer(records: MigrationReviewItem[] = RECORDS(), reviewedAlready = 2) {
  const state = new Map(records.map((record) => [record.path, { ...record, codes: [...record.codes] }]));
  const reviewed: string[] = Array.from({ length: reviewedAlready }, () => 'client_from_title');
  const summary = (data: Seed) => {
    const codes = MIGRATION_REVIEW_CODE_LIST.map((code) => ({
      code,
      open: [...state.values()].filter((record) => record.codes.includes(code)).length,
      reviewed: reviewed.filter((each) => each === code).length,
    }));
    const open = codes.reduce((sum, count) => sum + count.open, 0);
    const done = codes.reduce((sum, count) => sum + count.reviewed, 0);
    const limit = (data['limit'] as number | undefined) ?? 200;
    const listed = [...state.values()].filter(
      (record) => record.codes.length && (!data['code'] || record.codes.includes(data['code'] as MigrationReviewCode)),
    );
    return {
      codes,
      open,
      reviewed: done,
      percent: migrationReviewPercent(open, done),
      items: limit ? listed.slice(0, limit) : [],
      more: listed.length > limit,
      reviewedAt: open ? null : '2026-10-04T01:00:00.000Z',
    };
  };
  return {
    'migration-review': (data: Seed) => summary(data),
    'migration-resolveReview': (data: Seed) => {
      const named =
        (data['items'] as { path: string; code: MigrationReviewCode }[] | undefined) ??
        [...state.values()]
          .filter((record) => record.codes.includes(data['code'] as MigrationReviewCode))
          .map((record) => ({ path: record.path, code: data['code'] as MigrationReviewCode }));
      let resolved = 0;
      for (const { path, code } of named) {
        const record = state.get(path);
        if (!record?.codes.includes(code)) continue;
        record.codes = record.codes.filter((each) => each !== code);
        reviewed.push(code);
        resolved += 1;
      }
      const after = summary({ limit: 0 });
      return { resolved, skipped: named.length - resolved, ...after };
    },
  };
}

function practice(runs: Seed[] = [run()]) {
  return (fs: Page['firestore']) => {
    fs.set(`orgs/${ORG}`, { name: 'Materia Technologies', timezone: 'Australia/Melbourne' });
    fs.set(`orgs/${ORG}/contacts/c-referrer`, {
      ...meta,
      kind: 'organisation',
      orgName: 'Unnamed referrer (imported)',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: true,
    });
    for (const each of runs) fs.set(`orgs/${ORG}/migrations/${each['runId'] as string}`, each);
  };
}

async function open(url: string, options: Parameters<typeof openMatter>[1] = {}) {
  const page = await openMatter(url, {
    session: ADMIN,
    configure: practice(),
    ...options,
    callables: { ...reviewServer(), ...options.callables },
  });
  for (let i = 0; i < 3; i++) await page.stable(5);
  return page;
}

/** A callable's calls without their generated request ids. */
const callsOf = (page: Page, name: string) =>
  page.calls(name).map((data) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'requestId')));

/** Chooses the queue's "Show" filter by its label (the native select's values are indexes). */
async function show(page: Page, label: string): Promise<void> {
  const select = page.body.querySelector<HTMLSelectElement>('mt-select select');
  const option = [...(select?.options ?? [])].find((each) => each.textContent?.trim() === label);
  if (!select || !option) throw new Error(`No "${label}" to show`);
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
  await page.stable(5);
}

const record = (page: Page, path: string) => page.body.querySelector<HTMLElement>(`[data-record="${path}"]`);
const line = (page: Page, path: string, code: string) =>
  record(page, path)?.querySelector<HTMLElement>(`[data-code="${code}"]`) ?? null;
const hrefs = (root: HTMLElement | null) =>
  [...(root?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].map((a) => a.getAttribute('href'));

describe('Settings → Import from materia', () => {
  it('is in the sidebar for owners and admins once the practice was imported', async () => {
    const page = await open('/settings/practice');
    expect(page.buttons('Import from materia').length).toBeGreaterThan(0);
  });

  it('is not in the sidebar for a practice never imported', async () => {
    const fresh = await open('/settings/practice', { configure: practice([]) });
    expect(fresh.buttons('Import from materia')).toHaveLength(0);
  });

  it('is not offered to lawyers, and its route turns them away', async () => {
    const lawyer = await open('/settings/team', { session: LAWYER });
    expect(lawyer.buttons('Import from materia')).toHaveLength(0);
    await lawyer.router.navigateByUrl('/settings/migration/review');
    await lawyer.stable();
    expect(lawyer.router.url).not.toContain('/settings/migration');
    expect(lawyer.calls('migration-review')).toHaveLength(0);
  });

  it('shows what came across, what to check by reason, and progress, as the onboarding step', async () => {
    const page = await open('/settings/migration');
    expect(page.text(page.body.querySelector('h1'))).toBe('Bring in your matters');
    expect(page.text(page.body.querySelector('[data-imported]'))).toBe('Imported from materia · 3 Oct 2026');
    expect(callsOf(page, 'migration-review')).toEqual([{ limit: 0 }]);

    // 15 codes open across the records, 2 reviewed: 11%.
    expect(page.text(page.body.querySelector('[data-progress]'))).toBe('11% reviewed · 15 to check');
    expect(hrefs(page.body.querySelector('[data-section="progress"]'))).toEqual([
      '/settings/migration/review',
      '/matters',
    ]);
    expect(page.text(page.body.querySelector('[data-section="progress"]'))).toContain('Review 15 items');

    const rows = [...page.body.querySelectorAll<HTMLTableRowElement>('[data-section="came-across"] tbody tr')];
    expect(rows.map((row) => [...row.cells].map((cell) => page.text(cell)))).toEqual([
      ['Matters', '42', '9 to check'],
      ['Contacts', '318', '1 to check'],
      ['People on matters', '120', 'Brought across'],
      ['Documents', '640', '3 to check'],
      ['Notes', '210', 'Brought across'],
      ['Team members', '1', '1 to check'],
    ]);

    const reasons = page.body.querySelectorAll<HTMLElement>('[data-section="to-check"] [data-code]');
    expect([...reasons].map((reason) => reason.dataset['code'])).toEqual(MIGRATION_REVIEW_CODE_LIST);
    const untitled = page.body.querySelector('[data-code="title_missing"]');
    expect(page.text(untitled?.querySelector('.label'))).toBe('No title · 1');
    expect(page.text(untitled?.querySelector('.caption'))).toContain('The card had no title');
    expect(hrefs(page.body.querySelector('[data-code="swimlane_unknown"]'))).toEqual([
      '/settings/migration/review?code=swimlane_unknown',
    ]);

    const edited = page.body.querySelector('[data-warning="MIG_C_USER_EDITED"]');
    expect(page.text(edited?.querySelector('.label'))).toBe(
      'Changed in Materia since an earlier load, so kept as you had them',
    );
    expect(page.text(edited?.querySelector('.t-3'))).toBe('2');
  });

  it('says when the import was rolled back', async () => {
    const page = await open('/settings/migration', {
      configure: practice([
        run(),
        run({ runId: 'run-later', status: 'rolled_back', startedAt: new Date('2026-10-03T00:00:00Z') }),
      ]),
    });
    expect(page.body.querySelector('[data-rolled-back]')).not.toBeNull();
    expect(page.body.querySelector('[data-section="progress"]')).toBeNull();
    expect(page.body.querySelector('[data-section="to-check"]')).toBeNull();
  });
});

describe('the review queue', () => {
  it('lists every record to check, each code with its fix', async () => {
    const page = await open('/settings/migration/review');
    expect(page.text(page.body.querySelector('h1'))).toBe('Review imported records');
    expect(page.body.querySelectorAll('.queue > li')).toHaveLength(RECORDS().length);

    // Opening the page that puts a code right.
    expect(hrefs(line(page, `${M}/m-client`, 'client_placeholder'))).toEqual(['/matters/m-client/parties']);
    expect(hrefs(line(page, `${M}/m-client`, 'swimlane_unknown'))).toEqual(['/matters/m-client/overview']);
    expect(hrefs(line(page, `${M}/m-client`, 'fee_type_missing'))).toEqual(['/matters/m-client/overview']);
    expect(hrefs(line(page, `${M}/m-title`, 'client_from_title'))).toEqual(['/matters/m-title/parties']);
    expect(hrefs(line(page, `${M}/m-title`, 'fee_amount_missing'))).toEqual(['/matters/m-title/overview']);
    expect(hrefs(line(page, `${M}/m-nowin`, 'fee_conditional_terms'))).toEqual(['/matters/m-nowin/overview']);
    expect(hrefs(line(page, `${M}/m-nowin`, 'fee_disbursements'))).toEqual(['/matters/m-nowin/time']);
    expect(hrefs(line(page, `${M}/m-closed`, 'closed_without_closing_record'))).toEqual(['/matters/m-closed/overview']);
    expect(hrefs(line(page, `orgs/${ORG}`, 'org_name_unconfirmed'))).toEqual(['/settings/practice']);
    expect(hrefs(line(page, `orgs/${ORG}/members/user-priya`, 'budgets_imported'))).toEqual(['/settings/team']);
    for (const [id, code] of [
      ['d-missing', 'MIG_W_ATTACHMENT_OBJECT_MISSING'],
      ['d-uncopied', 'MIG_W_ATTACHMENT_NOT_COPIED'],
      ['d-msg', 'MIG_W_DOCUMENT_UNREADABLE'],
    ] as const) {
      expect(hrefs(line(page, `${M}/m-title/documents/${id}`, code))).toEqual([`/matters/m-title/documents/${id}`]);
    }
    // Every code has its line, with "Looks right".
    for (const code of MIGRATION_REVIEW_CODE_LIST) {
      const found = page.body.querySelector<HTMLElement>(`.line[data-code="${code}"]`);
      expect(found, code).not.toBeNull();
      expect(page.buttons('Looks right', found as HTMLElement), code).toHaveLength(1);
    }
    // An archived matter can be marked, not changed.
    expect(page.text(record(page, `${M}/m-closed`))).toContain('Archived, so it can’t be changed');
  });

  it('titles an untitled matter in place, and marks its code reviewed', async () => {
    const page = await open('/settings/migration/review');
    const row = record(page, `${M}/m-whitfield`) as HTMLElement;
    await page.fill('Matter title', 'Estate of Fictional Heron', row);
    await page.click('Save title', row);
    await page.stable(5);
    expect(page.firestore.get(`${M}/m-whitfield`)).toMatchObject({ title: 'Estate of Fictional Heron' });
    expect(callsOf(page, 'migration-resolveReview')).toEqual([
      { items: [{ path: `${M}/m-whitfield`, code: 'title_missing' }] },
    ]);
    expect(record(page, `${M}/m-whitfield`)).toBeNull();
    expect(page.text(page.body.querySelector('[data-progress]'))).toBe('17% reviewed · 14 to check');
  });

  it('names an unnamed referrer in place', async () => {
    const page = await open('/settings/migration/review');
    const row = record(page, `orgs/${ORG}/contacts/c-referrer`) as HTMLElement;
    await page.fill('Referrer’s name', 'Fictional Wills Network', row);
    await page.click('Save name', row);
    await page.stable(5);
    expect(page.firestore.get(`orgs/${ORG}/contacts/c-referrer`)).toMatchObject({
      orgName: 'Fictional Wills Network',
    });
    expect(callsOf(page, 'migration-resolveReview')).toEqual([
      { items: [{ path: `orgs/${ORG}/contacts/c-referrer`, code: 'referrer_unnamed' }] },
    ]);
  });

  it('marks one code reviewed as it stands', async () => {
    const page = await open('/settings/migration/review');
    await page.click('Looks right', line(page, `orgs/${ORG}`, 'org_name_unconfirmed') as HTMLElement);
    await page.stable(5);
    expect(callsOf(page, 'migration-resolveReview')).toEqual([
      { items: [{ path: `orgs/${ORG}`, code: 'org_name_unconfirmed' }] },
    ]);
    expect(record(page, `orgs/${ORG}`)).toBeNull();
  });

  it('filters by reason, and marks every record with it reviewed after confirming', async () => {
    const page = await open('/settings/migration/review');
    await show(page, 'No fee arrangement (1)');
    expect(page.router.url).toBe('/settings/migration/review?code=fee_type_missing');
    expect(callsOf(page, 'migration-review').at(-1)).toEqual({ code: 'fee_type_missing' });
    expect(page.body.querySelectorAll('.queue > li')).toHaveLength(1);
    // Only the reason asked for shows on the row.
    expect(line(page, `${M}/m-client`, 'swimlane_unknown')).toBeNull();
    expect(page.text(page.body.querySelector('[data-code-help]'))).toContain('Set the arrangement.');

    await page.click('Mark all 1 reviewed');
    expect(page.text(page.dialog())).toContain('Mark all 1 “No fee arrangement” reviewed?');
    await page.click('Mark 1 reviewed', page.dialog() as HTMLElement);
    await page.stable(5);
    expect(callsOf(page, 'migration-resolveReview')).toEqual([{ code: 'fee_type_missing' }]);
    expect(page.text(page.body)).toContain('Nothing to check here');
  });

  it('opens on a reason from the link, and marks selected records together', async () => {
    const page = await open('/settings/migration/review?code=MIG_W_ATTACHMENT_OBJECT_MISSING');
    expect(callsOf(page, 'migration-review')).toEqual([{ code: 'MIG_W_ATTACHMENT_OBJECT_MISSING' }]);
    await show(page, 'Everything (15)');
    for (const path of [`${M}/m-title`, `${M}/m-nowin`]) {
      record(page, path)?.querySelector<HTMLButtonElement>('button.mt-check')?.click();
      await page.stable();
    }
    await page.click('Mark 4 items reviewed');
    await page.stable(5);
    expect(callsOf(page, 'migration-resolveReview')).toEqual([
      {
        items: [
          { path: `${M}/m-title`, code: 'client_from_title' },
          { path: `${M}/m-title`, code: 'fee_amount_missing' },
          { path: `${M}/m-nowin`, code: 'fee_conditional_terms' },
          { path: `${M}/m-nowin`, code: 'fee_disbursements' },
        ],
      },
    ]);
    expect(record(page, `${M}/m-title`)).toBeNull();
    expect(page.buttons('Mark 4 items reviewed')).toHaveLength(0);
  });

  it('says when everything is reviewed', async () => {
    const page = await open('/settings/migration/review', {
      callables: reviewServer([item(`orgs/${ORG}`, 'org', 'Materia Technologies', ['org_name_unconfirmed'])]),
    });
    await page.click('Looks right');
    await page.stable(5);
    expect(page.text(page.body.querySelector('[data-progress]'))).toBe('All reviewed');
    expect(page.text(page.body)).toContain('Everything’s reviewed');
  });

  it('empties and says so when the import is rolled back while it is open', async () => {
    const page = await open('/settings/migration/review');
    expect(page.body.querySelectorAll('.queue > li').length).toBeGreaterThan(0);
    page.firestore.set(RUN, { ...run(), status: 'rolling_back' });
    await page.stable(5);
    expect(page.body.querySelector('[data-rolled-back]')).not.toBeNull();
    expect(page.body.querySelectorAll('.queue > li')).toHaveLength(0);
    expect(page.body.querySelector('[data-section="progress"]')).toBeNull();
  });
});

const TODAY_PROVIDERS = [
  { provide: DATA_CLOCK, useValue: () => Date.parse('2026-10-04T22:00:00Z') },
  { provide: DEVICE_TIME_ZONE, useValue: 'Australia/Melbourne' },
];

describe('Today’s import card', () => {
  it('shows owners and admins how far the review is, and the way in', async () => {
    const page = await open('/today', { providers: TODAY_PROVIDERS });
    const card = page.body.querySelector<HTMLElement>('[data-section="import"]');
    expect(page.text(card)).toContain('Check your import');
    expect(page.text(card)).toContain('11% reviewed · 15 to check');
    expect(hrefs(card)).toEqual(['/settings/migration/review', '/settings/migration']);
  });

  it('is not shown once the review is finished', async () => {
    const page = await open('/today', {
      configure: practice([run({ reviewedAt: new Date('2026-10-04T01:00:00Z') })]),
      providers: TODAY_PROVIDERS,
    });
    expect(page.body.querySelector('[data-section="import"]')).toBeNull();
    expect(page.calls('migration-review')).toHaveLength(0);
  });

  it('is not shown to lawyers', async () => {
    const page = await open('/today', { session: LAWYER, providers: TODAY_PROVIDERS });
    expect(page.body.querySelector('[data-section="import"]')).toBeNull();
    expect(page.calls('migration-review')).toHaveLength(0);
  });
});
