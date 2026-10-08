import { TestBed } from '@angular/core/testing';

import type { InMemoryFirestore } from '@materia/data-access/repository';

import {
  bulkLabel,
  draftFrom,
  editFields,
  formatDay,
  isExpired,
  parseDay,
  payloadFrom,
  staleLines,
  suggestionVm,
  type SuggestionRecord,
} from './suggestion-view';
import { storedDocument } from '../documents/testing';
import {
  cleanUpOverlays,
  MATTER,
  meta,
  openMatter,
  ORG,
  PARALEGAL,
  READONLY,
  type FakeCallable,
  type OpenOptions,
} from '../matter-detail/testing';

/** Clerk suggestions on the matter Overview (AI-07). Fictional data only. */

afterEach(cleanUpOverlays);

const FLAGS = { 'clerk.features.suggestions': true };
const FUTURE = new Date('2099-01-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');

type Seed = Record<string, unknown>;

function suggestionDoc(kind: string, payload: Seed, data: Seed = {}): Seed {
  return {
    kind,
    payload,
    citations: [],
    status: 'proposed',
    promptId: 'suggest',
    promptVersion: '1.0.0',
    model: 'test-model',
    privileged: false,
    basis: 'b-1',
    basisParts: {},
    dedupeKey: `${kind}:${JSON.stringify(payload)}`,
    expiresAt: FUTURE,
    orgId: ORG,
    matterId: 'm-whitfield',
    ...meta,
    createdBy: 'clerk',
    ...data,
  };
}

const path = (id: string) => `${MATTER}/suggestions/${id}`;

function seedSuggestions(fs: InMemoryFirestore): void {
  fs.set(`${MATTER}/documents/doc-will`, storedDocument('doc-will', 'Will of Fictional Whitfield.pdf'));
  fs.set(
    path('s-task'),
    suggestionDoc(
      'task',
      { title: 'Request the date-of-death valuation', priority: 'medium' },
      {
        rationale: 'The will leaves the house at 14 Fictional St to the residuary beneficiaries.',
        citations: [{ documentId: 'doc-will', page: 2, quote: 'my house' }],
      },
    ),
  );
  fs.set(path('s-task-2'), suggestionDoc('task', { title: 'Write to the bank', priority: 'none' }));
  fs.set(path('s-fact'), suggestionDoc('key_fact', { field: 'willDate', value: '2019-09-30' }));
  fs.set(path('s-old'), suggestionDoc('note', { bodyMd: 'An old idea', pinned: false }, { expiresAt: PAST }));
  fs.set(
    path('s-priv'),
    suggestionDoc('note', { bodyMd: 'Counsel’s advice on the claim', pinned: false }, { privileged: true }),
  );
}

/** The `suggestions-*` callables as the server runs them, without the domain writes. */
function suggestionCallables(overrides: Record<string, FakeCallable> = {}): Record<string, FakeCallable> {
  const resolve = (fs: InMemoryFirestore, id: string, data: Seed) => fs.set(path(id), { ...fs.get(path(id)), ...data });
  return {
    'suggestions-accept': (data, fs) => {
      const id = String(data['suggestionId']);
      const status = data['editedPayload'] ? 'edited' : 'accepted';
      resolve(fs, id, { status, resultRef: `${MATTER}/tasks/t-new` });
      return { suggestionId: id, status, resultRef: `${MATTER}/tasks/t-new` };
    },
    'suggestions-acceptMany': (data, fs) => {
      const ids = data['suggestionIds'] as string[];
      for (const id of ids) resolve(fs, id, { status: 'accepted' });
      return {
        results: ids.map((id) => ({ ok: true, suggestionId: id, status: 'accepted', resultRef: 'x' })),
        accepted: ids.length,
        failed: 0,
      };
    },
    'suggestions-dismiss': (data, fs) => {
      const id = String(data['suggestionId']);
      resolve(fs, id, { status: 'dismissed', dismissReason: data['reason'] });
      return { suggestionId: id, status: 'dismissed' };
    },
    ...overrides,
  };
}

function open(options: OpenOptions = {}) {
  return openMatter(undefined, {
    flags: FLAGS,
    ...options,
    configure: (fs, port) => {
      seedSuggestions(fs);
      options.configure?.(fs, port);
    },
    callables: { ...suggestionCallables(), ...options.callables },
  });
}

