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
  type FlagValue,
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
const claims = (role: 'admin' | 'paralegal' | 'readonly') => ({
  claims: { orgId: ORG, role, orgName: 'Harbour & Vine Legal' },
});
export const LAWYER = testSession();
export const ADMIN = testSession({ uid: PRIYA, email: 'owner@harbourvine.example', ...claims('admin') });
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

/** A recompute that changed nothing; tests pass their own `proposed`, `created`. */
export function recomputeSummary(changes: Partial<Record<'created' | 'proposed', string[]>> = {}) {
  return {
    ran: true,
    recomputeVersion: 1,
    created: [],
    updated: [],
    proposed: [],
    superseded: [],
    calendarMissing: [],
    createdTaskIds: [],
    statutoryDisabled: false,
    ...changes,
  };
}

const KEY_FACT_EVENTS: Record<string, (matter: Seed, date: string | undefined) => Seed> = {
  date_of_death: (matter, date) => ({ deceased: { ...(matter['deceased'] as Seed), dateOfDeath: date } }),
  grant_issued: (matter, date) => ({ estate: { ...(matter['estate'] as Seed), grantDate: date } }),
};

/**
 * The `deadlines-*` callables (CORE-10) as the server runs them, without the engine: events are
 * written (setting their key fact), deadlines closed or overridden, and proposals decided.
 */
export function deadlineServerCallables(): Record<string, FakeCallable> {
  let nextEvent = 1;
  return {
    'deadlines-upsertEvent': (data, fs) => {
      const matter = fs.get(MATTER) as Seed;
      if (data['kind'] === 'date_of_death' && String(data['date']) > TODAY) {
        throw {
          code: 'functions/invalid-argument',
          details: { code: 'INVALID_ARGUMENT', fields: { date: ['A date of death can’t be after today'] } },
        };
      }
      const eventId = String(data['eventId'] ?? `ev-${nextEvent++}`);
      fs.set(`${MATTER}/events/${eventId}`, {
        kind: data['kind'],
        date: data['date'],
        ...(data['label'] ? { label: data['label'] } : {}),
        meta: {},
        orgId: ORG,
        matterId: 'm-whitfield',
        deletedAt: null,
        ...meta,
      });
      const fact = KEY_FACT_EVENTS[String(data['kind'])];
      if (fact) fs.set(MATTER, { ...matter, ...fact(matter, String(data['date'])) });
      return { eventId, recompute: recomputeSummary(), filledTaskIds: [] };
    },
    'deadlines-deleteEvent': (data, fs) => {
      const path = `${MATTER}/events/${String(data['eventId'])}`;
      const event = fs.get(path) as Seed;
      fs.set(path, { ...event, deletedAt: new Date() });
      const fact = KEY_FACT_EVENTS[String(event['kind'])];
      const matter = fs.get(MATTER) as Seed;
      if (fact) fs.set(MATTER, { ...matter, ...fact(matter, undefined) });
      return { eventId: data['eventId'], recompute: recomputeSummary() };
    },
    'deadlines-complete': (data, fs) => {
      const path = `${MATTER}/deadlines/${String(data['deadlineId'])}`;
      const deadline = fs.get(path) as Seed;
      if (deadline['status'] !== 'upcoming') {
        throw {
          code: 'functions/failed-precondition',
          details: { code: 'FAILED_PRECONDITION', reason: 'deadline_not_open' },
        };
      }
      const on = String(data['completedOn'] ?? TODAY);
      fs.set(path, {
        ...deadline,
        status: data['outcome'],
        resolution: { on, by: ME, at: new Date(), ...(data['reason'] ? { reason: data['reason'] } : {}) },
      });
      const taskId = deadline['taskId'] as string | undefined;
      if (taskId && data['completeLinkedTasks']) {
        fs.set(`${MATTER}/tasks/${taskId}`, { ...(fs.get(`${MATTER}/tasks/${taskId}`) as Seed), status: 'done' });
      }
      return {
        deadlineId: data['deadlineId'],
        status: data['outcome'],
        openLinkedTaskIds: taskId && !data['completeLinkedTasks'] ? [taskId] : [],
        completedTaskIds: taskId && data['completeLinkedTasks'] ? [taskId] : [],
      };
    },
    'deadlines-override': (data, fs) => {
      const path = `${MATTER}/deadlines/${String(data['deadlineId'])}`;
      const deadline = fs.get(path) as Seed & { computed?: Seed };
      if (data['dueDate'] === null) {
        const { override: _override, ...rest } = deadline;
        void _override;
        fs.set(path, { ...rest, dueDate: deadline.computed?.['dueDate'] });
        return { deadlineId: data['deadlineId'], dueDate: deadline.computed?.['dueDate'], overrideConflict: false };
      }
      fs.set(path, {
        ...deadline,
        dueDate: data['dueDate'],
        override: { dueDate: data['dueDate'], reason: data['reason'], by: ME, at: new Date() },
      });
      return { deadlineId: data['deadlineId'], dueDate: data['dueDate'], overrideConflict: false };
    },
    'deadlines-resolveChange': (data, fs) => {
      const path = `${MATTER}/deadlineChanges/${String(data['changeId'])}`;
      const change = fs.get(path) as Seed;
      const matter = fs.get(MATTER) as Seed;
      if (data['accept'] && change['critical'] && data['confirmation'] !== matter['number']) {
        throw {
          code: 'functions/invalid-argument',
          details: {
            code: 'INVALID_ARGUMENT',
            fields: { confirmation: ['Type the matter number exactly to confirm'] },
          },
        };
      }
      const status = data['accept'] ? 'accepted' : 'rejected';
      fs.set(path, { ...change, status, resolvedBy: ME, resolvedAt: new Date() });
      const deadlinePath = `${MATTER}/deadlines/${String(change['deadlineId'])}`;
      if (data['accept']) {
        const deadline = fs.get(deadlinePath) as Seed;
        fs.set(
          deadlinePath,
          change['kind'] === 'removed'
            ? { ...deadline, status: 'superseded' }
            : { ...deadline, dueDate: change['toDueDate'] },
        );
      }
      return { changeId: data['changeId'], deadlineId: change['deadlineId'], status };
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
  /** Feature flags as Remote Config values (`{ 'templates.system': true }`). */
  flags?: Record<string, FlagValue>;
}

/** Matter templates on (CORE-07). */
export const TEMPLATES_ON = { 'templates.system': true };

/** Renders the app at `url` with the fictional practice seeded. */
export async function openMatter(url = '/matters/m-whitfield/overview', options: OpenOptions = {}) {
  const port = new FakeAuthPort(options.session ?? LAWYER);
  const firestore = new InMemoryFirestore();
  seed(firestore, options.matter);
  options.configure?.(firestore, port);
  const callables = { ...serverCallables(), ...deadlineServerCallables(), ...options.callables };
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
      ...provideTestFlags(options.flags),
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
