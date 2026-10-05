import { conflictSubjects, type IntakeState } from './intake-state';
import { cleanUpOverlays, DRAFTS, probateState, resumeAt, warmUp } from './testing';

/** New matter intake (CORE-05): review and create. Fictional data only. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

/** A probate intake ready to create: the check ran and was determined clear. */
function ready(): IntakeState {
  const state = probateState({ reached: 6 });
  return {
    ...state,
    conflict: {
      run: { checkId: 'chk-9', hits: [], adverseRolesChecked: true, subjects: conflictSubjects(state) },
      status: 'clear',
      reason: '',
    },
  };
}

describe('review and create', () => {
  it('suggests the title, defaults the responsible lawyer to me and sends the intake to matters-createMatter', async () => {
    const page = await resumeAt(ready(), 'review');
    expect(page.field('Title')?.value).toBe('Estate of Margaret Whitfield');
    const responsible = page.field('Responsible lawyer') as HTMLSelectElement;
    expect(responsible.selectedOptions[0]?.textContent?.trim()).toBe('Jordan Price');
    await page.choose('Priya Shah');
    await page.fill('Labels', 'grant, urgent');
    await page.click('Create matter');
    await page.stable(20);
    const [call] = page.calls('matters-createMatter');
    expect(call?.['requestId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call).toMatchObject({
      matter: {
        title: 'Estate of Margaret Whitfield',
        type: 'probate',
        jurisdiction: 'VIC',
        responsibleUid: 'user-jordan',
        teamUids: ['user-priya'],
        labels: ['grant', 'urgent'],
        clientContactIds: ['c-avery'],
        deceased: { contactId: 'c-margaret', dateOfDeath: '2026-07-22', domicile: 'VIC', lastAddress: '' },
        facts: { willDate: '2019-03-01' },
        estate: { grantType: 'probate' },
        conflictCheck: { status: 'clear' },
      },
      parties: [{ contactId: 'c-avery', role: 'executor' }],
      events: [],
      fee: { arrangement: 'fixed', amountCents: 450000 },
      costsDisclosure: { status: 'required', estimateCents: 450000 },
      conflictCheckId: 'chk-9',
    });
    expect(page.router.url).toBe('/matters/m-new/overview');
    expect(page.firestore.get(`${DRAFTS}/intake-d1`)).toBeUndefined();
  });

  it('sends the referral and shows it in the summary (CORE-18)', async () => {
    const page = await resumeAt({ ...ready(), referral: { referrerContactId: 'c-bram', source: null } }, 'review');
    const row = [...(page.page()?.querySelectorAll('.summary dt') ?? [])].find(
      (dt) => dt.textContent === 'Referred by',
    );
    expect(row?.nextElementSibling?.textContent).toBe('Bram Ostler');
    await page.click('Create matter');
    const [call] = page.calls('matters-createMatter');
    expect(call?.['matter']).toMatchObject({ referrerContactId: 'c-bram' });
    expect((call?.['matter'] as Record<string, unknown>)['referralSource']).toBeUndefined();
  });

  it('sends an unknown date of death as no date', async () => {
    const state = ready();
    state.details = { ...state.details, dateOfDeath: '', dateOfDeathUnknown: true };
    const page = await resumeAt(state, 'review');
    expect(page.text()).toContain('date of death unknown');
    await page.click('Create matter');
    const [call] = page.calls('matters-createMatter');
    expect((call?.['matter'] as { deceased: object }).deceased).toEqual({
      contactId: 'c-margaret',
      domicile: 'VIC',
      lastAddress: '',
    });
  });

  it('shows the failure and retries with the same request id', async () => {
    let attempts = 0;
    const page = await resumeAt(ready(), 'review', {
      callables: {
        'matters-createMatter': () => {
          if (++attempts === 1) throw { code: 'functions/internal', message: 'boom' };
          return { matterId: 'm-new', number: 'M-2026-0300', status: 'open' };
        },
      },
    });
    await page.click('Create matter');
    expect(page.page()?.querySelector('[data-testid="create-error"]')).not.toBeNull();
    expect(page.router.url).toBe('/matters/new');
    expect(page.firestore.get(`${DRAFTS}/intake-d1`)).toBeDefined();
    await page.click('Try again');
    await page.stable(20);
    const [first, second] = page.calls('matters-createMatter');
    expect(second?.['requestId']).toBe(first?.['requestId']);
    expect(page.router.url).toBe('/matters/m-new/overview');
  });

  it('takes you back to the first invalid step instead of creating', async () => {
    const state = ready();
    state.fees = { ...state.fees, amount: '' };
    const page = await resumeAt(state, 'review');
    await page.click('Create matter');
    expect(page.calls('matters-createMatter')).toHaveLength(0);
    expect(page.step()).toContain('Fees');
    expect(page.errors()).toContain('Enter the fixed fee');
  });

  it('reopens a completed step from the step list or the summary', async () => {
    const page = await resumeAt(ready(), 'review');
    const steps = page.page()?.querySelector('mt-step-list');
    expect(page.buttons('Clients', steps ?? undefined)).toHaveLength(1);
    await page.click('Clients', steps ?? undefined);
    expect(page.step()).toContain('Clients');
    expect(page.buttons('Review and create', steps ?? undefined)).toHaveLength(1);
    await page.click('Review and create', steps ?? undefined);
    await page.click('Change fees');
    expect(page.step()).toContain('Fees');
  });
});