type Page = Awaited<ReturnType<typeof open>>;
const section = (page: Page) => page.body.querySelector<HTMLElement>('mt-matter-suggestions section');
const card = (page: Page, id: string) =>
  page.body.querySelector<HTMLElement>(`mt-suggestion-card:has([data-suggestion="${id}"])`) ??
  page.body.querySelector<HTMLElement>(`[data-suggestion="${id}"]`)?.closest<HTMLElement>('mt-suggestion-card') ??
  null;
const titles = (page: Page) =>
  [...(section(page)?.querySelectorAll('mt-suggestion .tt') ?? [])].map((node) => page.text(node));

describe('suggestion view', () => {
  const record = (kind: SuggestionRecord['kind'], payload: Seed, data: Partial<SuggestionRecord> = {}) =>
    ({ ...(suggestionDoc(kind, payload) as unknown as SuggestionRecord), id: 's-1', ...data }) as SuggestionRecord;

  it('labels the kind and the citations', () => {
    const vm = suggestionVm(
      record(
        'task',
        { title: 'Call the executor', priority: 'none' },
        {
          citations: [
            { kind: 'document', documentId: 'd-1', docVersion: 2, page: 3, quote: 'the residue' },
            { kind: 'document', documentId: 'd-2', quote: 'the house', verified: false },
            { kind: 'record', recordRef: { collection: 'deadlines', id: 'dl-1' }, quote: 'Notice expires' },
          ],
        },
      ),
    );
    expect(vm).toMatchObject({ kind: 'Task', title: 'Call the executor', acceptLabel: 'Add task' });
    expect(vm.citations?.map((c) => c.label)).toEqual(['p. 3', 'Source', 'Source']);
    expect(vm.citations?.[0]).toMatchObject({ n: 1, version: 2 });
    expect(vm.citations?.[1]).toMatchObject({ verified: false });
    expect(vm.citations?.[2]).toMatchObject({ documentId: 'dl-1', kind: 'record' });
  });

  it('edits a key fact by its kind: dates as DD/MM/YYYY, money in dollars', () => {
    const will = record('key_fact', { field: 'willDate', value: '2019-09-30' });
    expect(editFields(will)).toEqual([{ key: 'value', label: 'Will date', type: 'date' }]);
    expect(draftFrom(will)).toEqual({ value: '30/09/2019' });
    expect(payloadFrom(will, { value: '1/10/2019' })).toEqual({ payload: { field: 'willDate', value: '2019-10-01' } });
    expect(payloadFrom(will, { value: '31/02/2019' })).toEqual({ errors: { value: ['Enter a date as DD/MM/YYYY'] } });

    const gross = record('key_fact', { field: 'grossValue', value: 125_000_00 });
    expect(draftFrom(gross)).toEqual({ value: '125000.00' });
    expect(payloadFrom(gross, { value: '$1,250.50' })).toEqual({ payload: { field: 'grossValue', value: 125_050 } });
  });

  it('validates an edit with the kind’s payload schema, keyed by field', () => {
    const task = record('task', { title: 'Call the executor', priority: 'none', dueDate: '2026-10-09' });
    expect(draftFrom(task)).toMatchObject({ title: 'Call the executor', dueDate: '09/10/2026', descriptionMd: '' });
    const cleared = payloadFrom(task, { ...draftFrom(task), dueDate: '' });
    expect(cleared).toEqual({ payload: { title: 'Call the executor', priority: 'none' } });
    const missing = payloadFrom(task, { ...draftFrom(task), title: '' });
    expect(missing).toEqual({ errors: { title: ['Title can’t be empty'] } });
    expect(editFields(record('order', {}))).toEqual([]);
  });

  it('dates, expiry, stale lines and bulk labels', () => {
    expect(formatDay('2026-10-05')).toBe('05/10/2026');
    expect(parseDay('2026-10-05')).toBe('2026-10-05');
    expect(parseDay('5/10')).toBeNull();
    const now = Date.parse('2026-10-05T00:00:00Z');
    expect(isExpired({ status: 'proposed', expiresAt: PAST }, now)).toBe(true);
    expect(isExpired({ status: 'stale', expiresAt: FUTURE }, now)).toBe(false);
    expect(isExpired({ status: 'expired', expiresAt: FUTURE }, now)).toBe(true);
    expect(staleLines(['matter.status', 'document.d-1.version', 'document.d-2.version'])).toEqual([
      'Matter status',
      'A cited document’s version',
    ]);
    expect(bulkLabel('task', 3)).toBe('Accept all 3 tasks');
    expect(bulkLabel('key_fact', 2)).toBe('Accept all 2 key facts');
  });
});

