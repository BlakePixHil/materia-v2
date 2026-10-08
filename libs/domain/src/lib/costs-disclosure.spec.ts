import {
  assessDisclosure,
  costsDisclosureRules,
  DEFAULT_DISCLOSURE_CHANGE_PCT,
  disclosureBasisCents,
  disclosureChangePct,
  DisclosureChangePctSchema,
  disclosureFormName,
  disclosureNeed,
  disclosureNeedText,
  disclosureOutstanding,
  disclosureReminderDue,
  DisclosureRulesSchema,
  disclosureTaskId,
  DisclosureWaiverInput,
  initialCostsDisclosure,
  reviseDisclosure,
  sentStatus,
  significantDisclosureChange,
  withDisclosureEvent,
  DISCLOSURE_HISTORY_MAX,
} from './costs-disclosure';
import type { CostsDisclosure, DisclosureEvent } from './schemas/contacts-matters';
import type { DateOnly } from './values/date-only';

/** BILL-06: costs disclosure rules, assessment, revision and reminders. Everyone here is fictional. */

const today = '2026-10-06' as DateOnly;
const now = new Date('2026-10-06T00:00:00Z');
const vic = (cents: number | undefined) => assessDisclosure({ jurisdiction: 'VIC', estimateHighCents: cents });

describe('the VIC v1 rules', () => {
  it('parse, are versioned and are signed off (BILL-06a), so not illustrative', () => {
    const rules = costsDisclosureRules().jurisdictions['VIC'];
    expect(rules).toMatchObject({ version: 'vic-v1', illustrative: false });
    expect(rules?.bands.map((band) => band.id)).toEqual(['below-lower-threshold', 'standard-form', 'full']);
  });

  it('put each estimate in its band: $750 none, $750.01 to $3,000 short form, above that full', () => {
    expect(vic(0).requirement).toBe('none');
    expect(vic(75_000).requirement).toBe('none');
    expect(vic(75_001).requirement).toBe('short_form');
    expect(vic(300_000).requirement).toBe('short_form');
    expect(vic(300_001).requirement).toBe('full');
    expect(vic(5_000_000)).toMatchObject({
      rulesConfigured: true,
      rulesVersion: 'vic-v1',
      illustrative: false,
      requirement: 'full',
      formTemplateId: 'system-costs-disclosure',
    });
    expect(vic(200_000)).toMatchObject({
      band: { id: 'standard-form' },
      formTemplateId: 'system-costs-disclosure-short',
    });
    expect(vic(200_000).citation).toContain('r 72A');
    // A disclosure given below the lower threshold uses the first form the rules have.
    expect(vic(50_000).formTemplateId).toBe('system-costs-disclosure-short');
  });

  it('never assumes a requirement without an estimate or without rules for the jurisdiction', () => {
    expect(vic(undefined)).toMatchObject({ rulesConfigured: true, estimateNeeded: true });
    expect(vic(undefined).requirement).toBeUndefined();
    const nsw = assessDisclosure({ jurisdiction: 'NSW', estimateHighCents: 50_000 });
    expect(nsw).toMatchObject({
      rulesConfigured: false,
      illustrative: false,
      formTemplateId: 'system-costs-disclosure',
    });
    expect(nsw.requirement).toBeUndefined();
    expect(disclosureNeed(nsw, { arrangement: 'hourly' })).toEqual({ status: 'required' });
  });

  it('refuse bands out of order or a last band with a limit', () => {
    const band = (id: string, maxCents?: number) => ({
      id,
      requirement: 'full' as const,
      formTemplateId: 'system-costs-disclosure',
      citation: 'A fictional rule',
      ...(maxCents ? { maxCents } : {}),
    });
    const rules = (bands: unknown[]) =>
      DisclosureRulesSchema.safeParse({ version: 'x-v1', name: 'X', illustrative: false, bands });
    expect(rules([band('a', 100), band('b')]).success).toBe(true);
    expect(rules([band('a', 200), band('b', 100), band('c')]).success).toBe(false);
    expect(rules([band('a', 100), band('b', 200)]).success).toBe(false);
    expect(rules([{ id: 'a', requirement: 'full', citation: 'A fictional rule' }]).success).toBe(false);
  });
});

