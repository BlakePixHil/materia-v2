import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, TitleStrategy } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import {
  clientContactIdsFrom,
  contactSearchTokens,
  DEFAULT_MATTER_STAGES,
  matterSearchTokens,
  partyDocId,
  unmetStageRequirements,
  type DateOnly,
  type PartyRole,
} from '@materia/domain';
import { MT_KEYBOARD_PLATFORM, MT_TODAY } from '@materia/ui';

import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';
import { MateriaTitleStrategy } from '../../core/title-strategy';

/**
 * The matter screen's specs (CORE-06): a fictional practice in the in-memory Firestore and fake
 * `matters-*` callables that behave like the server (they write what the server would). Fictional
 * data only.
 */

export const ORG = 'org-harbour-vine';
export const MATTER = `orgs/${ORG}/matters/m-whitfield`;
export const TODAY = '2026-10-04' as DateOnly;
export const ME = 'user-jordan';
export const PRIYA = 'user-priya';
const claims = (role: 'paralegal' | 'readonly') => ({ claims: { orgId: ORG, role, orgName: 'Harbour & Vine Legal' } });
export const LAWYER = testSession();
export const PARALEGAL = testSession(claims('paralegal'));
export const READONLY = testSession(claims('readonly'));

type Seed = Record<string, unknown>;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};

/** A stored probate matter as the server keeps it. */
export function matterDoc(data: Seed = {}): Seed {
  return {
    number: 'M-2026-0142',
    title: 'Estate of Margaret Whitfield',
    type: 'probate',
    status: 'open',
    stageId: 'intake',
    jurisdiction: 'VIC',
    responsibleUid: ME,
    teamUids: [PRIYA],
    clientContactIds: ['c-avery'],
    privileged: false,
    priority: 'medium',
    labels: ['grant'],
    openTaskCount: 1,
    wipCents: 0,
    fee: { arrangement: 'hourly', history: [] },
    costsDisclosure: { status: 'sent' },
    conflictCheck: { status: 'clear' },
    deceased: { contactId: 'c-margaret', dateOfDeath: '2026-07-22', domicile: 'VIC', lastAddress: '1 Fictional St' },
    estate: { grantType: 'probate' },
    search: matterSearchTokens({ number: 'M-2026-0142', title: 'Estate of Margaret Whitfield', clientNames: [] }),
    deletedAt: null,
    ...meta,
    ...data,
  };
}

export function contactDoc(givenNames: string, familyName: string, data: Seed = {}): Seed {
  return {
    kind: 'person',
    givenNames,
    familyName,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames, familyName }),
    sortName: `${familyName} ${givenNames}`.toLowerCase(),
    ...meta,
    ...data,
  };
}

export function partyDoc(role: PartyRole, contactId: string, data: Seed = {}): [string, Seed] {
  return [
    `${MATTER}/parties/${partyDocId(role, contactId)}`,
    { contactId, role, orgId: ORG, matterId: 'm-whitfield', addedFrom: 'manual', deletedAt: null, ...meta, ...data },
  ];
}

/** Members, contacts, the matter with a client and the deceased, a deadline, a task and activity. */
export function seed(fs: InMemoryFirestore, matter: Seed = {}): void {
  const member = (uid: string, displayName: string, role: string) =>
    fs.set(`orgs/${ORG}/members/${uid}`, { displayName, email: `${uid}@example.test`, role, status: 'active' });
  member(ME, 'Jordan Price', 'lawyer');
  member(PRIYA, 'Priya Shah', 'owner');
  member('user-daniel', 'Daniel Kim', 'paralegal');
  member('user-sam', 'Sam Lee', 'readonly');
  fs.set(`orgs/${ORG}/contacts/c-avery`, contactDoc('Avery', 'Quill'));
  fs.set(`orgs/${ORG}/contacts/c-margaret`, contactDoc('Margaret', 'Whitfield', { dateOfDeath: '2026-07-22' }));
  fs.set(`orgs/${ORG}/contacts/c-bram`, contactDoc('Bram', 'Ostler', { dateOfBirth: '1971-02-03' }));
  fs.set(MATTER, matterDoc(matter));
  fs.set(...partyDoc('client', 'c-avery'));
  fs.set(...partyDoc('deceased', 'c-margaret'));
  fs.set(`${MATTER}/deadlines/d-notice`, {
    title: 'Advertise notice of intended application',
    dueDate: '2026-10-08',
    critical: true,
    status: 'upcoming',
    kind: 'statutory',
    assigneeUid: ME,
    orgId: ORG,
    matterId: 'm-whitfield',
    ...meta,
  });
  fs.set(`${MATTER}/tasks/t-cert`, {
    title: 'Order the death certificate',
    status: 'todo',
    priority: 'high',
    assigneeUid: 'user-daniel',
    dueDate: '2026-10-06',
    order: 1,
    checklist: [],
    orgId: ORG,
    matterId: 'm-whitfield',
    ...meta,
  });
  fs.set(`${MATTER}/activity/a1`, {
    kind: 'matter.opened',
    summary: 'Opened the matter',
    actorUid: PRIYA,
    at: new Date('2026-10-03T01:00:00Z'),
  });
}

export type FakeCallable = (data: Seed, fs: InMemoryFirestore) => unknown;

