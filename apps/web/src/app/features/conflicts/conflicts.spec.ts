import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import {
  contactSearchTokens,
  matterSearchTokens,
  type ConflictHit,
  type DateOnly,
  type RunConflictCheckResult,
} from '@materia/domain';
import { MT_KEYBOARD_PLATFORM, MT_TODAY } from '@materia/ui';

import {
  conflictBadgeText,
  formatDob,
  groupHits,
  hitMatterBadge,
  matchReasons,
  matterSubjectRefs,
  parseDob,
  roleName,
  scorePercent,
} from './conflict-view';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';
import { changeStatusErrorCopy } from '../matters/matters-view';

/** The conflict check (CORE-02) against the in-memory Firestore and fake callables. Fictional data only. */

const ORG = 'org-harbour-vine';
const MATTERS = `orgs/${ORG}/matters`;
const TODAY = '2026-10-04' as DateOnly;
const ME = 'user-jordan';
const PRIYA = 'user-priya';
const LAWYER = testSession();
const PARALEGAL = testSession({ claims: { orgId: ORG, role: 'paralegal', orgName: 'Harbour & Vine Legal' } });
const READONLY = testSession({ claims: { orgId: ORG, role: 'readonly', orgName: 'Harbour & Vine Legal' } });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

type Seed = Record<string, unknown>;

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};

function matterDoc(data: Seed & { number: string; title: string }): Seed {
  return {
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    responsibleUid: ME,
    teamUids: [],
    clientContactIds: ['c-ellis'],
    privileged: false,
    priority: 'none',
    labels: [],
    openTaskCount: 0,
    wipCents: 0,
    fee: { arrangement: 'hourly', history: [] },
    costsDisclosure: { status: 'required' },
    conflictCheck: { status: 'pending' },
    search: matterSearchTokens({ number: data.number, title: data.title, clientNames: ['Margot Ellis'] }),
    lastActivityAt: new Date('2026-10-03T00:00:00Z'),
    deletedAt: null,
    ...meta,
    ...data,
  };
}

function seed(fs: InMemoryFirestore, lead: Seed = {}): void {
  const member = (uid: string, displayName: string, role: string) =>
    fs.set(`orgs/${ORG}/members/${uid}`, { displayName, email: `${uid}@example.test`, role, status: 'active' });
  member(ME, 'Jordan Price', 'lawyer');
  member(PRIYA, 'Priya Shah', 'owner');
  const contact = (id: string, data: Seed) =>
    fs.set(`orgs/${ORG}/contacts/${id}`, {
      kind: 'person',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
      search: contactSearchTokens({ givenNames: String(data['givenNames']), familyName: String(data['familyName']) }),
      ...meta,
      ...data,
    });
  contact('c-ellis', {
    givenNames: 'Margot Anne',
    familyName: 'Ellis',
    preferredName: 'Maggie',
    dateOfBirth: '1961-03-14',
    emails: [{ address: 'margot.ellis@example.test', type: 'personal' }],
  });
  contact('c-thorne', { givenNames: 'Walter', familyName: 'Thorne', dateOfDeath: '2026-09-02' });
  fs.set(
    `${MATTERS}/m-lead`,
    matterDoc({
      number: 'M-2026-0200',
      title: 'Estate of Walter Thorne',
      status: 'lead',
      deceased: { contactId: 'c-thorne', dateOfDeath: '2026-09-02', domicile: 'VIC', lastAddress: '1 Fictional St' },
      ...lead,
    }),
  );
}

