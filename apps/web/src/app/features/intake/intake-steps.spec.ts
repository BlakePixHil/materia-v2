import { cleanUpOverlays, openIntake, probateState, resumeAt, stateWith, warmUp } from './testing';

/** New matter intake (CORE-05): the type, clients and details steps. Fictional data only. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

describe('type step', () => {
  it('lists the eight types with descriptions and blocks Next until one is chosen', async () => {
    const page = await openIntake();
    expect(page.step()).toContain('Matter type');
    const cards = page.page()?.querySelectorAll('.mt-choice-card') ?? [];
    expect(cards).toHaveLength(8);
    expect(page.text()).toContain('Apply for a grant of probate of a will.');
    await page.click('Next');
    expect(page.step()).toContain('Matter type');
    expect(page.errors()).toContain('Choose a matter type');
    await page.choose('Probate');
    await page.click('Next');
    expect(page.step()).toContain('Clients');
  });
});

describe('clients step', () => {
  it('adds existing contacts as clients, several of them, and needs at least one', async () => {
    const page = await resumeAt(stateWith({ type: 'will', reached: 1 }, []), 'clients');
    await page.click('Next');
    expect(page.errors()).toContain('Add at least one client');
    await page.search('Find a client', 'ostler');
    await page.click('Bram Ostler');
    await page.search('Find a client', 'ostler');
    expect(page.buttons('Bram Ostler').length).toBe(0);
    await page.click('Celia Ostler');
    const names = [...(page.page()?.querySelectorAll('[aria-label="Clients"] .label') ?? [])].map((n) => n.textContent);
    expect(names).toEqual(['Bram Ostler', 'Celia Ostler']);
    expect(page.errors()).toEqual([]);
    await page.click('Remove Celia Ostler');
    await page.click('Next');
    expect(page.step()).toContain('Details');
  });
});

describe('details step', () => {
  it('shows inline errors for a probate without the deceased, domicile or will', async () => {
    const page = await resumeAt(stateWith({ type: 'probate', clientContactIds: ['c-avery'], reached: 2 }), 'details');
    await page.fill('Domicile', '');
    await page.click('Next');
    expect(page.step()).toContain('Details');
    expect(page.errors()).toEqual(
      expect.arrayContaining([
        'Choose the deceased',
        'Enter the date of death, or choose Unknown',
        'Enter the domicile',
        'Say whether there is a will',
      ]),
    );
  });

  it('picks the deceased (filling in the recorded date of death) and rejects a future date', async () => {
    const page = await resumeAt(stateWith({ type: 'probate', clientContactIds: ['c-avery'], reached: 2 }), 'details');
    await page.search('Find the deceased', 'whitfield');
    await page.click('Margaret Whitfield');
    expect(page.field('Date of death')?.value).toBe('22/07/2026');
    await page.fill('Date of death', '05/10/2026');
    await page.choose('Yes, there is a will');
    await page.click('Next');
    expect(page.errors()).toContain('The date of death cannot be in the future');
    await page.fill('Date of death', '1/1/1930');
    expect(page.errors()).toContain('The date of death cannot be before the date of birth');
  });

  it('accepts an unknown date of death', async () => {
    const state = probateState({ reached: 2 });
    state.details = { ...state.details, dateOfDeath: '' };
    const page = await resumeAt(state, 'details');
    await page.click('Next');
    expect(page.errors()).toContain('Enter the date of death, or choose Unknown');
    await page.choose('Unknown');
    expect((page.field('Date of death') as HTMLInputElement).disabled).toBe(true);
    await page.click('Next');
    expect(page.step()).toContain('Parties');
  });

  it('asks a family provision claim for who we act for and the other side (not a client)', async () => {
    const page = await resumeAt(stateWith({ type: 'fp', clientContactIds: ['c-avery'], reached: 2 }), 'details');
    await page.search('Find the deceased', 'whitfield');
    await page.click('Margaret Whitfield');
    await page.click('Next');
    expect(page.errors()).toEqual(
      expect.arrayContaining(['Choose who we act for', 'Add at least one party on the other side']),
    );
    await page.choose('Plaintiff');
    await page.search('Find someone on the other side', 'quill');
    await page.click('Avery Quill');
    expect(page.errors()).toContain('A client cannot be on the other side');
    await page.click('Remove Avery Quill');
    await page.search('Find someone on the other side', 'bram');
    await page.click('Bram Ostler');
    await page.click('Next');
    expect(page.step()).toContain('Parties');
    expect(page.text()).toMatch(/Bram Ostler\s*Defendant/);
  });

  it('asks a will for the testator', async () => {
    const page = await resumeAt(stateWith({ type: 'will', clientContactIds: ['c-avery'], reached: 2 }), 'details');
    await page.click('Next');
    expect(page.errors()).toContain('Choose the testator');
    await page.click('Use Avery Quill');
    await page.click('Next');
    expect(page.step()).toContain('Parties');
    expect(page.text()).toMatch(/Avery Quill\s*Testator/);
  });

  it('asks a testamentary trust for its name and trustees', async () => {
    const page = await resumeAt(stateWith({ type: 'trust', clientContactIds: ['c-avery'], reached: 2 }), 'details');
    await page.click('Next');
    expect(page.errors()).toEqual(expect.arrayContaining(['Enter the trust’s name', 'Add at least one trustee']));
    await page.fill('Trust name', 'Quill Family Trust');
    await page.click('Add Avery Quill as a trustee');
    await page.click('Next');
    expect(page.step()).toContain('Parties');
    expect(page.text()).toMatch(/Avery Quill\s*Trustee/);
  });
});

describe('creating a client inline', () => {
  it('runs the duplicate check and can use the existing contact instead', async () => {
    const page = await resumeAt(stateWith({ type: 'will', reached: 1 }, []), 'clients', {
      callables: {
        'contacts-findDuplicates': () => ({
          matches: [{ contactId: 'c-avery', displayName: 'Avery Quill', score: 0.95, reasons: ['name'] }],
        }),
      },
    });
    await page.click('New client…');
    await page.stable(50);
    await page.fill('Given names', 'Avery', page.dialog() ?? undefined);
    await page.fill('Family name', 'Quill', page.dialog() ?? undefined);
    await page.click('Create contact', page.dialog() ?? undefined);
    expect(page.calls('contacts-findDuplicates')).toHaveLength(1);
    expect(page.text(page.dialog())).toContain('This might be someone you already have.');
    await page.click('Use existing', page.dialog() ?? undefined);
    await page.stable(50);
    expect(page.calls('contacts-create')).toHaveLength(0);
    const names = [...(page.page()?.querySelectorAll('[aria-label="Clients"] .label') ?? [])].map((n) => n.textContent);
    expect(names).toEqual(['Avery Quill']);
  });
});