describe('the estimate a disclosure is judged on', () => {
  it('is the top of the range, else the single estimate, the fixed fee or the cap; zero for pro bono', () => {
    expect(
      disclosureBasisCents({ arrangement: 'hourly', estimateCents: 5 as never, estimateHighCents: 9 as never }),
    ).toBe(9);
    expect(disclosureBasisCents({ arrangement: 'hourly', estimateCents: 5 as never })).toBe(5);
    expect(disclosureBasisCents({ arrangement: 'hourly' })).toBeUndefined();
    expect(disclosureBasisCents({ arrangement: 'fixed', amountCents: 7 as never })).toBe(7);
    expect(disclosureBasisCents({ arrangement: 'capped', capCents: 11 as never })).toBe(11);
    expect(disclosureBasisCents({ arrangement: 'conditional' })).toBeUndefined();
    expect(disclosureBasisCents({ arrangement: 'pro_bono', estimateCents: 900 as never })).toBe(0);
    expect(disclosureBasisCents(undefined)).toBeUndefined();
  });

  it('says what is needed in one line', () => {
    const text = (fee: Parameters<typeof disclosureBasisCents>[0], jurisdiction = 'VIC') => {
      const basis = disclosureBasisCents(fee);
      const assessment = assessDisclosure({ jurisdiction, estimateHighCents: basis });
      const need = disclosureNeed(assessment, fee);
      return disclosureNeedText({
        ...need,
        requirement: assessment.requirement,
        rulesVersion: assessment.rulesVersion,
        basisEstimateCents: basis,
        jurisdiction,
      });
    };
    expect(text({ arrangement: 'hourly', estimateCents: 450_000 as never })).toBe(
      'Full disclosure required (estimate $4,500.00)',
    );
    expect(text({ arrangement: 'fixed', amountCents: 150_000 as never })).toBe(
      'Short-form disclosure required (estimate $1,500.00)',
    );
    expect(text({ arrangement: 'fixed', amountCents: 50_000 as never })).toBe('Not required (estimate $500.00)');
    expect(text({ arrangement: 'hourly' })).toBe('Required: estimate needed');
    expect(text({ arrangement: 'pro_bono' })).toBe('Not required: pro bono');
    expect(text({ arrangement: 'hourly', estimateCents: 450_000 as never }, 'NSW')).toBe(
      'Rules not configured for NSW (estimate $4,500.00)',
    );
    expect(disclosureFormName('short_form')).toBe('Short form (uniform standard disclosure form)');
    expect(disclosureFormName(undefined)).toBe('Full disclosure');
  });
});

describe('a new matter’s disclosure', () => {
  const base = { jurisdiction: 'VIC', uid: 'user-jordan', now, today };

  it('is required from today when the estimate needs one, with the assessment and a history line', () => {
    expect(
      initialCostsDisclosure({ ...base, fee: { arrangement: 'hourly', estimateCents: 450_000 as never } }),
    ).toEqual({
      status: 'required',
      requirement: 'full',
      bandId: 'full',
      rulesVersion: 'vic-v1',
      basisEstimateCents: 450_000,
      requiredSince: today,
      history: [
        {
          at: now,
          by: 'user-jordan',
          action: 'assessed',
          status: 'required',
          requirement: 'full',
          estimateCents: 450_000,
        },
      ],
    });
  });

  it('is not required below the lower threshold or pro bono, unless intake asks for one anyway', () => {
    expect(
      initialCostsDisclosure({ ...base, fee: { arrangement: 'fixed', amountCents: 50_000 as never } }),
    ).toMatchObject({
      status: 'not_required',
      notRequiredReason: 'below_threshold',
    });
    expect(initialCostsDisclosure({ ...base, fee: { arrangement: 'pro_bono' } })).toMatchObject({
      status: 'not_required',
      notRequiredReason: 'pro_bono',
    });
    const asked = initialCostsDisclosure({
      ...base,
      fee: { arrangement: 'fixed', amountCents: 50_000 as never },
      requested: 'required',
    });
    expect(asked).toMatchObject({ status: 'required', requiredSince: today });
    expect(asked.notRequiredReason).toBeUndefined();
  });

  it('is waived only with a reason, kept with who and when', () => {
    const waived = initialCostsDisclosure({
      ...base,
      fee: { arrangement: 'hourly', estimateCents: 450_000 as never },
      requested: 'waived',
      waiver: { reason: 'sophisticated_client' },
    });
    expect(waived).toMatchObject({
      status: 'waived',
      waiver: { reason: 'sophisticated_client', by: 'user-jordan', at: now },
      history: [{ action: 'waived', status: 'waived' }],
    });
    expect(waived.requiredSince).toBeUndefined();
    expect(
      initialCostsDisclosure({
        ...base,
        fee: { arrangement: 'hourly', estimateCents: 450_000 as never },
        requested: 'waived',
      }).status,
    ).toBe('required');
    expect(DisclosureWaiverInput.safeParse({ reason: 'other' }).success).toBe(false);
    expect(
      DisclosureWaiverInput.safeParse({ reason: 'other', note: 'Repeat client, terms agreed in writing' }).success,
    ).toBe(true);
  });
});