/** Hits as `conflicts-run` returns them: Margot matches two contacts, Walter none. */
const HITS: ConflictHit[] = [
  {
    subject: 0,
    contactId: 'c-ellis-old',
    displayName: 'Margaret Ellis',
    score: 0.764,
    reasons: ['name'],
    matters: [],
  },
  {
    subject: 0,
    contactId: 'c-ellis-2',
    displayName: 'Margot A. Ellis',
    score: 0.912,
    reasons: ['name', 'dateOfBirth'],
    viaMergedContactId: 'c-merged',
    matters: [
      {
        matterId: 'm-dispute',
        number: 'M-2025-0090',
        title: 'Ellis v Ferrand',
        status: 'closed',
        type: 'contest',
        role: 'defendant',
        adverse: 'Client against a defendant',
      },
      {
        matterId: 'm-old',
        number: 'M-2019-0004',
        title: 'Will for Margot Ellis',
        status: 'archived',
        type: 'will',
        role: 'client',
      },
      {
        matterId: 'm-gone',
        number: 'M-2024-0031',
        title: 'Deleted fictional matter',
        status: 'open',
        type: 'probate',
        role: 'beneficiary',
        deleted: true,
      },
    ],
  },
];

interface Options {
  lead?: Seed;
  hits?: ConflictHit[];
  /** What `conflicts-determine` and `matters-changeStatus` do (default: succeed, like the server). */
  determine?: (data: Seed, fs: InMemoryFirestore) => unknown;
  changeStatus?: (data: Seed) => unknown;
}

