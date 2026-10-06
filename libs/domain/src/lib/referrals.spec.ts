import {
  referralPatch,
  referralText,
  referralTotals,
  referrerIndustryFromText,
  referrerThankYouDue,
  referrerThankYouEnabled,
  referrerThankYouTitle,
  REFERRER_INDUSTRIES,
} from './referrals';
import { Contact, Matter } from './schemas/contacts-matters';
import { Org } from './schemas/tenancy';
import { dateOnly } from './values/date-only';

describe('referrer industries', () => {
  it.each([
    ['Accountant', 'accountant'],
    ['CPA firm', 'accountant'],
    ['Tax agent', 'accountant'],
    ['Financial Planner', 'financial_planner'],
    ['Financial adviser', 'financial_planner'],
    ['funeral director', 'funeral_director'],
    ['Funeral-Director', 'funeral_director'],
    ['Law firm', 'law_firm'],
    ['Solicitor', 'law_firm'],
    ['Aged care', 'aged_care'],
    ['Retirement village', 'aged_care'],
    ['Bank', 'bank'],
    ['Mortgage broker', 'bank'],
    ['Real estate', 'other'],
  ])('maps legacy text %s to %s', (text, industry) => {
    expect(referrerIndustryFromText(text)).toBe(industry);
  });

  it('leaves an empty industry unset', () => {
    expect(referrerIndustryFromText('')).toBeUndefined();
    expect(referrerIndustryFromText('  ')).toBeUndefined();
    expect(referrerIndustryFromText(null)).toBeUndefined();
  });

  it('keeps every enum value as itself', () => {
    for (const industry of REFERRER_INDUSTRIES) expect(referrerIndustryFromText(industry)).toBe(industry);
  });

  it('reads a free-text industry stored before the enum as other, and company alone', () => {
    const meta = Contact.schema.shape.referrerMeta;
    expect(meta.parse({ company: 'Fictional Partners', industry: 'Accounting firm' })).toEqual({
      company: 'Fictional Partners',
      industry: 'other',
    });
    expect(meta.parse({ industry: 'bank' })).toEqual({ industry: 'bank' });
    expect(meta.parse({ company: 'Fictional Partners' })).toEqual({ company: 'Fictional Partners' });
  });
});

describe('matter referral', () => {
  it('accepts the referral sources only', () => {
    const source = Matter.schema.shape.referralSource;
    expect(source.parse('existing_client')).toBe('existing_client');
    expect(source.safeParse('radio').success).toBe(false);
  });

  it('describes the referral', () => {
    expect(referralText({ referrerContactId: 'c-1' }, 'Lighthouse')).toBe('Lighthouse');
    expect(referralText({ referrerContactId: 'c-1' })).toBe('A referrer');
    expect(referralText({ referralSource: 'walk_in' })).toBe('Walk-in');
    expect(referralText({})).toBeNull();
  });

  it('sets one of referrer and source, clearing the other', () => {
    expect(referralPatch({ contactId: 'c-1' })).toEqual({
      set: { referrerContactId: 'c-1' },
      remove: ['referralSource'],
    });
    expect(referralPatch({ source: 'website' })).toEqual({
      set: { referralSource: 'website' },
      remove: ['referrerContactId'],
    });
    expect(referralPatch(null)).toEqual({ set: {}, remove: ['referrerContactId', 'referralSource'] });
  });

  it('lets clients edit the referral', () => {
    expect(Object.keys(Matter.update.shape)).toEqual(expect.arrayContaining(['referrerContactId', 'referralSource']));
  });
});

describe('referral totals', () => {
  it('counts live matters, the active ones and the latest referral', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      referralTotals([
        { status: 'open', createdAt: at('2026-03-01T00:00:00Z') },
        { status: 'closed', createdAt: at('2026-07-15T00:00:00Z') },
        { status: 'lead', createdAt: at('2026-05-01T00:00:00Z'), deletedAt: null },
        { status: 'open', createdAt: at('2026-09-01T00:00:00Z'), deletedAt: at('2026-09-02T00:00:00Z') },
      ]),
    ).toEqual({ count: 3, active: 2, lastReferredAt: at('2026-07-15T00:00:00Z'), billedCents: 0 });
    expect(referralTotals([])).toEqual({ count: 0, active: 0, lastReferredAt: null, billedCents: 0 });
  });

  it('adds up what has been billed on the live referred matters (BILL-07)', () => {
    expect(
      referralTotals([
        { status: 'closed', budget: { billedCents: 385000 } },
        { status: 'open', budget: { billedCents: 44000 } },
        // Nothing billed yet, and no budget at all.
        { status: 'open', budget: { billedCents: 0 } },
        { status: 'lead', budget: null },
        { status: 'open' },
        { status: 'closed', budget: { billedCents: 99900 }, deletedAt: new Date('2026-09-02T00:00:00Z') },
      ]).billedCents,
    ).toBe(429000);
  });
});

describe('thank-you task', () => {
  it('is off unless the org turns it on', () => {
    expect(referrerThankYouEnabled(undefined)).toBe(false);
    expect(referrerThankYouEnabled({ settings: {} })).toBe(false);
    expect(referrerThankYouEnabled({ settings: { referrals: { thankYouTask: true } } })).toBe(true);
    expect(Org.schema.shape.settings.parse({ referrals: { thankYouTask: true } })).toEqual({
      referrals: { thankYouTask: true },
    });
  });

  it('names the referrer and falls due a week after opening', () => {
    expect(referrerThankYouTitle('Lighthouse Financial Advisers')).toBe(
      'Thank Lighthouse Financial Advisers for the referral',
    );
    expect(referrerThankYouTitle('  ')).toBe('Thank referrer');
    expect(referrerThankYouDue(dateOnly('2026-10-05'))).toBe('2026-10-12');
  });
});