describe('a fee revision', () => {
  const revise = (current: CostsDisclosure, estimateCents: number | undefined, pct = DEFAULT_DISCLOSURE_CHANGE_PCT) =>
    reviseDisclosure({
      current,
      jurisdiction: 'VIC',
      fee: { arrangement: 'hourly', ...(estimateCents !== undefined ? { estimateCents: estimateCents as never } : {}) },
      pct,
      uid: 'user-jordan',
      now,
      today,
    });
  const sent: CostsDisclosure = {
    status: 'sent',
    requirement: 'full',
    bandId: 'full',
    rulesVersion: 'vic-v1',
    basisEstimateCents: 450_000 as never,
    sentOn: '2026-09-01' as DateOnly,
    sentMethod: 'email',
    sentEstimateCents: 450_000 as never,
    sentBandId: 'full',
    history: [],
  };

  it('compares with what was disclosed: a band move, a rise past the percentage, or a first estimate', () => {
    expect(
      significantDisclosureChange({
        disclosed: { estimateCents: 100, bandId: 'a' },
        next: { estimateCents: 110, bandId: 'a' },
        pct: 10,
      }),
    ).toEqual([]);
    expect(
      significantDisclosureChange({
        disclosed: { estimateCents: 100, bandId: 'a' },
        next: { estimateCents: 111, bandId: 'a' },
        pct: 10,
      }),
    ).toEqual(['increase']);
    expect(
      significantDisclosureChange({
        disclosed: { estimateCents: 100, bandId: 'a' },
        next: { estimateCents: 90, bandId: 'b' },
        pct: 10,
      }),
    ).toEqual(['band']);
    expect(
      significantDisclosureChange({ disclosed: { bandId: 'a' }, next: { estimateCents: 90, bandId: 'a' }, pct: 10 }),
    ).toEqual(['estimate']);
    // A fall within the band is never significant.
    expect(
      significantDisclosureChange({
        disclosed: { estimateCents: 100, bandId: 'a' },
        next: { estimateCents: 10, bandId: 'a' },
        pct: 10,
      }),
    ).toEqual([]);
  });

  it('makes a sent disclosure update-required on a significant rise, from today', () => {
    const small = revise(sent, 495_000);
    expect(small.updateRequired).toBe(false);
    expect(small.next.status).toBe('sent');
    const big = revise(sent, 495_001);
    expect(big).toMatchObject({ updateRequired: true, reasons: ['increase'], unchanged: false });
    expect(big.next).toMatchObject({
      status: 'update_required',
      updateReasons: ['increase'],
      requiredSince: today,
      basisEstimateCents: 495_001,
      sentEstimateCents: 450_000,
    });
    expect(big.next.history?.at(-1)).toMatchObject({ action: 'update_required', status: 'update_required' });
    // The org's own percentage.
    expect(revise(sent, 495_001, 20).updateRequired).toBe(false);
  });

  it('moves a sent short-form disclosure to update-required when the estimate crosses into full', () => {
    const short: CostsDisclosure = {
      ...sent,
      requirement: 'short_form',
      bandId: 'standard-form',
      sentBandId: 'standard-form',
      basisEstimateCents: 290_000 as never,
      sentEstimateCents: 290_000 as never,
    };
    expect(revise(short, 310_000)).toMatchObject({ updateRequired: true, reasons: ['band'] });
  });

  it('before a disclosure is given, follows the estimate; a waiver stands', () => {
    const notRequired: CostsDisclosure = {
      status: 'not_required',
      notRequiredReason: 'below_threshold',
      basisEstimateCents: 50_000 as never,
      history: [],
    };
    const raised = revise(notRequired, 450_000);
    expect(raised).toMatchObject({ becameRequired: true, updateRequired: false });
    expect(raised.next).toMatchObject({ status: 'required', requiredSince: today, requirement: 'full' });
    expect(raised.next.notRequiredReason).toBeUndefined();
    const back = revise(raised.next, 50_000);
    expect(back.next.status).toBe('not_required');
    expect(back.next.requiredSince).toBeUndefined();
    const waived: CostsDisclosure = {
      status: 'waived',
      waiver: { reason: 'sophisticated_client', by: 'user-jordan', at: now },
      history: [],
    };
    expect(revise(waived, 900_000).next.status).toBe('waived');
  });

  it('is unchanged when nothing about the disclosure moves', () => {
    const result = revise(sent, 450_000);
    expect(result.unchanged).toBe(true);
    expect(result.next.history).toEqual([]);
  });

  it('reads the org’s percentage, defaulting to 10', () => {
    expect(disclosureChangePct({ billing: { disclosureChangePct: 25 } })).toBe(25);
    expect(disclosureChangePct({ billing: { disclosureChangePct: 0 } })).toBe(10);
    expect(disclosureChangePct(undefined)).toBe(10);
    expect(DisclosureChangePctSchema.safeParse(101).success).toBe(false);
  });
});