async function open(url: string, session: AuthSession = LAWYER, options: Options = {}) {
  const port = new FakeAuthPort(session);
  const firestore = new InMemoryFirestore();
  seed(firestore, options.lead);
  port.call = async <T>(name: string, data: unknown): Promise<T> => {
    port.calls.push({ name, data });
    const input = data as Seed;
    if (name === 'conflicts-run') {
      return { checkId: 'chk-1', hits: options.hits ?? HITS } satisfies RunConflictCheckResult as T;
    }
    if (name === 'conflicts-determine') {
      if (options.determine) return options.determine(input, firestore) as T;
      // The server records it on the matter; the listener brings it back.
      const path = `${MATTERS}/${String(input['matterId'])}`;
      firestore.set(path, {
        ...firestore.get(path),
        conflictCheck: {
          status: input['status'],
          checkedAt: new Date('2026-10-04T01:00:00Z'),
          checkedBy: session.uid,
          resultId: input['checkId'],
          ...(input['reason'] ? { reason: input['reason'] } : {}),
        },
      });
      return { matterId: input['matterId'], status: input['status'] } as T;
    }
    if (name === 'matters-changeStatus') {
      if (options.changeStatus) return options.changeStatus(input) as T;
      return { matterId: input['matterId'], status: input['to'] } as T;
    }
    throw new Error(`Unexpected callable ${name}`);
  };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: MT_TODAY, useValue: () => TODAY },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const body = document.body;
  const stable = async (ms = 0) => {
    await settle(ms);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  };
  await stable();
  await stable();
  const panel = () => body.querySelector<HTMLElement>('mt-conflict-check-panel');
  const subjects = () => [...body.querySelectorAll<HTMLFieldSetElement>('fieldset.subject')];
  const control = (label: string, root: ParentNode = body) => {
    const host = [...root.querySelectorAll('mt-text-field, mt-select, mt-textarea')].find((f) =>
      f.querySelector('.mt-label')?.textContent?.trim().startsWith(label),
    );
    const found = host?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    );
    if (!found) throw new Error(`No field "${label}"`);
    return found;
  };
  const type = async (label: string, value: string, root: ParentNode = body) => {
    const input = control(label, root) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await stable();
  };
  const buttons = (text: string, root: ParentNode = body) =>
    [...root.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim().startsWith(text));
  const click = async (text: string, root: ParentNode = body) => {
    const found = buttons(text, root)[0];
    if (!found) throw new Error(`No button "${text}"`);
    found.click();
    await stable();
  };
  const run = async () => {
    body.querySelector('#mt-conflict-run-form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  const decide = async (label: string) => {
    const option = [...body.querySelectorAll<HTMLElement>('label.mt-choice')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    const radio = option?.querySelector<HTMLElement>('button');
    if (!radio) throw new Error(`No option "${label}"`);
    radio.click();
    await stable();
  };
  const record = async () => {
    body.querySelector('form.decide')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  const results = () => [...body.querySelectorAll<HTMLElement>('section.subject-result')];
  const text = (node: ParentNode | null | undefined = body) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const determination = () => body.querySelector<HTMLElement>('section.determination');
  return {
    port,
    firestore,
    router,
    body,
    stable,
    panel,
    subjects,
    control,
    type,
    buttons,
    click,
    run,
    decide,
    record,
    results,
    text,
    determination,
  };
}

const callsTo = (port: FakeAuthPort, name: string) => port.calls.filter((c) => c.name === name);

afterEach(() => {
  document.querySelectorAll('.mt-overlay, .mt-toast-region, [data-overlay]').forEach((node) => node.remove());
});

describe('conflict check panel', () => {
  it('prefills the matter’s client and deceased, runs the check and groups the hits under each subject', async () => {
    const page = await open('/matters/m-lead/conflicts');
    expect(page.panel()).not.toBeNull();
    // Subjects: the client (full legal name, not the preferred one) then the deceased.
    expect(page.subjects()).toHaveLength(2);
    const [client, deceased] = page.subjects();
    expect((page.control('Name', client) as HTMLInputElement).value).toBe('Margot Anne Ellis');
    expect((page.control('Role', client) as HTMLSelectElement).selectedOptions[0]?.textContent?.trim()).toBe('Client');
    expect((page.control('Date of birth', client) as HTMLInputElement).value).toBe('14/03/1961');
    expect((page.control('Email', client) as HTMLInputElement).value).toBe('margot.ellis@example.test');
    expect((page.control('Name', deceased) as HTMLInputElement).value).toBe('Walter Thorne');
    expect((page.control('Role', deceased) as HTMLSelectElement).selectedOptions[0]?.textContent?.trim()).toBe(
      'Deceased',
    );

    await page.run();
    const [call] = callsTo(page.port, 'conflicts-run');
    expect(call?.data).toMatchObject({
      requestId: expect.any(String),
      excludeMatterId: 'm-lead',
      subjects: [
        {
          kind: 'person',
          name: 'Margot Anne Ellis',
          role: 'client',
          dob: '1961-03-14',
          email: 'margot.ellis@example.test',
          contactId: 'c-ellis',
        },
        { kind: 'person', name: 'Walter Thorne', role: 'deceased', contactId: 'c-thorne' },
      ],
    });

    const [margot, walter] = page.results();
    expect(page.results()).toHaveLength(2);
    expect(margot?.getAttribute('aria-label')).toBe('Matches for Margot Anne Ellis');
    // Best match first, with its score as a percentage and why it matched.
    const hits = [...(margot?.querySelectorAll<HTMLElement>('article.hit') ?? [])];
    expect(hits.map((hit) => hit.querySelector('.hit-h .label')?.textContent?.trim())).toEqual([
      'Margot A. Ellis',
      'Margaret Ellis',
    ]);
    expect(page.text(hits[0]?.querySelector('.hit-h'))).toContain('91% match');
    expect(page.text(hits[0]?.querySelector('.hit-h'))).toContain('Name, date of birth');
    expect(page.text(hits[1]?.querySelector('.hit-h'))).toContain('76% match');
    expect(page.text(hits[1]?.querySelector('.hit-h'))).toContain('Name');
    expect(page.text(hits[0])).toContain('since been merged');
    expect(page.text(hits[1])).toContain('Not a party on any matter');
    // Every matter, closed, archived and deleted included, with its status and the role.
    const rows = [...(hits[0]?.querySelectorAll('tbody tr') ?? [])].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => page.text(cell)).join(' '),
    );
    expect(rows).toEqual([
      'M-2025-0090 Ellis v Ferrand Closed Defendant Adverse: Client against a defendant',
      'M-2019-0004 Will for Margot Ellis Archived Client',
      'M-2024-0031 Deleted fictional matter Deleted Beneficiary',
    ]);
    // No matches for Walter: said, not hidden.
    expect(page.text(walter)).toContain('No matches');
    expect(walter?.querySelectorAll('article.hit')).toHaveLength(0);
    expect(page.text(page.body.querySelector('section.results .card-h'))).toContain('2 matches');
    // Never auto-cleared: still not determined.
    expect(page.text(page.determination())).toContain('Not determined');
    expect(callsTo(page.port, 'conflicts-determine')).toHaveLength(0);
  });

  it('highlights adverse roles with their label in danger styling', async () => {
    const page = await open('/matters/m-lead/conflicts');
    await page.run();
    const adverseRows = [...page.body.querySelectorAll<HTMLElement>('tbody tr[data-adverse]')];
    expect(adverseRows).toHaveLength(1);
    expect(adverseRows[0]?.textContent).toContain('Ellis v Ferrand');
    const badge = adverseRows[0]?.querySelector('mt-badge[data-tone="danger"]');
    expect(badge?.textContent?.trim()).toBe('Adverse: Client against a defendant');
    expect(page.body.querySelectorAll('article.hit[data-adverse]')).toHaveLength(1);
    expect(page.body.querySelector('section.results mt-note[data-tone="danger"]')?.textContent).toContain(
      'other side of a matter',
    );
    // Recording Clear over an adverse match warns first.
    expect(page.text(page.determination())).toContain('despite adverse matches');
  });

  it('shows no adverse highlighting when nothing is adverse (the flag is off on the server)', async () => {
    const plain = JSON.parse(
      JSON.stringify(HITS, (key, value) => (key === 'adverse' ? undefined : value)),
    ) as ConflictHit[];
    const page = await open('/matters/m-lead/conflicts', LAWYER, { hits: plain });
    await page.run();
    expect(page.body.querySelectorAll('[data-adverse]')).toHaveLength(0);
    expect(page.text()).not.toContain('Adverse:');
  });

  it('needs a reason to waive a potential conflict, then records it and shows who, when and why', async () => {
    const page = await open('/matters/m-lead/conflicts');
    await page.run();
    await page.decide('Potential conflict');
    await page.record();
    expect(callsTo(page.port, 'conflicts-determine')).toHaveLength(0);
    expect(page.text(page.determination())).toContain('Say why the potential conflict is waived.');

    await page.type(
      'Reason',
      'Matter closed in 2025; informed consent from both clients on file.',
      page.determination() ?? page.body,
    );
    await page.record();
    const [call] = callsTo(page.port, 'conflicts-determine');
    expect(call?.data).toEqual({
      requestId: expect.any(String),
      checkId: 'chk-1',
      matterId: 'm-lead',
      status: 'potential',
      reason: 'Matter closed in 2025; informed consent from both clients on file.',
    });
    const shown = page.text(page.determination());
    expect(shown).toContain('Potential conflict, waived');
    expect(shown).toContain('Jordan Price');
    expect(shown).toMatch(/4 Oct 2026/);
    expect(shown).toContain('informed consent from both clients');
    // The layout's badge follows, and a lawyer can now open the lead.
    expect(page.text(page.body.querySelector('mt-matter-layout mt-badge'))).toBe('Potential conflict waived');
    await page.click('Open matter');
    expect(callsTo(page.port, 'matters-changeStatus')[0]?.data).toMatchObject({ matterId: 'm-lead', to: 'open' });
    expect(page.text()).toContain('M-2026-0200 is open');
  });

  it('needs a reason for a conflict too; Clear needs none', async () => {
    const page = await open('/matters/m-lead/conflicts');
    await page.run();
    await page.decide('Conflict');
    await page.record();
    expect(page.text(page.determination())).toContain('Say why this is a conflict.');
    expect(callsTo(page.port, 'conflicts-determine')).toHaveLength(0);
    await page.decide('Clear');
    await page.record();
    expect(callsTo(page.port, 'conflicts-determine')[0]?.data).toEqual({
      requestId: expect.any(String),
      checkId: 'chk-1',
      matterId: 'm-lead',
      status: 'clear',
    });
    expect(page.text(page.determination())).toContain('Clear');
  });

  it('shows the server’s refusal of a determination', async () => {
    const page = await open('/matters/m-lead/conflicts', LAWYER, {
      determine: () => {
        throw { code: 'functions/permission-denied', details: { code: 'PERMISSION_DENIED' } };
      },
    });
    await page.run();
    await page.record();
    expect(page.text(page.determination())).toContain('Your role can’t do this.');
  });

  it('lets a paralegal run the check and see the matches, but only a lawyer determines', async () => {
    const page = await open('/matters/m-lead/conflicts', PARALEGAL);
    await page.run();
    expect(callsTo(page.port, 'conflicts-run')).toHaveLength(1);
    expect(page.results()).toHaveLength(2);
    const determination = page.determination();
    expect(page.text(determination)).toContain('A lawyer must determine this check.');
    expect(determination?.querySelector('mt-radio-group')).toBeNull();
    expect(determination?.querySelector('form.decide')).toBeNull();
  });

  it('read-only members can’t run a check', async () => {
    const page = await open('/matters/m-lead/conflicts', READONLY);
    expect(page.buttons('Run conflict check')).toHaveLength(0);
    expect(page.text()).toContain('Your role can’t run conflict checks.');
    await page.run();
    expect(callsTo(page.port, 'conflicts-run')).toHaveLength(0);
  });

  it('shows the recorded determination before any run', async () => {
    const page = await open('/matters/m-lead/conflicts', LAWYER, {
      lead: {
        conflictCheck: {
          status: 'conflict',
          checkedAt: new Date('2026-09-30T02:00:00Z'),
          checkedBy: PRIYA,
          resultId: 'chk-0',
          reason: 'Acted for the other side in Ellis v Ferrand.',
        },
      },
    });
    const shown = page.text(page.determination());
    expect(shown).toContain('Conflict');
    expect(shown).toContain('Priya Shah');
    expect(shown).toMatch(/30 Sept? 2026/);
    expect(shown).toContain('Acted for the other side in Ellis v Ferrand.');
    expect(shown).toContain('Run the check to record a determination.');
    expect(page.body.querySelector('section.determination mt-badge')?.getAttribute('data-tone')).toBe('danger');
    // A conflict doesn't let the lead open.
    expect(page.buttons('Open matter')).toHaveLength(0);
  });

  it('adds, edits, validates and removes subjects before running', async () => {
    const page = await open('/matters/m-lead/conflicts');
    await page.click('Add person or organisation');
    expect(page.subjects()).toHaveLength(3);
    const added = page.subjects()[2] as HTMLFieldSetElement;
    await page.run();
    expect(callsTo(page.port, 'conflicts-run')).toHaveLength(0);
    expect(page.text(added)).toContain('Enter a name.');

    await page.type('Name', 'Ferrand Holdings Pty Ltd', added);
    await page.type('Date of birth', '31/02/1970', added);
    await page.run();
    expect(page.text(added)).toContain('Enter a date like 14/06/1968.');
    await page.type('Date of birth', '', added);
    await page.type('ABN', '12 345 678 901', added);
    const role = page.control('Role', added) as HTMLSelectElement;
    role.value = [...role.options].find((o) => o.textContent?.trim() === 'Defendant')?.value ?? '';
    role.dispatchEvent(new Event('change'));
    await page.stable();
    // Editing a prefilled name makes it someone else: the contact link goes.
    await page.type('Name', 'Walter J Thorne', page.subjects()[1]);
    // Remove the client.
    page.body.querySelector<HTMLElement>('button[aria-label="Remove Margot Anne Ellis"]')?.click();
    await page.stable();
    expect(page.subjects()).toHaveLength(2);
    await page.run();
    expect(callsTo(page.port, 'conflicts-run')[0]?.data).toMatchObject({
      subjects: [
        { kind: 'person', name: 'Walter J Thorne', role: 'deceased' },
        { kind: 'organisation', name: 'Ferrand Holdings Pty Ltd', role: 'defendant', abn: '12345678901' },
      ],
    });
    const sent = (callsTo(page.port, 'conflicts-run')[0]?.data as { subjects: Seed[] }).subjects;
    expect(sent[0]).not.toHaveProperty('contactId');
  });

  it('shows a failed run and lets it run again', async () => {
    const page = await open('/matters/m-lead/conflicts');
    const real = page.port.call.bind(page.port);
    let failed = false;
    page.port.call = async <T>(name: string, data: unknown): Promise<T> => {
      if (name === 'conflicts-run' && !failed) {
        failed = true;
        page.port.calls.push({ name, data });
        throw { code: 'functions/permission-denied', details: { code: 'PERMISSION_DENIED' } };
      }
      return real<T>(name, data);
    };
    await page.run();
    expect(page.text()).toContain('Your role can’t do this.');
    await page.run();
    const runs = callsTo(page.port, 'conflicts-run');
    expect(runs).toHaveLength(2);
    // The retry is the same logical request.
    expect((runs[1]?.data as Seed)['requestId']).toBe((runs[0]?.data as Seed)['requestId']);
    expect(page.results()).toHaveLength(2);
  });
});

