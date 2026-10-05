import {
  COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS,
  costsDisclosureRequirement,
  CostsDisclosureInput,
  dateOfDeathProblem,
  decodeIntakeDraftState,
  encodeIntakeDraftState,
  feeEstimateCents,
  FeeInput,
  INTAKE_DRAFT_MAX_STATE_CHARS,
  INTAKE_STEP_SCHEMAS,
  INTAKE_STEPS,
  IntakeClientsStep,
  IntakeConflictStep,
  intakeCostsDisclosure,
  IntakeDetailsStep,
  intakeDetailsStep,
  IntakeDraft,
  intakeDraftExpireAt,
  intakeDraftFields,
  intakeDraftId,
  IntakeEventInput,
  IntakeFeesStep,
  intakeFormSchema,
  IntakePartiesStep,
  IntakePartyInput,
  IntakeReviewStep,
  intakeToCreateMatterInput,
  IntakeTypeStep,
  OTHER_SIDE_ROLE,
  type IntakeForm,
} from './intake';
import { CreateMatterInput } from './matters';
import { dateOnly } from './values/date-only';

/** CORE-05 intake schemas. Every person and contact id here is fictional. */

const TODAY = dateOnly('2026-10-04');
const at = { today: () => TODAY };
const details = intakeDetailsStep(at);
const form = intakeFormSchema(at);
const REQUEST_ID = '3f1f0a9e-5c1b-4b8e-9d0e-6a1d2c3b4a59';

const messages = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);

const probate = (extra: Record<string, unknown> = {}) => ({
  type: 'probate',
  deceasedContactId: 'c-bertram',
  dateOfDeath: '2026-08-01',
  domicile: 'VIC',
  willExists: true,
  willDate: '2019-03-14',
  ...extra,
});
const fp = (extra: Record<string, unknown> = {}) => ({
  type: 'fp',
  deceasedContactId: 'c-bertram',
  dateOfDeath: '2026-02-11',
  ourRole: 'plaintiff',
  otherSideContactIds: ['c-cora'],
  ...extra,
});

describe('step 1: matter type', () => {
  it('takes a type and defaults the jurisdiction to VIC', () => {
    expect(IntakeTypeStep.parse({ type: 'will' })).toEqual({ type: 'will', jurisdiction: 'VIC' });
    expect(IntakeTypeStep.parse({ type: 'trust', jurisdiction: 'NSW' }).jurisdiction).toBe('NSW');
  });
  it('refuses unknown types and fields', () => {
    expect(IntakeTypeStep.safeParse({ type: 'conveyancing' }).success).toBe(false);
    expect(IntakeTypeStep.safeParse({ type: 'will', colour: 'red' }).success).toBe(false);
  });
});

describe('step 2: clients', () => {
  it('needs at least one client, each once', () => {
    expect(IntakeClientsStep.safeParse({ clientContactIds: ['c-ada'] }).success).toBe(true);
    expect(messages(IntakeClientsStep.safeParse({ clientContactIds: [] }))).toEqual([
      'clientContactIds: Add at least one client',
    ]);
    expect(messages(IntakeClientsStep.safeParse({ clientContactIds: ['c-ada', 'c-ada'] }))).toEqual([
      'clientContactIds: Each contact can be listed once',
    ]);
    expect(IntakeClientsStep.safeParse({ clientContactIds: ['a/b'] }).success).toBe(false);
  });

  it('takes a referrer or a referral source, not both (CORE-18)', () => {
    expect(IntakeClientsStep.safeParse({ clientContactIds: ['c-ada'], referrerContactId: 'c-ref' }).success).toBe(true);
    expect(IntakeClientsStep.safeParse({ clientContactIds: ['c-ada'], referralSource: 'website' }).success).toBe(true);
    expect(IntakeClientsStep.safeParse({ clientContactIds: ['c-ada'], referralSource: 'radio' }).success).toBe(false);
    expect(
      messages(
        IntakeClientsStep.safeParse({
          clientContactIds: ['c-ada'],
          referrerContactId: 'c-ref',
          referralSource: 'website',
        }),
      ),
    ).toEqual(['referralSource: Choose a referrer or a source, not both']);
  });
});

