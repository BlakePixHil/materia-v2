import type { InMemoryFirestore } from '@materia/data-access/repository';
import { DomainError, partyDocId } from '@materia/domain';

import {
  draftEdited,
  draftErrorCopy,
  draftSegments,
  draftStatusLabel,
  recipientOptions,
  rewriteContext,
  toConfirmText,
} from './clerk-draft-view';
import {
  cleanUpOverlays,
  contactDoc,
  MATTER,
  ME,
  meta,
  openMatter,
  ORG,
  partyDoc,
  type FakeCallable,
  type OpenOptions,
} from '../matter-detail/testing';

/** Clerk drafting (AI-10): starting a letter and its editor, against fake `clerk-*Draft` callables. Fictional data only. */

afterEach(cleanUpOverlays);

const FLAGS = { 'clerk.enabled': true, 'clerk.features.drafting': true };
const DRAFTS = `${MATTER}/clerkDrafts`;
type Seed = Record<string, unknown>;

const LETTER = [
  'Dear Bram',
  'The Supreme Court granted probate on [[TO CONFIRM: date of the grant]] to Avery Quill.',
  'Yours faithfully',
].join('\n\n');

function draftDoc(data: Seed = {}): Seed {
  return {
    typeId: 'grant-notification',
    title: 'Grant notification to beneficiaries: Bram Ostler',
    ownerUid: ME,
    recipients: [
      { partyId: partyDocId('beneficiary', 'c-bram'), name: 'Bram Ostler', role: 'beneficiary', address: null },
    ],
    instructions: '',
    includePrivileged: false,
    status: 'ready',
    stopRequested: false,
    bodyMd: LETTER,
    generatedMd: LETTER,
    provenance: [{ origin: 'clerk', length: LETTER.length }],
    citations: [],
    missingFacts: ['date of the grant'],
    privileged: false,
    rewrites: 0,
    truncated: false,
    runId: 'r-1',
    documentIds: [],
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** The `clerk-*Draft` callables as the server answers at once (the draft's text is written later by the test). */
function draftCallables(): Record<string, FakeCallable> {
  let n = 0;
  return {
    'clerk-startDraft': (data, fs) => {
      const draftId = `cd-${++n}`;
      fs.set(
        `${DRAFTS}/${draftId}`,
        draftDoc({
          typeId: data['typeId'],
          status: 'drafting',
          bodyMd: '',
          generatedMd: '',
          provenance: [],
          missingFacts: [],
          instructions: data['instructions'] ?? '',
        }),
      );
      return { draftId };
    },
    'clerk-redraft': (data, fs) => {
      const path = `${DRAFTS}/${String(data['draftId'])}`;
      fs.set(path, { ...fs.get(path), status: 'drafting', bodyMd: '', provenance: [], runId: `r-${++n}` });
      return { draftId: data['draftId'] };
    },
    'clerk-rewriteDraft': () => ({ text: 'The Supreme Court of Victoria has granted probate', privileged: false }),
    'clerk-saveDraft': (data, fs) => {
      const path = `${DRAFTS}/${String(data['draftId'])}`;
      fs.set(path, { ...fs.get(path), status: 'saved', documentIds: ['doc-letter'] });
      return { documentId: 'doc-letter', name: 'Grant notification', missing: [], toConfirm: 1 };
    },
  };
}

async function open(url: string, options: OpenOptions = {}) {
  const page = await openMatter(url, {
    flags: FLAGS,
    ...options,
    callables: { ...draftCallables(), ...options.callables },
    configure: (fs: InMemoryFirestore, port) => {
      fs.set(`orgs/${ORG}/contacts/c-bram`, contactDoc('Bram', 'Ostler', { dateOfBirth: '1971-02-03' }));
      fs.set(...partyDoc('beneficiary', 'c-bram'));
      options.configure?.(fs, port);
    },
  });
  await page.stable(10);
  const field = () => page.body.querySelector<HTMLTextAreaElement>('mt-clerk-draft-page textarea');
  /** The server writing the draft. */
  const write = async (id: string, data: Seed) => {
    page.firestore.set(`${DRAFTS}/${id}`, { ...page.firestore.get(`${DRAFTS}/${id}`), ...data });
    await page.stable(10);
  };
  /** Typing into the letter. */
  const type = async (value: string) => {
    const input = field();
    if (!input) throw new Error('No letter');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await page.stable();
  };
  /** Waits for a lazily loaded confirm dialog. */
  const confirm = async () => {
    for (let i = 0; i < 30 && !page.dialog(); i++) await page.stable(10);
    return page.dialog() as HTMLElement;
  };
  return { ...page, field, write, type, confirm };
}

describe('clerk draft view', () => {
  it('cuts the letter at its placeholders for the highlight layer', () => {
    expect(draftSegments('Granted on [[TO CONFIRM: date]].')).toEqual([
      { text: 'Granted on ', placeholder: false },
      { text: '[[TO CONFIRM: date]]', placeholder: true },
      { text: '. ', placeholder: false },
    ]);
    expect(draftSegments('')).toEqual([{ text: ' ', placeholder: false }]);
    expect(toConfirmText(1)).toBe('1 thing to confirm');
    expect(toConfirmText(3)).toBe('3 things to confirm');
  });

  it('says where the draft stands, and why Clerk couldn’t write it', () => {
    expect(draftStatusLabel({ status: 'drafting' })).toBe('Clerk is drafting…');
    expect(draftStatusLabel({ status: 'ready' })).toBe('Draft — not sent');
    expect(draftStatusLabel({ status: 'saved' })).toContain('Saved to documents');
    expect(draftErrorCopy(undefined)).toBeNull();
    expect(draftErrorCopy({ code: 'CLERK_REFUSED' })).toContain('declined');
    expect(draftErrorCopy({ code: 'CLERK_BUDGET_EXCEEDED' })).toContain('allowance');
  });

  it('knows when a redraft would lose edits', () => {
    const draft = { generatedMd: 'Dear Bram', provenance: [{ origin: 'clerk' as const, length: 9 }] };
    expect(draftEdited(draft, 'Dear Bram')).toBe(false);
    expect(draftEdited(draft, 'Dear Mr Ostler')).toBe(true);
    expect(draftEdited({ ...draft, provenance: [{ origin: 'person', length: 9 }] }, 'Dear Bram')).toBe(true);
    expect(rewriteContext('abcdef', 2, 4)).toEqual({ before: 'ab', after: 'ef' });
  });

  it('offers the matter’s parties, the letter’s own roles first and never the deceased', () => {
    const parties = [
      { id: 'p1', contactId: 'c1', role: 'client' as const },
      { id: 'p2', contactId: 'c2', role: 'beneficiary' as const },
      { id: 'p3', contactId: 'c3', role: 'deceased' as const },
      { id: 'p4', contactId: 'c4', role: 'beneficiary' as const, deletedAt: new Date() },
    ];
    const names: Record<string, string> = { c1: 'Avery Quill', c2: 'Bram Ostler', c3: 'Margaret Whitfield' };
    const options = recipientOptions(parties, (id) => names[id], { recipientRoles: ['beneficiary'] });
    expect(options.map((option) => [option.name, option.suggested])).toEqual([
      ['Bram Ostler', true],
      ['Avery Quill', false],
    ]);
  });
});

describe('Clerk drafting', () => {
  it('starts a letter from the matter menu, with recipients from the parties and the instructions', async () => {
    const page = await open('/matters/m-whitfield/overview');
    await page.click('More matter actions');
    await page.click('Draft a letter with Clerk…', page.body.querySelector('[role="menu"]') ?? page.body);
    await page.stable(10);
    expect(page.router.url).toBe('/matters/m-whitfield/drafts/new');
    const form = page.body.querySelector<HTMLElement>('mt-clerk-draft-start-page form');
    expect(page.text(form)).toContain('Grant notification to beneficiaries');
    // Probate letters only: no letter of demand on an estate.
    expect(page.text(form)).not.toContain('Letter of demand');

    const pick = async (label: string) => {
      const option = [...(form?.querySelectorAll<HTMLElement>('mt-radio-group label') ?? [])].find((node) =>
        page.text(node).startsWith(label),
      );
      option?.querySelector<HTMLElement>('button')?.click();
      await page.stable();
    };
    await pick('Grant notification to beneficiaries');
    // The beneficiary is suggested first; the deceased isn't offered.
    const people = [...(form?.querySelectorAll('fieldset mt-checkbox') ?? [])].map((node) => page.text(node));
    expect(people[0]).toContain('Bram Ostler');
    expect(people.join(' ')).not.toContain('Margaret');
    form?.querySelector<HTMLElement>('fieldset mt-checkbox button')?.click();
    await page.stable();
    await page.fill('Instructions (optional)', 'Mention the second instalment.');
    await page.submit(page.body.querySelector('mt-clerk-draft-start-page'));
    await page.stable(10);

    expect(page.calls('clerk-startDraft')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        typeId: 'grant-notification',
        recipients: [{ partyId: partyDocId('beneficiary', 'c-bram') }],
        instructions: 'Mention the second instalment.',
        includePrivileged: false,
      }),
    ]);
    expect(page.router.url).toBe('/matters/m-whitfield/drafts/cd-1');
    expect(page.text(page.body.querySelector('mt-clerk-draft-page'))).toContain('Clerk is drafting…');
  });

  it('takes ⌘J /draft’s instructions, and asks for them when the letter needs them', async () => {
    const page = await open('/matters/m-whitfield/drafts/new?type=letter&instructions=Ask%20for%20the%20valuation');
    const form = page.body.querySelector<HTMLElement>('mt-clerk-draft-start-page form');
    expect(form?.querySelector<HTMLTextAreaElement>('textarea[name="instructions"], mt-textarea textarea')?.value).toBe(
      'Ask for the valuation',
    );
    await page.fill('What the letter says', '');
    await page.submit(page.body.querySelector('mt-clerk-draft-start-page'));
    expect(page.text(form)).toContain('Say what the letter is about.');
    expect(page.calls('clerk-startDraft')).toEqual([]);
  });

  it('starts a letter Clerk suggested, filled in, and accepts the suggestion with it (AI-10b)', async () => {
    const bram = partyDocId('beneficiary', 'c-bram');
    let first = true;
    const page = await open(
      `/matters/m-whitfield/drafts/new?type=grant-notification&instructions=Say%20the%20grant%20issued.&to=${bram},p-gone&suggestion=s-letter`,
      {
        callables: {
          'clerk-startDraft': (data, fs) => {
            if (first) {
              first = false;
              throw {
                code: 'functions/failed-precondition',
                details: { code: 'SUGGESTION_STALE', basis: 'b-2', changed: [{ key: 'matter.status' }] },
              };
            }
            return draftCallables()['clerk-startDraft']?.(data, fs);
          },
        },
      },
    );
    const start = () => page.body.querySelector<HTMLElement>('mt-clerk-draft-start-page');
    expect(page.text(start())).toContain('Clerk suggested this letter.');
    // Bram is chosen; a party no longer on the matter isn't offered.
    const people = [...(start()?.querySelectorAll('fieldset mt-checkbox') ?? [])];
    expect(page.text(people[0])).toContain('Bram Ostler');
    expect(people[0]?.querySelector('[aria-checked]')?.getAttribute('aria-checked')).toBe('true');

    // Its sources changed since: say what, and accept it against the current data next time.
    await page.submit(start());
    await page.stable(10);
    expect(page.text(start())).toContain('Since Clerk suggested this letter, these changed: matter status.');
    expect(page.router.url).toContain('/drafts/new');
    await page.submit(start());
    await page.stable(10);

    const sent = page.calls('clerk-startDraft');
    expect(sent).toEqual([
      expect.objectContaining({
        typeId: 'grant-notification',
        recipients: [{ partyId: bram }],
        instructions: 'Say the grant issued.',
        suggestionId: 's-letter',
      }),
      expect.objectContaining({ suggestionId: 's-letter', expectedBasis: 'b-2' }),
    ]);
    expect(sent[0]).not.toHaveProperty('expectedBasis');
    expect(page.router.url).toBe('/matters/m-whitfield/drafts/cd-1');
  });

  it('says why Clerk can’t draft and points to the manual way', async () => {
    const page = await open('/matters/m-whitfield/drafts/new', {
      callables: {
        'clerk-startDraft': () => {
          throw new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk budget used', { period: 'clerk-2026-10' });
        },
      },
    });
    await page.submit(page.body.querySelector('mt-clerk-draft-start-page'));
    await page.stable(10);
    const text = page.text(page.body.querySelector('mt-clerk-draft-start-page'));
    expect(text).toContain('used this month’s Clerk allowance');
    expect(text).toContain('Documents, Deadlines and Tasks tabs');
  });

  it('hides drafting while it’s off, and from roles that can’t use Clerk', async () => {
    const off = await open('/matters/m-whitfield/drafts/new', { flags: { 'clerk.enabled': true } });
    expect(off.text(off.body.querySelector('mt-clerk-draft-start-page'))).toContain('isn’t turned on');
    expect(off.body.querySelector('mt-clerk-draft-start-page form')).toBeNull();
    await off.click('More matter actions');
    expect(off.buttons('Draft a letter with Clerk…')).toHaveLength(0);
  });

  it('streams Clerk’s letter in, then highlights and lists what to confirm', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) => fs.set(`${DRAFTS}/cd-1`, draftDoc({ status: 'drafting', bodyMd: '', provenance: [] })),
    });
    expect(page.field()?.readOnly).toBe(true);
    expect(page.buttons('Stop')).toHaveLength(1);
    expect(page.buttons('Save to documents')).toHaveLength(0);

    await page.write('cd-1', { bodyMd: 'Dear Bram' });
    expect(page.field()?.value).toBe('Dear Bram');

    await page.write('cd-1', {
      status: 'ready',
      bodyMd: LETTER,
      provenance: [{ origin: 'clerk', length: LETTER.length }],
    });
    const draft = page.body.querySelector<HTMLElement>('mt-clerk-draft-page');
    expect(page.field()?.readOnly).toBe(false);
    expect(page.field()?.value).toBe(LETTER);
    expect(page.text(draft?.querySelector('[role="status"]'))).toContain('Draft — not sent');
    expect([...(draft?.querySelectorAll('.layer mark') ?? [])].map((mark) => mark.textContent)).toEqual([
      '[[TO CONFIRM: date of the grant]]',
    ]);
    expect(page.text(draft?.querySelector('aside'))).toContain('1 thing to confirm');
    expect(page.text(draft?.querySelector('aside'))).toContain('Not on the matter');
    expect(page.text(draft)).toContain('Clerk wrote 100% of this letter');
    expect(page.text(draft)).toContain('never printed');

    // A placeholder in the list selects it in the letter, ready to fill in.
    await page.click('date of the grant', draft?.querySelector('aside') ?? undefined);
    const start = LETTER.indexOf('[[TO CONFIRM');
    expect([page.field()?.selectionStart, page.field()?.selectionEnd]).toEqual([
      start,
      start + '[[TO CONFIRM: date of the grant]]'.length,
    ]);
  });

  it('stops Clerk by setting stopRequested', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) => fs.set(`${DRAFTS}/cd-1`, draftDoc({ status: 'drafting', bodyMd: 'Dear' })),
    });
    await page.click('Stop');
    expect(page.firestore.get(`${DRAFTS}/cd-1`)?.['stopRequested']).toBe(true);
  });

  it('saves edits as the person’s, and asks before a redraft throws them away', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) => fs.set(`${DRAFTS}/cd-1`, draftDoc()),
    });
    await page.type(LETTER.replace('Dear Bram', 'Dear Mr Ostler'));
    await page.stable(900);
    const saved = page.firestore.get(`${DRAFTS}/cd-1`);
    expect(saved?.['bodyMd']).toContain('Dear Mr Ostler');
    expect(saved?.['provenance']).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'person' })]));
    expect(page.text(page.body.querySelector('mt-clerk-draft-page'))).toMatch(/you wrote [1-9]\d?%/);

    await page.click('Redraft');
    const dialog = await page.confirm();
    expect(page.text(dialog)).toContain('Your edits to this draft will be lost.');
    await page.click('Cancel', dialog);
    expect(page.calls('clerk-redraft')).toEqual([]);

    await page.click('Redraft');
    await page.click('Redraft', await page.confirm());
    await page.stable(10);
    expect(page.calls('clerk-redraft')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', draftId: 'cd-1' }),
    ]);
    expect(page.buttons('Stop')).toHaveLength(1);
  });

  it('rewrites a selected passage as Clerk’s', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) => fs.set(`${DRAFTS}/cd-1`, draftDoc()),
    });
    const field = page.field() as HTMLTextAreaElement;
    const start = LETTER.indexOf('The Supreme Court granted probate');
    const end = start + 'The Supreme Court granted probate'.length;
    field.setSelectionRange(start, end);
    field.dispatchEvent(new Event('select'));
    await page.stable();
    await page.fill('Rewrite the selected text', 'Name the court in full');
    await page.click('Rewrite', page.body.querySelector('form.rewrite') ?? undefined);
    await page.stable(10);
    expect(page.calls('clerk-rewriteDraft')).toEqual([
      expect.objectContaining({
        draftId: 'cd-1',
        selection: 'The Supreme Court granted probate',
        before: LETTER.slice(0, start),
        instruction: 'Name the court in full',
      }),
    ]);
    expect(page.field()?.value).toContain('The Supreme Court of Victoria has granted probate on [[TO CONFIRM');
  });

  it('saves to the documents on the letterhead after confirming what’s still to check, and never sends', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) => fs.set(`${DRAFTS}/cd-1`, draftDoc()),
    });
    expect(page.buttons('Send')).toHaveLength(0);
    await page.click('Save to documents');
    const dialog = await page.confirm();
    expect(page.text(dialog)).toContain('Save with 1 thing to confirm?');
    await page.click('Save anyway', dialog);
    await page.stable(10);
    expect(page.calls('clerk-saveDraft')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        draftId: 'cd-1',
        bodyMd: LETTER,
        provenance: [{ origin: 'clerk', length: LETTER.length }],
        confirmPrivileged: false,
      }),
    ]);
    expect(page.router.url).toBe('/matters/m-whitfield/documents/doc-letter');
  });

  it('asks before filing a third-party letter that drew on privileged material', async () => {
    const body = 'Dear Sir or Madam\n\nPlease send the balance.';
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) =>
        fs.set(
          `${DRAFTS}/cd-1`,
          draftDoc({
            typeId: 'bank-balance-request',
            privileged: true,
            bodyMd: body,
            generatedMd: body,
            provenance: [{ origin: 'clerk', length: body.length }],
          }),
        ),
    });
    await page.click('Save to documents');
    const dialog = await page.confirm();
    expect(page.text(dialog)).toContain('This letter may carry privileged material');
    await page.click('Save as privileged', dialog);
    await page.stable(10);
    expect(page.calls('clerk-saveDraft')).toEqual([expect.objectContaining({ confirmPrivileged: true })]);
  });

  it('says plainly when Clerk declined to draft', async () => {
    const page = await open('/matters/m-whitfield/drafts/cd-1', {
      configure: (fs) =>
        fs.set(`${DRAFTS}/cd-1`, draftDoc({ status: 'error', bodyMd: '', error: { code: 'CLERK_REFUSED' } })),
    });
    expect(page.text(page.body.querySelector('mt-clerk-draft-page'))).toContain('Clerk declined to draft this letter.');
    expect(page.buttons('Redraft')).toHaveLength(1);
  });
});
