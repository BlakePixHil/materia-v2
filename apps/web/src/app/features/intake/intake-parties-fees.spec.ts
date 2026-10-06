import { cleanUpOverlays, probateState, resumeAt, warmUp } from './testing';

/** New matter intake (CORE-05): the parties and fees steps. Fictional data only. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

describe('parties step', () => {
  it('lists who earlier steps added, prefills a grant’s clients as executors, and adds a beneficiary with a share', async () => {
    const state = probateState({ parties: [], partiesPrefilledFor: null, reached: 2 });
    const page = await resumeAt(state, 'details');
    await page.click('Next');
    expect(page.step()).toContain('Parties');
    const known = page.page()?.querySelector('[aria-label="Parties from earlier steps"]');
    expect(page.text(known)).toMatch(/Avery Quill\s*Client.*Margaret Whitfield\s*Deceased/);
    expect(page.page()?.querySelector('[data-party="executor|c-avery"]')).not.toBeNull();
    await page.search('Find a party to add', 'celia');
    await page.click('Celia Ostler');
    await page.fill('Share of Celia Ostler', 'One half');
    expect(page.page()?.querySelector('[data-party="beneficiary|c-celia"]')).not.toBeNull();
    await page.click('Next');
    expect(page.step()).toContain('Fees');
  });

  it('flags the same contact twice in one role', async () => {
    const page = await resumeAt(
      probateState({
        parties: [
          { contactId: 'c-bram', role: 'beneficiary', share: '' },
          { contactId: 'c-bram', role: 'beneficiary', share: '' },
        ],
        reached: 3,
      }),
      'parties',
    );
    await page.click('Next');
    expect(page.errors()).toContain('This contact is already in this role');
    await page.fill('Role of Bram Ostler', 'executor');
    await page.click('Next');
    expect(page.step()).toContain('Fees');
  });
});

describe('fees step', () => {
  const disclosure = (page: Awaited<ReturnType<typeof resumeAt>>) =>
    page.text(page.page()?.querySelector('[data-testid="costs-disclosure"]'));

  it('shows the costs disclosure the estimate needs under the illustrative VIC rules', async () => {
    const page = await resumeAt(probateState(), 'fees');
    expect(disclosure(page)).toContain('Illustrative');
    expect(disclosure(page)).toContain('Full disclosure required (estimate $4,500.00)');
    expect(disclosure(page)).toContain('not legal advice');
    await page.choose('Hourly');
    expect(disclosure(page)).toContain('Required: estimate needed');
    await page.fill('Estimate of total costs', '500');
    expect(disclosure(page)).toContain('Not required (estimate $500.00)');
    await page.fill('Estimate of total costs', '2,500');
    expect(disclosure(page)).toContain('Short-form disclosure required (estimate $2,500.00)');
    await page.choose('No disclosure is needed');
    expect(disclosure(page)).toContain('No disclosure needed');
    await page.click('Next');
    expect(page.errors()).toContain('Choose why no disclosure is needed');
  });

  it('needs the fixed fee, a cap at least the estimate, and amounts it can read', async () => {
    const page = await resumeAt(probateState(), 'fees');
    await page.fill('Fixed fee', '');
    await page.click('Next');
    expect(page.errors()).toContain('Enter the fixed fee');
    await page.fill('Fixed fee', 'about 2k');
    expect(page.errors()).toContain('Enter an amount like 1,500 or 1,500.50');
    await page.choose('Capped');
    await page.fill('Cap', '1,000');
    await page.fill('Estimate of total costs', '2,000');
    expect(page.errors()).toContain('The estimate cannot be more than the cap');
    await page.fill('Estimate of total costs', '900');
    await page.click('Next');
    expect(page.step()).toContain('Conflict check');
  });

  it('asks a conditional arrangement for its condition and an uplift of at most 25%', async () => {
    const page = await resumeAt(probateState(), 'fees');
    await page.choose('Conditional');
    await page.fill('Uplift', '30');
    await page.click('Next');
    expect(page.errors()).toEqual(expect.arrayContaining(['The uplift is at most 25%', 'Enter the condition']));
    await page.fill('Uplift', '20');
    await page.fill('Condition', 'The grant issues');
    await page.click('Next');
    expect(page.step()).toContain('Conflict check');
  });
});