describe('step 3: details', () => {
  it('will: the testator', () => {
    expect(details.safeParse({ type: 'will', testatorContactId: 'c-ada' }).success).toBe(true);
    expect(details.safeParse({ type: 'will' }).success).toBe(false);
  });

  it('poa: the principal', () => {
    expect(details.safeParse({ type: 'poa', principalContactId: 'c-ada' }).success).toBe(true);
    expect(details.safeParse({ type: 'poa', testatorContactId: 'c-ada' }).success).toBe(false);
  });

  it('trust: a name and at least one trustee', () => {
    expect(
      details.safeParse({ type: 'trust', trustName: 'Quill Family Trust', trusteeContactIds: ['c-ada'] }).success,
    ).toBe(true);
    expect(messages(details.safeParse({ type: 'trust', trustName: ' ', trusteeContactIds: [] }))).toHaveLength(2);
  });

  it.each(['probate', 'loa', 'admin'])('%s: deceased, date of death, domicile and the will', (type) => {
    expect(details.safeParse(probate({ type })).success).toBe(true);
    expect(details.safeParse(probate({ type, domicile: '' })).success).toBe(false);
    expect(details.safeParse(probate({ type, willExists: undefined })).success).toBe(false);
    expect(details.safeParse(probate({ type, deceasedContactId: undefined })).success).toBe(false);
  });

  it('accepts an unknown date of death', () => {
    expect(details.parse(probate({ dateOfDeath: 'unknown' })).type).toBe('probate');
    expect(details.safeParse(fp({ dateOfDeath: 'unknown' })).success).toBe(true);
    expect(details.safeParse(probate({ dateOfDeath: 'sometime' })).success).toBe(false);
    expect(details.safeParse(probate({ dateOfDeath: '2026-02-30' })).success).toBe(false);
  });

  it('refuses a date of death in the future', () => {
    expect(details.safeParse(probate({ dateOfDeath: '2026-10-04' })).success).toBe(true);
    expect(messages(details.safeParse(probate({ dateOfDeath: '2026-10-05', willDate: undefined })))).toEqual([
      'dateOfDeath: The date of death cannot be in the future',
    ]);
    expect(messages(details.safeParse(fp({ dateOfDeath: '2027-01-01' })))).toEqual([
      'dateOfDeath: The date of death cannot be in the future',
    ]);
  });

  it("refuses a date of death before the deceased's date of birth", () => {
    expect(details.safeParse(probate({ deceasedDateOfBirth: '1940-05-02', dateOfDeath: '1940-05-02' })).success).toBe(
      false, // the will (2019) is after this date of death
    );
    expect(
      messages(
        details.safeParse(
          probate({ deceasedDateOfBirth: '1940-05-02', dateOfDeath: '1940-05-01', willDate: undefined }),
        ),
      ),
    ).toEqual(['dateOfDeath: The date of death cannot be before the date of birth']);
    expect(details.safeParse(probate({ deceasedDateOfBirth: '1940-05-02' })).success).toBe(true);
    // Unknown date of death: nothing to compare.
    expect(details.safeParse(probate({ deceasedDateOfBirth: '1940-05-02', dateOfDeath: 'unknown' })).success).toBe(
      true,
    );
    expect(messages(details.safeParse(probate({ deceasedDateOfBirth: '2027-01-01', dateOfDeath: 'unknown' })))).toEqual(
      ['deceasedDateOfBirth: The date of birth cannot be in the future'],
    );
  });

  it('checks the will: probate needs one; its date is not in the future or after the death', () => {
    expect(messages(details.safeParse(probate({ willExists: false, willDate: undefined })))).toEqual([
      'willExists: Probate needs a will; choose letters of administration instead',
    ]);
    expect(details.safeParse(probate({ type: 'loa', willExists: false, willDate: undefined })).success).toBe(true);
    expect(messages(details.safeParse(probate({ type: 'loa', willExists: false })))).toEqual([
      'willDate: There is no will to date',
    ]);
    expect(messages(details.safeParse(probate({ willDate: '2026-09-01' })))).toEqual([
      'willDate: The will date cannot be after the date of death',
    ]);
    expect(messages(details.safeParse(probate({ dateOfDeath: 'unknown', willDate: '2026-12-01' })))).toEqual([
      'willDate: The will date cannot be in the future',
    ]);
    expect(details.safeParse(probate({ dateOfDeath: 'unknown', willDate: '2020-01-01' })).success).toBe(true);
  });

  it.each(['fp', 'contest'])('%s: deceased, our role and the other side', (type) => {
    for (const ourRole of ['plaintiff', 'defendant', 'executor']) {
      expect(details.safeParse(fp({ type, ourRole })).success).toBe(true);
    }
    expect(details.safeParse(fp({ type, ourRole: 'beneficiary' })).success).toBe(false);
    expect(messages(details.safeParse(fp({ type, otherSideContactIds: [] })))).toEqual([
      'otherSideContactIds: Add at least one party on the other side',
    ]);
    expect(messages(details.safeParse(fp({ type, otherSideContactIds: ['c-bertram'] })))).toEqual([
      'otherSideContactIds: The deceased cannot be on the other side',
    ]);
  });

  it('refuses fields of another type', () => {
    expect(details.safeParse({ type: 'will', testatorContactId: 'c-ada', willExists: true }).success).toBe(false);
    expect(details.safeParse(probate({ ourRole: 'plaintiff' })).success).toBe(false);
  });

  it('defaults to Melbourne’s today', () => {
    expect(IntakeDetailsStep.safeParse(probate({ dateOfDeath: '2999-01-01', willDate: undefined })).success).toBe(
      false,
    );
    expect(IntakeDetailsStep.safeParse(probate()).success).toBe(true);
  });
});