describe('entry points', () => {
  it('the matter shows its conflict status, a link to the check for leads, and any alert', async () => {
    const page = await open('/matters/m-lead/overview', LAWYER, {
      lead: {
        conflictAlert: { checkId: 'chk-9', contactId: 'c-new', at: new Date(), adverse: 'Client against a plaintiff' },
      },
    });
    const layout = page.body.querySelector('mt-matter-layout');
    expect(page.text(layout?.querySelector('mt-badge'))).toBe('Conflict check needed');
    expect(page.text(layout?.querySelector('mt-note'))).toContain('(adverse: Client against a plaintiff)');
    await page.click('Conflict check', layout ?? page.body);
    expect(page.router.url).toBe('/matters/m-lead/conflicts');
    expect(page.panel()).not.toBeNull();
  });

  it('an open matter shows its status without the link', async () => {
    const page = await open('/matters/m-lead/overview', LAWYER, {
      lead: { status: 'open', conflictCheck: { status: 'clear' } },
    });
    const layout = page.body.querySelector('mt-matter-layout');
    expect(page.text(layout?.querySelector('mt-badge'))).toBe('Conflict check clear');
    expect(page.buttons('Conflict check', layout ?? page.body)).toHaveLength(0);
  });

  it('the Matters list offers "Run conflict check" for one selected lead, and explains a refused open', async () => {
    const page = await open('/matters?view=leads', PARALEGAL, {
      changeStatus: () => {
        throw {
          code: 'functions/failed-precondition',
          details: { code: 'FAILED_PRECONDITION', reason: 'conflict_check_not_clear', conflictStatus: 'pending' },
        };
      },
    });
    const row = page.body.querySelector<HTMLElement>('mt-table tbody tr[data-index="0"]');
    expect(row?.textContent).toContain('Estate of Walter Thorne');
    row?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await page.stable();
    const bar = page.body.querySelector<HTMLElement>('[aria-label="Bulk actions"]');
    await page.click('Run conflict check', bar ?? page.body);
    expect(page.router.url).toBe('/matters/m-lead/conflicts');
    TestBed.resetTestingModule();

    const lawyer = await open('/matters?view=leads', LAWYER, {
      changeStatus: () => {
        throw {
          code: 'functions/failed-precondition',
          details: { code: 'FAILED_PRECONDITION', reason: 'conflict_check_not_clear', conflictStatus: 'pending' },
        };
      },
    });
    lawyer.body.querySelector<HTMLElement>('mt-table tbody tr[data-index="0"] [role="checkbox"]')?.click();
    await lawyer.stable();
    await lawyer.click('Change status', lawyer.body.querySelector('[aria-label="Bulk actions"]') ?? lawyer.body);
    [...lawyer.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.trim() === 'Open')
      ?.click();
    await lawyer.stable();
    expect(lawyer.text()).toContain(
      'M-2026-0200: The conflict check needs a lawyer’s determination before the matter can open.',
    );
  });

  it('hides "Run conflict check" for an open matter or several selected', async () => {
    const page = await open('/matters?view=all-open', LAWYER, {
      lead: { status: 'open', conflictCheck: { status: 'clear' } },
    });
    page.body.querySelector<HTMLElement>('mt-table tbody tr[data-index="0"] [role="checkbox"]')?.click();
    await page.stable();
    const bar = page.body.querySelector<HTMLElement>('[aria-label="Bulk actions"]');
    expect(bar?.textContent).toContain('1 selected');
    expect(bar?.textContent).not.toContain('Run conflict check');
  });
});