/** The `matters-*` callables as the server runs them, against the in-memory Firestore. */
export function serverCallables(): Record<string, FakeCallable> {
  return {
    'matters-changeStatus': (data, fs) => {
      fs.set(MATTER, { ...fs.get(MATTER), status: data['to'], updatedBy: ME });
      return { matterId: data['matterId'], status: data['to'] };
    },
    'matters-changeStage': (data, fs) => {
      const matter = fs.get(MATTER) as Seed & { stageId?: string };
      const missing = unmetStageRequirements(
        matter as never,
        DEFAULT_MATTER_STAGES.probate,
        matter.stageId,
        String(data['stageId']),
      );
      if (missing.length) {
        throw {
          code: 'functions/failed-precondition',
          details: { code: 'MATTER_STAGE_REQUIREMENTS', requirements: missing },
        };
      }
      fs.set(MATTER, { ...matter, stageId: data['stageId'] });
      return { matterId: data['matterId'], stageId: data['stageId'] };
    },
    'matters-upsertParty': (data, fs) => {
      const role = data['role'] as PartyRole;
      const contactId = String(data['contactId']);
      const partyId = partyDocId(role, contactId);
      if (data['partyId'] && data['partyId'] !== partyId) {
        const old = `${MATTER}/parties/${String(data['partyId'])}`;
        fs.set(old, { ...fs.get(old), deletedAt: new Date() });
      }
      const [path, doc] = partyDoc(role, contactId, data['share'] ? { share: data['share'] } : {});
      fs.set(path, doc);
      return { matterId: data['matterId'], partyId, clientContactIds: clientIds(fs) };
    },
    'matters-removeParty': (data, fs) => {
      const path = `${MATTER}/parties/${String(data['partyId'])}`;
      const party = fs.get(path) as Seed | undefined;
      if (party?.['role'] === 'client' && clientIds(fs).length <= 1) {
        throw { code: 'functions/failed-precondition', details: { code: 'LAST_CLIENT' } };
      }
      fs.set(path, { ...party, deletedAt: new Date() });
      return { matterId: data['matterId'], partyId: data['partyId'], clientContactIds: clientIds(fs) };
    },
  };
}

function clientIds(fs: InMemoryFirestore): string[] {
  const rows = ['c-avery', 'c-bram', 'c-margaret']
    .map((id) => fs.get(`${MATTER}/parties/${partyDocId('client', id)}`) as Seed | undefined)
    .filter((row): row is Seed => !!row && !row['deletedAt']);
  return clientContactIdsFrom(rows as never);
}

export interface OpenOptions {
  session?: AuthSession;
  /** Changes to the seeded matter. */
  matter?: Seed;
  configure?: (fs: InMemoryFirestore, port: FakeAuthPort) => void;
  /** Callables to replace (by name). */
  callables?: Record<string, FakeCallable>;
}

/** Renders the app at `url` with the fictional practice seeded. */
export async function openMatter(url = '/matters/m-whitfield/overview', options: OpenOptions = {}) {
  const port = new FakeAuthPort(options.session ?? LAWYER);
  const firestore = new InMemoryFirestore();
  seed(firestore, options.matter);
  options.configure?.(firestore, port);
  const callables = { ...serverCallables(), ...options.callables };
  port.call = async <T>(name: string, data: unknown): Promise<T> => {
    port.calls.push({ name, data });
    const handler = callables[name];
    if (!handler) throw new Error(`Unexpected callable ${name}`);
    return handler(data as Seed, firestore) as T;
  };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: TitleStrategy, useClass: MateriaTitleStrategy },
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
  const text = (node: ParentNode | null | undefined = body) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const buttons = (label: string, root: ParentNode = body) =>
    [...root.querySelectorAll<HTMLElement>('button, a, [role="menuitem"], [role="menuitemcheckbox"]')].filter(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    );
  const click = async (label: string, root: ParentNode = body) => {
    const found = buttons(label, root)[0];
    if (!found) throw new Error(`No button "${label}"`);
    found.click();
    await stable();
  };
  const dialog = () => body.querySelector<HTMLElement>('.mt-dialog');
  /** Types into the field labelled `label` (an input, select or textarea under it). */
  const fill = async (label: string, value: string, root: ParentNode = body) => {
    const host = [...root.querySelectorAll('mt-text-field, mt-select, mt-search-field, mt-textarea')].find(
      (field) =>
        field.querySelector('.mt-label')?.textContent?.trim().startsWith(label) ||
        field.querySelector('input')?.getAttribute('aria-label') === label,
    );
    const input = host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select, textarea');
    if (!input) throw new Error(`No field "${label}"`);
    input.value = value;
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
    await stable();
  };
  const submit = async (root: ParentNode | null) => {
    root?.querySelector('form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  const press = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = body) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    await stable();
  };
  const layout = () => body.querySelector<HTMLElement>('mt-matter-layout');
  const header = () => body.querySelector<HTMLElement>('mt-matter-header');
  const calls = (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.data as Seed);
  return {
    port,
    firestore,
    router,
    body,
    stable,
    text,
    buttons,
    click,
    dialog,
    fill,
    submit,
    press,
    layout,
    header,
    calls,
  };
}

/** Removes overlays a test left open (dialogs, menus, toasts). */
export function cleanUpOverlays(): void {
  document.querySelectorAll('.mt-overlay, .mt-toast-region, [data-overlay]').forEach((node) => node.remove());
}