describe('dateOfDeathProblem', () => {
  it('is undefined for a date of death on or before today and on or after the date of birth', () => {
    expect(dateOfDeathProblem(TODAY, { today: TODAY })).toBeUndefined();
    expect(
      dateOfDeathProblem(dateOnly('1999-01-01'), { today: TODAY, dateOfBirth: dateOnly('1999-01-01') }),
    ).toBeUndefined();
    expect(dateOfDeathProblem(dateOnly('2026-10-05'), { today: TODAY })).toMatch(/future/);
    expect(dateOfDeathProblem(dateOnly('1998-12-31'), { today: TODAY, dateOfBirth: dateOnly('1999-01-01') })).toMatch(
      /before the date of birth/,
    );
  });
});

describe('step 4: parties', () => {
  it('lets one contact hold several roles (a testator who is also an executor)', () => {
    const step = IntakePartiesStep.parse({
      parties: [
        { contactId: 'c-ada', role: 'testator' },
        { contactId: 'c-ada', role: 'executor' },
        { contactId: 'c-dora', role: 'beneficiary', share: '50%' },
      ],
    });
    expect(step.parties).toHaveLength(3);
  });

  it('refuses the same contact twice in one role, unknown roles and extra fields', () => {
    expect(
      messages(
        IntakePartiesStep.safeParse({
          parties: [
            { contactId: 'c-ada', role: 'executor' },
            { contactId: 'c-ada', role: 'executor' },
          ],
        }),
      ),
    ).toEqual(['parties.1: This contact is already in this role']);
    expect(IntakePartyInput.safeParse({ contactId: 'c-ada', role: 'friend' }).success).toBe(false);
    expect(IntakePartyInput.safeParse({ contactId: 'c-ada', role: 'executor', orgId: 'x' }).success).toBe(false);
    expect(IntakePartiesStep.parse({ parties: [] }).parties).toEqual([]);
  });
});

describe('events', () => {
  it('takes a kind and a date', () => {
    expect(IntakeEventInput.safeParse({ kind: 'will_located', date: '2026-09-01' }).success).toBe(true);
    expect(IntakeEventInput.safeParse({ kind: 'birthday', date: '2026-09-01' }).success).toBe(false);
    expect(IntakeEventInput.safeParse({ kind: 'custom', date: '01/09/2026' }).success).toBe(false);
  });
});

