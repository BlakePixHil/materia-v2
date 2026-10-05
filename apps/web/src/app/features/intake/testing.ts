import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import {
  contactSearchTokens,
  type ConflictHit,
  type FlagValue,
  type IntakeStepId,
  type RunConflictCheckResult,
} from '@materia/domain';
import { MT_KEYBOARD_PLATFORM, MT_TODAY } from '@materia/ui';

import { CONTACT_SEARCH_DEBOUNCE_MS } from './contact-picker';
import { INTAKE_AUTOSAVE_MS } from './intake-page';
import { emptyIntakeState, intakeContact, type IntakeState } from './intake-state';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/**
 * The New matter intake's specs (CORE-05): a fictional practice in the in-memory Firestore and
 * fake callables that answer like the server. Fictional data only.
 */

export const ORG = 'org-harbour-vine';
export const ME = 'user-jordan';
export const TODAY = '2026-10-04';
export const DRAFTS = `users/${ME}/drafts`;
export const LAWYER = testSession();
export const PARALEGAL = testSession({ claims: { orgId: ORG, role: 'paralegal', orgName: 'Harbour & Vine Legal' } });

type Seed = Record<string, unknown>;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};

function contactDoc(givenNames: string, familyName: string, data: Seed = {}): Seed {
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

/** Contacts: Avery Quill (client), Margaret Whitfield (died 22 July 2026), Bram Ostler, Celia Ostler. */
export const CONTACTS: Record<string, [string, string, Seed?]> = {
  'c-avery': [
    'Avery',
    'Quill',
    { dateOfBirth: '1980-05-01', emails: [{ address: 'avery@example.test', type: 'personal' }] },
  ],
  'c-margaret': ['Margaret', 'Whitfield', { dateOfBirth: '1941-02-03', dateOfDeath: '2026-07-22' }],
  'c-bram': ['Bram', 'Ostler'],
  'c-celia': ['Celia', 'Ostler'],
};

function seed(fs: InMemoryFirestore): void {
  const member = (uid: string, displayName: string, role: string) =>
    fs.set(`orgs/${ORG}/members/${uid}`, { displayName, email: `${uid}@example.test`, role, status: 'active' });
  member(ME, 'Jordan Price', 'lawyer');
  member('user-priya', 'Priya Shah', 'owner');
  member('user-daniel', 'Daniel Kim', 'paralegal');
  for (const [id, [given, family, data]] of Object.entries(CONTACTS)) {
    fs.set(`orgs/${ORG}/contacts/${id}`, contactDoc(given, family, data));
  }
}

/** A form state with the given contacts remembered (as the steps remember them when picked). */
export function stateWith(patch: Partial<IntakeState>, contactIds: string[] = Object.keys(CONTACTS)): IntakeState {
  const contacts = Object.fromEntries(
    contactIds.map((id) => {
      const [givenNames, familyName, data] = CONTACTS[id] ?? ['Someone', 'Else'];
      return [id, intakeContact({ kind: 'person', givenNames, familyName, ...(data ?? {}) })];
    }),
  );
  return { ...emptyIntakeState(), contacts, ...patch };
}

/** A probate intake complete up to the fees step. */
export function probateState(patch: Partial<IntakeState> = {}): IntakeState {
  const base = emptyIntakeState();
  return stateWith({
    type: 'probate',
    clientContactIds: ['c-avery'],
    details: {
      ...base.details,
      deceasedContactId: 'c-margaret',
      dateOfDeath: '22/07/2026',
      domicile: 'VIC',
      willExists: true,
      willDate: '01/03/2019',
    },
    parties: [{ contactId: 'c-avery', role: 'executor', share: '' }],
    partiesPrefilledFor: 'probate',
    fees: { ...base.fees, arrangement: 'fixed', amount: '4,500' },
    reached: 4,
    ...patch,
  });
}

/** A stored intake draft at `step` (resumed with "Resume draft"). */
export function draftDoc(state: IntakeState, step: IntakeStepId, updatedAt = new Date('2026-10-03T22:00:00Z')): Seed {
  return {
    orgId: ORG,
    kind: 'intake',
    step,
    stateJson: JSON.stringify(state),
    expireAt: new Date('2026-11-02T22:00:00Z'),
    ...meta,
    updatedAt,
  };
}

/** Margot-style hits are not needed here: by default the check finds nobody. */
export type FakeCallable = (data: Seed, fs: InMemoryFirestore) => unknown;

export interface OpenOptions {
  session?: AuthSession;
  url?: string;
  /** Seeds before the page opens (drafts, more contacts). */
  configure?: (fs: InMemoryFirestore) => void;
  callables?: Record<string, FakeCallable>;
  hits?: ConflictHit[];
  flags?: Record<string, FlagValue>;
  /** The autosave debounce (5 ms unless a test needs to see the wait). */
  autosaveMs?: number;
}

/** Opens `/matters/new` (or `url`) in the app with the fictional practice. */
export async function openIntake(options: OpenOptions = {}) {
  const port = new FakeAuthPort(options.session ?? LAWYER);
  const firestore = new InMemoryFirestore();
  seed(firestore);
  options.configure?.(firestore);
  let checks = 0;
  const callables: Record<string, FakeCallable> = {
    'conflicts-run': () =>
      ({
        checkId: `chk-${++checks}`,
        hits: options.hits ?? [],
        adverseRolesChecked: true,
      }) satisfies RunConflictCheckResult,
    'matters-createMatter': () => ({ matterId: 'm-new', number: 'M-2026-0300', status: 'open' }),
    ...options.callables,
  };
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
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: MT_TODAY, useValue: () => TODAY },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
      { provide: INTAKE_AUTOSAVE_MS, useValue: options.autosaveMs ?? 5 },
      { provide: CONTACT_SEARCH_DEBOUNCE_MS, useValue: 0 },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(options.flags),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(options.url ?? '/matters/new');
  const body = document.body;
  const stable = async (ms = 0) => {
    await settle(ms);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  };
  await stable();
  await stable();
  const page = () => body.querySelector<HTMLElement>('mt-intake-page');
  const text = (node: ParentNode | null | undefined = page()) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const buttons = (label: string, root: ParentNode = body) =>
    [...root.querySelectorAll<HTMLElement>('button, a')].filter(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    );
  const click = async (label: string, root: ParentNode = body) => {
    const found = buttons(label, root)[0];
    if (!found) throw new Error(`No button "${label}"`);
    found.click();
    await stable();
  };
  /** The field labelled `label` (an input, select or textarea under it). */
  const field = (label: string, root: ParentNode = body) => {
    const host = [...root.querySelectorAll('mt-text-field, mt-select, mt-search-field, mt-textarea')].find(
      (node) =>
        node
          .querySelector('.mt-label')
          ?.textContent?.trim()
          .replace(/\s*Optional$/, '') === label || node.querySelector('input')?.getAttribute('aria-label') === label,
    );
    return host?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
  };
  const fill = async (label: string, value: string, root: ParentNode = body) => {
    const input = field(label, root);
    if (!input) throw new Error(`No field "${label}"`);
    input.value = value;
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
    await stable();
  };
  /** Types into a contact search and waits for its debounce and results. */
  const search = async (label: string, value: string) => {
    await fill(label, value);
    await stable(5);
  };
  /** Clicks a ChoiceCard, radio or checkbox by its label text. */
  const choose = async (label: string) => {
    const item = [...body.querySelectorAll<HTMLElement>('[ngpRadioItem], .mt-choice')].find((node) =>
      node.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    );
    const target = item?.matches('[ngpRadioItem]') ? item : item?.querySelector<HTMLElement>('button');
    if (!target) throw new Error(`No choice "${label}"`);
    target.click();
    await stable();
  };
  const press = async (key: string, target: EventTarget = page() ?? body, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    await stable();
  };
  const step = () => body.querySelector('#intake-step-h')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const errors = () => [...(page()?.querySelectorAll('.mt-error') ?? [])].map((e) => e.textContent?.trim() ?? '');
  const dialog = () => body.querySelector<HTMLElement>('.mt-dialog');
  const calls = (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.data as Seed);
  /** Opens with a draft at `step` and resumes it. */
  return {
    port,
    firestore,
    router,
    body,
    stable,
    page,
    text,
    buttons,
    click,
    field,
    fill,
    search,
    choose,
    press,
    step,
    errors,
    dialog,
    calls,
  };
}

/** Opens the intake on a stored draft and resumes it at `step`. */
export async function resumeAt(state: IntakeState, step: IntakeStepId, options: OpenOptions = {}) {
  const page = await openIntake({
    ...options,
    configure: (fs) => {
      fs.set(`${DRAFTS}/intake-d1`, draftDoc(state, step));
      options.configure?.(fs);
    },
  });
  await page.click('Resume draft');
  return page;
}

/**
 * Renders the intake once before a file's tests (lazy chunks, the shell, the first change
 * detection), so the first test doesn't pay for it.
 */
export async function warmUp(): Promise<void> {
  await Promise.all([import('./intake-page'), import('../contacts/contact-form-dialog')]);
  await openIntake();
  TestBed.resetTestingModule();
  cleanUpOverlays();
}

/** Removes overlays a test left open (dialogs, toasts). */
export function cleanUpOverlays(): void {
  document.querySelectorAll('.mt-overlay, .mt-toast-region, [data-overlay]').forEach((node) => node.remove());
}