describe('Clerk suggests… on the Overview', () => {
  it('lists open suggestions by kind, hiding expired ones until asked', async () => {
    const page = await open();
    expect(section(page)).not.toBeNull();
    expect(page.text(section(page)?.querySelector('h2'))).toBe('Clerk suggests…');
    // Grouped by kind, in the order of each kind's newest suggestion.
    expect(titles(page)).toEqual([
      'Will date: 2019-09-30',
      'Counsel’s advice on the claim',
      'Request the date-of-death valuation',
      'Write to the bank',
    ]);
    // The citation chip names the cited document (AI-05).
    expect(page.text(card(page, 's-task'))).toContain('Will of Fictional Whitfield.pdf p 2');

    const toggle = section(page)?.querySelector<HTMLElement>('mt-switch button, mt-switch [role="switch"]');
    toggle?.click();
    await page.stable(10);
    expect(titles(page)).toContain('An old idea');
    expect(page.text(card(page, 's-old'))).toContain('Expired');
    expect(page.buttons('Add note', card(page, 's-old') ?? undefined)).toHaveLength(0);
  });

  it('is hidden while the flag is off, and from roles that can’t use Clerk', async () => {
    const off = await open({ flags: {} });
    expect(section(off)).toBeNull();
    TestBed.resetTestingModule();
    cleanUpOverlays();
    const readonly = await open({ session: READONLY });
    expect(readonly.body.querySelector('mt-matter-suggestions')).toBeNull();
  });

  it('hides privileged suggestions from a paralegal', async () => {
    const page = await open({ session: PARALEGAL });
    expect(titles(page)).not.toContain('Counsel’s advice on the claim');
    expect(titles(page)).toContain('Write to the bank');
  });

  it('accepts a suggestion, which leaves the list', async () => {
    const page = await open();
    await page.click('Add task', card(page, 's-task') ?? undefined);
    await page.stable(10);
    expect(page.calls('suggestions-accept')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', suggestionId: 's-task' }),
    ]);
    expect(page.calls('suggestions-accept')[0]).not.toHaveProperty('editedPayload');
    expect(titles(page)).not.toContain('Request the date-of-death valuation');
  });

  it('edits before accepting, with field errors inline (the card’s and the server’s)', async () => {
    const page = await open({
      callables: {
        'suggestions-accept': () => {
          throw {
            code: 'functions/invalid-argument',
            details: { code: 'INVALID_ARGUMENT', reason: 'edited_payload', fields: { value: ['Not on this matter'] } },
          };
        },
      },
    });
    const fact = () => card(page, 's-fact') ?? undefined;
    await page.click('Edit', fact());
    await page.fill('Will date', 'yesterday', fact());
    await page.submit(fact() ?? null);
    expect(page.calls('suggestions-accept')).toHaveLength(0);
    expect(page.text(fact())).toContain('Enter a date as DD/MM/YYYY');

    await page.fill('Will date', '01/10/2019', fact());
    await page.submit(fact() ?? null);
    await page.stable(10);
    expect(page.calls('suggestions-accept')).toEqual([
      expect.objectContaining({ suggestionId: 's-fact', editedPayload: { field: 'willDate', value: '2019-10-01' } }),
    ]);
    expect(page.text(fact())).toContain('Not on this matter');
  });

  it('shows what changed when the sources moved on, then accepts against the current data', async () => {
    let first = true;
    const page = await open({
      callables: {
        'suggestions-accept': (data, fs) => {
          if (first) {
            first = false;
            throw {
              code: 'functions/failed-precondition',
              details: {
                code: 'SUGGESTION_STALE',
                suggestionId: data['suggestionId'],
                basis: 'b-2',
                changed: [{ key: 'matter.status', label: 'Matter status' }],
              },
            };
          }
          return suggestionCallables()['suggestions-accept']?.(data, fs);
        },
      },
    });
    const task = () => card(page, 's-task') ?? undefined;
    await page.click('Add task', task());
    await page.stable(10);
    expect(page.text(task())).toContain('Matter status');
    await page.click('Accept anyway', task());
    await page.stable(10);
    expect(page.calls('suggestions-accept').at(-1)).toMatchObject({ suggestionId: 's-task', expectedBasis: 'b-2' });
  });

  it('dismisses with a reason', async () => {
    const page = await open();
    const task = () => card(page, 's-task-2') ?? undefined;
    await page.click('Dismiss', task());
    await page.fill('Why dismiss it?', '4', task()); // "Other"
    await page.fill('Reason', 'The bank already wrote to us', task());
    await page.submit(task() ?? null);
    await page.stable(10);
    expect(page.calls('suggestions-dismiss')).toEqual([
      expect.objectContaining({ suggestionId: 's-task-2', reason: 'The bank already wrote to us' }),
    ]);
    expect(titles(page)).not.toContain('Write to the bank');
  });

  it('accepts all of one kind at once', async () => {
    const page = await open();
    await page.click('Accept all 2 tasks', section(page) ?? undefined);
    await page.stable(10);
    expect(page.calls('suggestions-acceptMany')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', suggestionIds: ['s-task', 's-task-2'] }),
    ]);
    expect(titles(page)).toEqual(['Will date: 2019-09-30', 'Counsel’s advice on the claim']);
  });

  describe('a letter Clerk suggested (AI-10b)', () => {
    const LETTER = {
      typeId: 'grant-notification',
      recipients: [
        { partyId: 'p-bram', name: 'Bram Ostler' },
        { name: 'Fictional Bank', address: '1 Fictional St' },
      ],
      instructions: 'Say the grant issued.',
    };
    const letters = (fs: InMemoryFirestore) => {
      fs.set(path('s-letter'), suggestionDoc('letter', LETTER));
      fs.set(
        path('s-letter-2'),
        suggestionDoc('letter', { typeId: 'client-update', recipients: [], instructions: '' }),
      );
      fs.set(
        path('s-letter-stale'),
        suggestionDoc(
          'letter',
          { typeId: 'letter', recipients: [], instructions: 'Ask for the meter reading.' },
          { status: 'stale', staleReview: { basis: 'b-3', changed: ['matter.status'], at: PAST } },
        ),
      );
    };

    it('opens the draft start page filled in instead of accepting, with no Edit and no bulk accept', async () => {
      const page = await open({ configure: letters });
      const letter = () => card(page, 's-letter') ?? undefined;
      expect(page.text(letter())).toContain(
        'Grant notification to beneficiaries: Bram Ostler and Fictional Bank · Say the grant issued.',
      );
      expect(page.buttons('Edit', letter())).toHaveLength(0);
      expect(page.buttons('Accept all', section(page) ?? undefined).map((button) => page.text(button))).toEqual([
        'Accept all 2 tasks',
      ]);
      await page.click('Draft letter', letter());
      await page.stable(10);
      expect(page.calls('suggestions-accept')).toEqual([]);
      const url = page.router.parseUrl(page.router.url);
      expect(page.router.url.split('?')[0]).toBe('/matters/m-whitfield/drafts/new');
      expect(url.queryParams).toEqual({
        type: 'grant-notification',
        instructions: 'Say the grant issued.',
        to: 'p-bram',
        toName: 'Fictional Bank',
        toAddress: '1 Fictional St',
        suggestion: 's-letter',
      });
    });

    it('shows what changed on a stale one, then opens it to accept against the current data', async () => {
      const page = await open({ configure: letters });
      const stale = () => card(page, 's-letter-stale') ?? undefined;
      await page.click('Review', stale());
      expect(page.text(stale())).toContain('Matter status');
      await page.click('Draft letter anyway', stale());
      await page.stable(10);
      expect(page.router.parseUrl(page.router.url).queryParams).toEqual({
        type: 'letter',
        instructions: 'Ask for the meter reading.',
        suggestion: 's-letter-stale',
        basis: 'b-3',
      });
    });
  });
});