describe('step 5: fees and costs disclosure', () => {
  it('needs what each arrangement needs', () => {
    expect(FeeInput.safeParse({ arrangement: 'hourly' }).success).toBe(true);
    expect(FeeInput.safeParse({ arrangement: 'hourly', estimateCents: 450000, rateOverrideCents: 38000 }).success).toBe(
      true,
    );
    expect(messages(FeeInput.safeParse({ arrangement: 'fixed' }))).toEqual(['amountCents: Enter the fixed fee']);
    expect(FeeInput.safeParse({ arrangement: 'fixed', amountCents: 220000 }).success).toBe(true);
    expect(messages(FeeInput.safeParse({ arrangement: 'capped' }))).toEqual(['capCents: Enter the cap']);
    expect(messages(FeeInput.safeParse({ arrangement: 'capped', capCents: 1000, estimateCents: 2000 }))).toEqual([
      'estimateCents: The estimate cannot be more than the cap',
    ]);
    expect(FeeInput.safeParse({ arrangement: 'capped', capCents: 2000, estimateCents: 1000 }).success).toBe(true);
    expect(messages(FeeInput.safeParse({ arrangement: 'conditional' }))).toEqual([
      'conditional: Enter the condition and the uplift',
    ]);
    expect(
      FeeInput.safeParse({
        arrangement: 'conditional',
        conditional: { upliftPct: 25, condition: 'Successful outcome' },
      }).success,
    ).toBe(true);
    expect(
      FeeInput.safeParse({
        arrangement: 'conditional',
        conditional: { upliftPct: 26, condition: 'Successful outcome' },
      }).success,
    ).toBe(false);
    expect(
      messages(FeeInput.safeParse({ arrangement: 'hourly', conditional: { upliftPct: 10, condition: 'Win' } })),
    ).toEqual(['conditional: Only a conditional arrangement has an uplift']);
    expect(messages(FeeInput.safeParse({ arrangement: 'pro_bono', amountCents: 1, rateOverrideCents: 1 }))).toEqual([
      'amountCents: A pro bono matter has no fees',
      'rateOverrideCents: A pro bono matter has no fees',
    ]);
  });

  it('refuses negative and fractional amounts', () => {
    expect(FeeInput.safeParse({ arrangement: 'fixed', amountCents: -1 }).success).toBe(false);
    expect(FeeInput.safeParse({ arrangement: 'fixed', amountCents: 10.5 }).success).toBe(false);
  });

  it('judges the estimate: given, else the fixed fee or the cap, zero for pro bono', () => {
    expect(feeEstimateCents({ arrangement: 'hourly', estimateCents: 5 as never })).toBe(5);
    expect(feeEstimateCents({ arrangement: 'hourly' })).toBeUndefined();
    expect(feeEstimateCents({ arrangement: 'fixed', amountCents: 7 as never })).toBe(7);
    expect(feeEstimateCents({ arrangement: 'capped', capCents: 9 as never })).toBe(9);
    expect(feeEstimateCents({ arrangement: 'conditional' })).toBeUndefined();
    expect(feeEstimateCents({ arrangement: 'pro_bono' })).toBe(0);
  });

  it('computes the costs disclosure requirement from the placeholder threshold', () => {
    expect(costsDisclosureRequirement(undefined)).toBe('required');
    expect(costsDisclosureRequirement(0)).toBe('not_required');
    expect(costsDisclosureRequirement(COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS - 1)).toBe('not_required');
    expect(costsDisclosureRequirement(COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS)).toBe('required');
  });

  it('the fees step records a waiver or the computed requirement', () => {
    const hourly = IntakeFeesStep.parse({ fee: { arrangement: 'hourly', estimateCents: 450000 } });
    expect(hourly.costsDisclosureWaived).toBe(false);
    expect(intakeCostsDisclosure(hourly)).toEqual({ status: 'required', estimateCents: 450000 });
    expect(intakeCostsDisclosure(IntakeFeesStep.parse({ fee: { arrangement: 'hourly' } }))).toEqual({
      status: 'required',
    });
    expect(intakeCostsDisclosure(IntakeFeesStep.parse({ fee: { arrangement: 'fixed', amountCents: 50000 } }))).toEqual({
      status: 'not_required',
      estimateCents: 50000,
    });
    expect(
      intakeCostsDisclosure(IntakeFeesStep.parse({ fee: { arrangement: 'pro_bono' }, costsDisclosureWaived: true })),
    ).toEqual({ status: 'waived', estimateCents: 0 });
    expect(CostsDisclosureInput.safeParse({ status: 'sent' }).success).toBe(false);
  });
});

describe('step 6: conflict', () => {
  it('names the check and the determination; potential and conflict need a reason', () => {
    expect(IntakeConflictStep.safeParse({ checkId: 'chk-1', status: 'pending' }).success).toBe(true);
    expect(IntakeConflictStep.safeParse({ checkId: 'chk-1', status: 'clear' }).success).toBe(true);
    expect(messages(IntakeConflictStep.safeParse({ checkId: 'chk-1', status: 'conflict' }))).toEqual([
      'reason: Give a reason for a potential conflict or a conflict',
    ]);
    expect(
      IntakeConflictStep.safeParse({ checkId: 'chk-1', status: 'potential', reason: 'Waived in writing' }).success,
    ).toBe(true);
    expect(IntakeConflictStep.safeParse({ status: 'clear' }).success).toBe(false);
  });
});

