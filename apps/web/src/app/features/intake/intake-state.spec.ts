import { DomainError, intakeToCreateMatterInput, type DateOnly } from '@materia/domain';

import { createErrorCopy } from './intake-page';
import {
  buildIntakeForm,
  conflictSubjects,
  costsDisclosureFor,
  derivedParties,
  emptyIntakeState,
  formatDollarsInput,
  labelList,
  parseDollars,
  restoreIntakeState,
  suggestedParties,
  suggestedTitle,
  validateStep,
  type IntakeState,
} from './intake-state';
import { probateState, stateWith } from './testing';

/** The New matter form's pure rules (CORE-05). Fictional data only. */

const TODAY = '2026-10-04' as DateOnly;

function fpState(): IntakeState {
  const base = emptyIntakeState();
  return stateWith({
    type: 'fp',
    clientContactIds: ['c-avery'],
    details: {
      ...base.details,
      deceasedContactId: 'c-margaret',
      dateOfDeathUnknown: true,
      domicile: '',
      ourRole: 'plaintiff',
      otherSideContactIds: ['c-bram'],
    },
    fees: { ...base.fees, arrangement: 'pro_bono' },
    conflict: {
      run: { checkId: 'chk-1', hits: [], adverseRolesChecked: true, subjects: [] },
      status: 'pending',
      reason: '',
    },
    review: { ...base.review, title: 'Quill claim', responsibleUid: 'user-jordan' },
  });
}

describe('amounts and labels', () => {
  it('reads dollars as typed into cents, and back', () => {
    expect(parseDollars('$1,500.5')).toBe(150050);
    expect(parseDollars(' ')).toBeUndefined();
    expect(parseDollars('12.345')).toBeNull();
    expect(formatDollarsInput(150050)).toBe('1500.50');
    expect(formatDollarsInput(150000)).toBe('1500');
    expect(formatDollarsInput(undefined)).toBe('');
    expect(labelList(' grant, , urgent,grant ')).toEqual(['grant', 'urgent']);
  });
});

describe('derived parties, subjects and titles', () => {
  it('puts a family provision’s clients and other side in their roles, and checks them all', () => {
    const state = fpState();
    expect(derivedParties(state).map((p) => `${p.role}:${p.contactId}`)).toEqual([
      'client:c-avery',
      'deceased:c-margaret',
      'plaintiff:c-avery',
      'defendant:c-bram',
    ]);
    expect(conflictSubjects(state).map((s) => `${s.role}:${s.name}`)).toEqual([
      'client:Avery Quill',
      'deceased:Margaret Whitfield',
      'plaintiff:Avery Quill',
      'defendant:Bram Ostler',
    ]);
    expect(suggestedTitle(state)).toBe('Estate of Margaret Whitfield (family provision)');
    expect(suggestedParties(state)).toEqual([]);
  });

  it('suggests a title for each kind of matter', () => {
    const base = probateState();
    expect(suggestedTitle(base)).toBe('Estate of Margaret Whitfield');
    expect(suggestedTitle({ ...base, type: 'will', details: { ...base.details, personContactId: 'c-avery' } })).toBe(
      'Will of Avery Quill',
    );
    expect(suggestedTitle({ ...base, type: 'poa', details: { ...base.details, personContactId: 'c-avery' } })).toBe(
      'Power of attorney for Avery Quill',
    );
    expect(suggestedTitle({ ...base, type: 'trust', details: { ...base.details, trustName: ' Quill Trust ' } })).toBe(
      'Quill Trust',
    );
    expect(suggestedTitle({ ...base, type: 'contest', details: { ...base.details, deceasedContactId: null } })).toBe(
      'Avery Quill (will dispute)',
    );
    expect(suggestedTitle(emptyIntakeState())).toBe('');
    expect(suggestedParties({ ...base, type: 'loa' })).toEqual([
      { contactId: 'c-avery', role: 'administrator', share: '' },
    ]);
  });
});

describe('validation and the create input', () => {
  it('builds the createMatter input for a family provision with an unknown date of death', () => {
    const state = fpState();
    for (const step of ['type', 'clients', 'details', 'parties', 'fees', 'conflict', 'review'] as const) {
      expect(validateStep(state, step, TODAY)).toEqual({});
    }
    const input = intakeToCreateMatterInput(buildIntakeForm(state, TODAY), '6d3a2c1e-8f4b-4c7d-9e2a-1b3c5d7e9f10');
    expect(input.matter).toMatchObject({
      type: 'fp',
      deceased: { contactId: 'c-margaret', domicile: '', lastAddress: '' },
      dispute: { kind: 'family_provision' },
      conflictCheck: { status: 'pending' },
    });
    expect(input.parties).toEqual([
      { contactId: 'c-avery', role: 'plaintiff' },
      { contactId: 'c-bram', role: 'defendant' },
    ]);
    expect(input.costsDisclosure).toEqual({ status: 'not_required', estimateCents: 0 });
  });

  it('words the will date, death and fee problems', () => {
    const state = probateState();
    state.details = { ...state.details, willDate: '31/02/2020', dateOfDeath: 'soon' };
    expect(validateStep(state, 'details', TODAY)).toMatchObject({
      willDate: 'Enter a date like 22/07/2026',
      dateOfDeath: 'Enter a date like 22/07/2026',
    });
    state.details = { ...state.details, willDate: '01/09/2026', dateOfDeath: '22/07/2026' };
    expect(validateStep(state, 'details', TODAY)).toEqual({
      willDate: 'The will date cannot be after the date of death',
    });
    expect(
      validateStep({ ...state, fees: { ...state.fees, arrangement: 'pro_bono', estimate: '10' } }, 'fees', TODAY),
    ).toEqual({});
  });

  it('shows the disclosure a half-filled fee implies', () => {
    const fees = emptyIntakeState().fees;
    expect(costsDisclosureFor({ ...fees, arrangement: 'capped', cap: '' })).toMatchObject({
      status: 'required',
      estimateKnown: false,
    });
    expect(costsDisclosureFor({ ...fees, estimate: 'x' })).toBeNull();
    expect(costsDisclosureFor({ ...fees, estimate: '700' })).toMatchObject({
      status: 'not_required',
      estimateCents: 70000,
    });
  });
});

describe('drafts', () => {
  it('restores a stored state over the empty form, ignoring junk', () => {
    const restored = restoreIntakeState({ type: 'will', details: { trustName: 'T' }, parties: 'nope', reached: 'x' });
    expect(restored.type).toBe('will');
    expect(restored.details.trustName).toBe('T');
    expect(restored.details.domicile).toBe('VIC');
    expect(restored.parties).toEqual([]);
    expect(restored.reached).toBe(0);
    expect(restored.requestId).toBeNull();
  });
});

describe('createErrorCopy', () => {
  it('words the fields the server refused, and a determination it needs a lawyer for', () => {
    const fields = new DomainError('INVALID_ARGUMENT', 'bad', {
      fields: { 'parties.0.contactId': ['Contact not found'] },
    });
    expect(createErrorCopy(fields)).toBe('Contact not found.');
    const role = new DomainError('PERMISSION_DENIED', 'no', { reason: 'conflict_determine_required' });
    expect(createErrorCopy(role)).toContain('Only a lawyer can record a conflict determination');
  });
});