describe('conflict view helpers', () => {
  it('words reasons, scores, statuses and roles', () => {
    expect(matchReasons(['name', 'dateOfBirth'])).toBe('Name, date of birth');
    expect(matchReasons(['abn', 'email'])).toBe('ABN, email');
    expect(scorePercent(0.875)).toBe('88%');
    expect(scorePercent(1.2)).toBe('100%');
    expect(roleName('other_side_solicitor')).toBe('Other side’s solicitor');
    expect(roleName('safe_custody')).toBe('safe custody');
    expect(conflictBadgeText(undefined)).toBe('Conflict check needed');
    expect(conflictBadgeText('conflict')).toBe('Conflict');
    expect(
      hitMatterBadge({ matterId: 'm', number: 'M-1', title: 'T', status: 'on_hold', type: 'will', role: 'client' }),
    ).toEqual({
      text: 'On hold',
      tone: 'warning',
    });
  });

  it('groups hits by subject, best first, and keeps subjects with none', () => {
    const subjects = [
      { name: 'A Fictional', role: 'client' as const },
      { name: 'B Fictional', role: 'executor' as const },
    ];
    const hit = (subject: number, displayName: string, score: number): ConflictHit => ({
      subject,
      contactId: displayName,
      displayName,
      score,
      reasons: ['name'],
      matters: [],
    });
    const groups = groupHits(subjects, [hit(0, 'Low', 0.8), hit(0, 'High', 0.95), hit(0, 'Also low', 0.8)]);
    expect(groups.map((g) => g.hits.map((h) => h.displayName))).toEqual([['High', 'Also low', 'Low'], []]);
  });

  it('parses dates of birth and lists a matter’s subjects once each', () => {
    expect(parseDob('4/7/1950')).toBe('1950-07-04');
    expect(parseDob('1950-07-04')).toBe('1950-07-04');
    expect(parseDob('31/02/1950')).toBeNull();
    expect(parseDob('')).toBeNull();
    expect(formatDob('1950-07-04')).toBe('04/07/1950');
    expect(formatDob(undefined)).toBe('');
    expect(
      matterSubjectRefs({
        number: 'M-1',
        title: 'T',
        type: 'will',
        status: 'lead',
        clientContactIds: ['c-1', 'c-2', 'c-1'],
        testator: { contactId: 'c-1' },
      }),
    ).toEqual([
      { contactId: 'c-1', role: 'client' },
      { contactId: 'c-2', role: 'client' },
      { contactId: 'c-1', role: 'testator' },
    ]);
  });

  it('words a refused open', () => {
    const refusal = (conflictStatus: string) => ({
      details: { code: 'FAILED_PRECONDITION', reason: 'conflict_check_not_clear', conflictStatus },
    });
    expect(changeStatusErrorCopy(refusal('pending'))).toContain('needs a lawyer’s determination');
    expect(changeStatusErrorCopy(refusal('conflict'))).toContain('found a conflict');
    expect(changeStatusErrorCopy({ details: { code: 'MATTER_INVALID_TRANSITION' } })).toContain('can’t move');
  });
});