describe('step 7: review', () => {
  it('takes the title and the team, with defaults', () => {
    expect(IntakeReviewStep.parse({ title: 'Estate of Bertram Quill', responsibleUid: 'u-1' })).toEqual({
      title: 'Estate of Bertram Quill',
      responsibleUid: 'u-1',
      teamUids: [],
      labels: [],
      priority: 'none',
      privileged: false,
    });
    expect(IntakeReviewStep.safeParse({ title: '', responsibleUid: 'u-1' }).success).toBe(false);
    expect(IntakeReviewStep.safeParse({ title: 'x', responsibleUid: 'u-1', labels: [''] }).success).toBe(false);
  });
});

describe('the whole form', () => {
  const probateForm = (extra: Partial<Record<keyof IntakeForm, unknown>> = {}) => ({
    type: { type: 'probate' },
    clients: { clientContactIds: ['c-ada'] },
    details: probate(),
    parties: { parties: [{ contactId: 'c-ada', role: 'executor' }] },
    fees: { fee: { arrangement: 'fixed', amountCents: 330000 } },
    conflict: { checkId: 'chk-1', status: 'clear' },
    review: { title: 'Estate of Bertram Quill', responsibleUid: 'u-lawyer', teamUids: ['u-para'] },
    ...extra,
  });

  it('lists the steps in order, each with its schema', () => {
    expect(INTAKE_STEPS).toEqual(['type', 'clients', 'details', 'parties', 'fees', 'conflict', 'review']);
    expect(Object.keys(INTAKE_STEP_SCHEMAS)).toEqual([...INTAKE_STEPS]);
  });

  it('needs the details for the chosen type and keeps clients off the other side', () => {
    expect(form.safeParse(probateForm()).success).toBe(true);
    expect(messages(form.safeParse(probateForm({ type: { type: 'loa' } })))).toEqual([
      'details.type: The details are for another matter type',
    ]);
    expect(
      messages(
        form.safeParse(
          probateForm({
            type: { type: 'fp' },
            details: fp({ otherSideContactIds: ['c-ada'] }),
            parties: { parties: [] },
          }),
        ),
      ),
    ).toEqual(['details.otherSideContactIds.0: A client cannot be on the other side']);
  });

  it('builds a valid createMatter input for probate', () => {
    const input = intakeToCreateMatterInput(form.parse(probateForm()), REQUEST_ID);
    expect(input).toEqual({
      requestId: REQUEST_ID,
      matter: {
        title: 'Estate of Bertram Quill',
        type: 'probate',
        jurisdiction: 'VIC',
        responsibleUid: 'u-lawyer',
        teamUids: ['u-para'],
        labels: [],
        priority: 'none',
        privileged: false,
        clientContactIds: ['c-ada'],
        deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: '' },
        facts: { willDate: '2019-03-14' },
        estate: { grantType: 'probate' },
        conflictCheck: { status: 'clear' },
      },
      parties: [{ contactId: 'c-ada', role: 'executor' }],
      events: [],
      fee: { arrangement: 'fixed', amountCents: 330000 },
      costsDisclosure: { status: 'required', estimateCents: 330000 },
      conflictCheckId: 'chk-1',
    });
    expect(CreateMatterInput.safeParse(input).success).toBe(true);
  });

  it('carries the referral to the matter (CORE-18)', () => {
    const referred = probateForm({ clients: { clientContactIds: ['c-ada'], referrerContactId: 'c-ref' } });
    expect(intakeToCreateMatterInput(form.parse(referred), REQUEST_ID).matter.referrerContactId).toBe('c-ref');
    const walkIn = probateForm({ clients: { clientContactIds: ['c-ada'], referralSource: 'walk_in' } });
    const input = intakeToCreateMatterInput(form.parse(walkIn), REQUEST_ID);
    expect(input.matter.referralSource).toBe('walk_in');
    expect(input.matter.referrerContactId).toBeUndefined();
    expect(CreateMatterInput.safeParse(input).success).toBe(true);
  });

  it('leaves the date of death out when unknown, and marks letters of administration with a will', () => {
    const input = intakeToCreateMatterInput(
      form.parse(
        probateForm({
          type: { type: 'loa' },
          details: probate({ type: 'loa', dateOfDeath: 'unknown', lastAddress: '1 Fictional St' }),
        }),
      ),
      REQUEST_ID,
    );
    expect(input.matter.deceased).toEqual({ contactId: 'c-bertram', domicile: 'VIC', lastAddress: '1 Fictional St' });
    expect(input.matter.estate).toEqual({ grantType: 'loa_with_will' });
    expect(CreateMatterInput.safeParse(input).success).toBe(true);
    const intestate = intakeToCreateMatterInput(
      form.parse(
        probateForm({
          type: { type: 'loa' },
          details: probate({ type: 'loa', willExists: false, willDate: undefined }),
        }),
      ),
      REQUEST_ID,
    );
    expect(intestate.matter.estate).toEqual({ grantType: 'loa' });
    expect(intestate.matter.facts).toBeUndefined();
  });

  it.each([
    ['plaintiff', 'defendant'],
    ['defendant', 'plaintiff'],
    ['executor', 'plaintiff'],
  ] as const)('a family provision claim for the %s puts the other side in the opposing role', (ourRole, theirs) => {
    expect(OTHER_SIDE_ROLE[ourRole]).toBe(theirs);
    const input = intakeToCreateMatterInput(
      form.parse(
        probateForm({
          type: { type: 'fp' },
          details: fp({ ourRole, otherSideContactIds: ['c-cora', 'c-eli'] }),
          parties: { parties: [] },
          conflict: { checkId: 'chk-2', status: 'conflict', reason: 'Acted for the other side before' },
        }),
      ),
      REQUEST_ID,
    );
    expect(input.parties).toEqual([
      { contactId: 'c-ada', role: ourRole },
      { contactId: 'c-cora', role: theirs },
      { contactId: 'c-eli', role: theirs },
    ]);
    expect(input.matter.dispute).toEqual({ kind: 'family_provision', proceedingIds: [] });
    expect(input.matter.deceased).toEqual({
      contactId: 'c-bertram',
      dateOfDeath: '2026-02-11',
      domicile: '',
      lastAddress: '',
    });
    expect(input.matter.conflictCheck).toEqual({ status: 'conflict', reason: 'Acted for the other side before' });
    expect(CreateMatterInput.safeParse(input).success).toBe(true);
  });

  it('builds will, power of attorney, will contest and trust matters', () => {
    const will = intakeToCreateMatterInput(
      form.parse(probateForm({ type: { type: 'will' }, details: { type: 'will', testatorContactId: 'c-ada' } })),
      REQUEST_ID,
    );
    expect(will.matter.testator).toEqual({ contactId: 'c-ada' });
    expect(will.matter.deceased).toBeUndefined();
    const poa = intakeToCreateMatterInput(
      form.parse(probateForm({ type: { type: 'poa' }, details: { type: 'poa', principalContactId: 'c-ada' } })),
      REQUEST_ID,
    );
    expect(poa.matter.testator).toEqual({ contactId: 'c-ada' });
    const contest = intakeToCreateMatterInput(
      form.parse(probateForm({ type: { type: 'contest' }, details: fp({ type: 'contest', ourRole: 'executor' }) })),
      REQUEST_ID,
    );
    expect(contest.matter.dispute?.kind).toBe('will_contest');
    const trust = intakeToCreateMatterInput(
      form.parse(
        probateForm({
          type: { type: 'trust' },
          details: { type: 'trust', trustName: 'Quill Family Trust', trusteeContactIds: ['c-ada', 'c-dora'] },
          parties: { parties: [] },
          conflict: { checkId: 'chk-3', status: 'potential', reason: '  Related trust  ' },
        }),
      ),
      REQUEST_ID,
    );
    expect(trust.matter.facts).toEqual({ trustName: 'Quill Family Trust' });
    expect(trust.parties).toEqual([
      { contactId: 'c-ada', role: 'trustee' },
      { contactId: 'c-dora', role: 'trustee' },
    ]);
    expect(trust.matter.conflictCheck.reason).toBe('Related trust');
    for (const input of [will, poa, contest, trust]) expect(CreateMatterInput.safeParse(input).success).toBe(true);
  });
});