describe('sending and the reminder', () => {
  it('records sent the first time and updated after that', () => {
    expect(sentStatus({ status: 'required' })).toBe('sent');
    expect(sentStatus({ status: 'update_required', sentOn: '2026-09-01' as DateOnly })).toBe('updated');
    expect(disclosureOutstanding('required')).toBe(true);
    expect(disclosureOutstanding('update_required')).toBe(true);
    expect(disclosureOutstanding('sent')).toBe(false);
  });

  it('reminds once, 7 days after a required disclosure fell due', () => {
    const d = (requiredSince?: string, remindedOn?: string) =>
      ({ status: 'required', requiredSince, remindedOn }) as CostsDisclosure;
    expect(disclosureReminderDue(d('2026-09-30'), today)).toBe(false);
    expect(disclosureReminderDue(d('2026-09-29'), today)).toBe(true);
    expect(disclosureReminderDue(d('2026-09-29', '2026-10-06'), today)).toBe(false);
    // Due again after a fresh start (an estimate revision that made it required again).
    expect(disclosureReminderDue(d('2026-09-29', '2026-09-20'), today)).toBe(true);
    expect(disclosureReminderDue(d(undefined), today, '2026-09-01' as DateOnly)).toBe(true);
    expect(disclosureReminderDue(d(undefined), today)).toBe(false);
    expect(disclosureReminderDue({ status: 'update_required', requiredSince: '2026-09-01' as DateOnly }, today)).toBe(
      false,
    );
    expect(disclosureTaskId('due', '2026-09-29' as DateOnly)).toBe('costs-disclosure-due-2026-09-29');
  });

  it('keeps the newest history lines only', () => {
    let history: DisclosureEvent[] = [];
    for (let i = 0; i < DISCLOSURE_HISTORY_MAX + 5; i++) {
      history = withDisclosureEvent(history, {
        at: now,
        by: 'system',
        action: 'reminded',
        status: 'required',
        note: `${i}`,
      });
    }
    expect(history).toHaveLength(DISCLOSURE_HISTORY_MAX);
    expect(history.at(-1)?.note).toBe(`${DISCLOSURE_HISTORY_MAX + 4}`);
    expect(
      withDisclosureEvent(undefined, {
        at: now,
        by: 'system',
        action: 'reminded',
        status: 'required',
        note: undefined,
      }),
    ).toEqual([{ at: now, by: 'system', action: 'reminded', status: 'required' }]);
  });
});