describe('CreateMatterInput (CORE-05 extension)', () => {
  const base = {
    requestId: REQUEST_ID,
    matter: {
      title: 'Estate of Bertram Quill',
      type: 'probate',
      jurisdiction: 'VIC',
      responsibleUid: 'u-lawyer',
      clientContactIds: ['c-ada'],
      conflictCheck: { status: 'pending' },
    },
  };

  it('still takes the fee and costs disclosure on the matter (backward compatible)', () => {
    expect(
      CreateMatterInput.safeParse({
        ...base,
        matter: { ...base.matter, fee: { arrangement: 'hourly' }, costsDisclosure: { status: 'required' } },
      }).success,
    ).toBe(true);
  });

  it('needs a fee somewhere', () => {
    expect(messages(CreateMatterInput.safeParse(base))).toEqual(['fee: Choose a fee arrangement']);
    expect(CreateMatterInput.safeParse({ ...base, fee: { arrangement: 'pro_bono' } }).success).toBe(true);
  });

  it('refuses a conflict check id that differs from the matter’s result id', () => {
    const matter = { ...base.matter, conflictCheck: { status: 'pending', resultId: 'chk-1' } };
    expect(
      CreateMatterInput.safeParse({ ...base, matter, fee: { arrangement: 'hourly' }, conflictCheckId: 'chk-1' })
        .success,
    ).toBe(true);
    expect(
      messages(
        CreateMatterInput.safeParse({ ...base, matter, fee: { arrangement: 'hourly' }, conflictCheckId: 'chk-2' }),
      ),
    ).toEqual(['conflictCheckId: The conflict check differs from matter.conflictCheck.resultId']);
  });

  it('takes a deceased without a date of death', () => {
    const matter = { ...base.matter, deceased: { contactId: 'c-bertram', domicile: 'VIC', lastAddress: '' } };
    expect(CreateMatterInput.safeParse({ ...base, matter, fee: { arrangement: 'hourly' } }).success).toBe(true);
  });
});

describe('intake drafts', () => {
  const NOW = new Date('2026-10-04T01:00:00.000Z');

  it('ids are intake-{id}', () => {
    expect(intakeDraftId('3f1f0a9e-5c1b')).toBe('intake-3f1f0a9e-5c1b');
    expect(() => intakeDraftId('a/b')).toThrow();
    expect(() => intakeDraftId('')).toThrow();
  });

  it('expire 30 days after the save', () => {
    expect(intakeDraftExpireAt(NOW).toISOString()).toBe('2026-11-03T01:00:00.000Z');
  });

  it('round-trip the partial form state as JSON text', () => {
    const state = { type: { type: 'probate' }, clients: { clientContactIds: ['c-ada'] }, review: { title: null } };
    const fields = intakeDraftFields('org-1', 'clients', state, NOW);
    expect(fields).toEqual({
      orgId: 'org-1',
      kind: 'intake',
      step: 'clients',
      stateJson: JSON.stringify(state),
      expireAt: intakeDraftExpireAt(NOW),
    });
    expect(decodeIntakeDraftState(fields.stateJson)).toEqual(state);
    expect(
      IntakeDraft.schema.safeParse({
        ...fields,
        createdAt: NOW,
        createdBy: 'u-1',
        updatedAt: NOW,
        updatedBy: 'u-1',
        schemaVersion: 1,
      }).success,
    ).toBe(true);
  });

  it('refuses state that is not a JSON object, or too large', () => {
    expect(decodeIntakeDraftState(undefined)).toEqual({});
    expect(decodeIntakeDraftState('not json')).toEqual({});
    expect(decodeIntakeDraftState('[1,2]')).toEqual({});
    expect(() => encodeIntakeDraftState({ notes: 'x'.repeat(INTAKE_DRAFT_MAX_STATE_CHARS) })).toThrow(/too large/);
    expect(() => encodeIntakeDraftState({ when: new Date() } as never)).toThrow();
    const draft = (stateJson: string) =>
      IntakeDraft.create.safeParse({ orgId: 'org-1', kind: 'intake', step: 'type', stateJson, expireAt: NOW }).success;
    expect(draft('{}')).toBe(true);
    expect(draft('[]')).toBe(false);
    expect(draft('{')).toBe(false);
    expect(
      IntakeDraft.create.safeParse({ orgId: 'org-1', kind: 'intake', step: 'payment', stateJson: '{}', expireAt: NOW })
        .success,
    ).toBe(false);
  });
});
