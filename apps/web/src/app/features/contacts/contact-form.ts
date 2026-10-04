import {
  type AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  type ValidationErrors,
  type ValidatorFn,
  Validators,
} from '@angular/forms';

import type { ContactListItem } from '@materia/data-access/repository';
import {
  AU_STATES,
  Contact,
  DateOnlySchema,
  guessPhoneType,
  normalisePhone,
  postcodeMatchesState,
  type DuplicateProbe,
  type PartyRole,
  type PhoneType,
} from '@materia/domain';
import type { MtOption } from '@materia/ui';

/**
 * The create/edit contact form (CORE-01): its controls, validators and the mapping to the
 * `Contact.create` shape (and back, for edits). Pure functions, so the dialog stays thin.
 */

export type ContactKind = 'person' | 'organisation';
type EmailType = 'personal' | 'work' | 'other';
type AddressType = 'residential' | 'postal' | 'business' | 'other';

export const KIND_OPTIONS: MtOption<ContactKind>[] = [
  { value: 'person', label: 'Person' },
  { value: 'organisation', label: 'Organisation' },
];
export const EMAIL_TYPE_OPTIONS: MtOption<EmailType>[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'work', label: 'Work' },
  { value: 'other', label: 'Other' },
];
export const PHONE_TYPE_OPTIONS: MtOption<PhoneType>[] = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'home', label: 'Home' },
  { value: 'work', label: 'Work' },
  { value: 'other', label: 'Other' },
];
export const ADDRESS_TYPE_OPTIONS: MtOption<AddressType>[] = [
  { value: 'residential', label: 'Residential' },
  { value: 'postal', label: 'Postal' },
  { value: 'business', label: 'Business' },
  { value: 'other', label: 'Other' },
];
export const STATE_OPTIONS: MtOption<string>[] = AU_STATES.map((state) => ({ value: state, label: state }));

export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  client: 'Client',
  testator: 'Testator',
  deceased: 'Deceased',
  executor: 'Executor',
  administrator: 'Administrator',
  beneficiary: 'Beneficiary',
  attorney: 'Attorney',
  guardian: 'Guardian',
  trustee: 'Trustee',
  plaintiff: 'Plaintiff',
  defendant: 'Defendant',
  witness: 'Witness',
  other_side_solicitor: 'Other side’s solicitor',
  counsel: 'Counsel',
  interested_person: 'Interested person',
};

/** Roles a delete refusal can name besides party roles. */
const OTHER_ROLE_LABELS: Record<string, string> = { safe_custody: 'Safe custody' };

/** A role label for any role string (references from the server may carry new roles). */
export function partyRoleLabel(role: string): string {
  return PARTY_ROLE_LABELS[role as PartyRole] ?? OTHER_ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

export const CONTACT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  phone: 'Enter a valid phone number, like 0412 345 678 or +44 20 7946 0000.',
  date: 'Enter a date like 14/06/1968.',
  dateOrder: 'The date of death can’t be before the date of birth.',
  abn: 'An ABN is 11 digits.',
  postcode: 'Enter a 4-digit postcode.',
  postcodeState: 'That postcode isn’t in the state you picked.',
  server: 'Check this field; it wasn’t accepted.',
};

/** `14/06/1968`, `14-6-1968` or `1968-06-14` → `1968-06-14`; null when it isn't a real date. */
export function parseDateInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let iso: string | null = null;
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (local) {
    const [, day = '', month = '', year = ''] = local;
    iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    iso = trimmed;
  }
  return iso && DateOnlySchema.safeParse(iso).success ? iso : null;
}

/** `1968-06-14` → `14/06/1968` for the input. */
export function formatDateInput(date: string | undefined): string {
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** A phone number that `normalisePhone` (libphonenumber, Australian by default) accepts. */
export const phoneValidator: ValidatorFn = (control) => {
  const value = String(control.value ?? '').trim();
  return !value || normalisePhone(value) ? null : { phone: true };
};

/** A date typed as DD/MM/YYYY (or ISO). Empty is fine; `required` is separate. */
export const dateValidator: ValidatorFn = (control) => {
  const value = String(control.value ?? '').trim();
  return !value || parseDateInput(value) ? null : { date: true };
};

/** An 11-digit ABN, spaces allowed. */
export const abnValidator: ValidatorFn = (control) => {
  const digits = String(control.value ?? '').replace(/\s/g, '');
  return !digits || /^\d{11}$/.test(digits) ? null : { abn: true };
};

/** Four digits, inside the ranges of the address's state (`postcodeMatchesState`). */
export const postcodeValidator: ValidatorFn = (control) => {
  const postcode = String(control.value ?? '').trim();
  if (!postcode) return null;
  if (!/^\d{4}$/.test(postcode)) return { postcode: true };
  const state = control.parent?.get('state')?.value as string | undefined;
  return state && !postcodeMatchesState(state, postcode) ? { postcodeState: true } : null;
};

export type EmailGroup = FormGroup<{ type: FormControl<EmailType>; address: FormControl<string> }>;
export type PhoneGroup = FormGroup<{ type: FormControl<PhoneType>; number: FormControl<string> }>;
export type AddressGroup = FormGroup<{
  type: FormControl<AddressType>;
  line1: FormControl<string>;
  line2: FormControl<string>;
  suburb: FormControl<string>;
  state: FormControl<string>;
  postcode: FormControl<string>;
}>;

const text = (value = '', validators: ValidatorFn[] = []) => new FormControl(value, { nonNullable: true, validators });

export function emailGroup(value: { type?: EmailType; address?: string } = {}): EmailGroup {
  return new FormGroup({
    type: new FormControl<EmailType>(value.type ?? 'personal', { nonNullable: true }),
    address: text(value.address ?? '', [Validators.required, Validators.email]),
  });
}

export function phoneGroup(value: { type?: PhoneType; number?: string } = {}): PhoneGroup {
  const group: PhoneGroup = new FormGroup({
    type: new FormControl<PhoneType>(value.type ?? 'mobile', { nonNullable: true }),
    number: text(value.number ?? '', [Validators.required, phoneValidator]),
  });
  // A new number's type follows what it looks like (mobile or landline) until someone picks one.
  group.controls.number.valueChanges.subscribe((raw) => {
    if (group.controls.type.dirty) return;
    const e164 = normalisePhone(raw);
    if (e164) group.controls.type.setValue(guessPhoneType(e164));
  });
  return group;
}

export function addressGroup(
  value: Partial<{
    type: AddressType;
    line1: string;
    line2: string;
    suburb: string;
    state: string;
    postcode: string;
  }> = {},
): AddressGroup {
  const group: AddressGroup = new FormGroup({
    type: new FormControl<AddressType>(value.type ?? 'residential', { nonNullable: true }),
    line1: text(value.line1 ?? '', [Validators.required]),
    line2: text(value.line2 ?? ''),
    suburb: text(value.suburb ?? '', [Validators.required]),
    state: text(value.state ?? 'VIC', [Validators.required]),
    postcode: text(value.postcode ?? '', [Validators.required, postcodeValidator]),
  });
  group.controls.state.valueChanges.subscribe(() => group.controls.postcode.updateValueAndValidity());
  return group;
}

/** A person needs a given or a family name (mononyms are fine); an organisation needs its name. */
const nameValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const form = control as ContactForm;
  if (form.controls.kind.value === 'organisation') {
    return form.controls.orgName.value.trim() ? null : { orgName: true };
  }
  return form.controls.givenNames.value.trim() || form.controls.familyName.value.trim() ? null : { personName: true };
};

/** The date of death is on or after the date of birth. */
const dateOrderValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const form = control as ContactForm;
  const born = parseDateInput(form.controls.dateOfBirth.value);
  const died = parseDateInput(form.controls.dateOfDeath.value);
  return born && died && died < born ? { dateOrder: true } : null;
};

export function createContactForm() {
  return new FormGroup(
    {
      kind: new FormControl<ContactKind>('person', { nonNullable: true }),
      givenNames: text(),
      familyName: text(),
      preferredName: text(),
      dateOfBirth: text('', [dateValidator]),
      dateOfDeath: text('', [dateValidator]),
      orgName: text(),
      abn: text('', [abnValidator]),
      emails: new FormArray<EmailGroup>([]),
      phones: new FormArray<PhoneGroup>([]),
      addresses: new FormArray<AddressGroup>([]),
      tags: text(),
      isReferrer: new FormControl(false, { nonNullable: true }),
      referrerCompany: text(),
      referrerIndustry: text(),
      notes: text(),
    },
    { validators: [nameValidator, dateOrderValidator] },
  );
}
export type ContactForm = ReturnType<typeof createContactForm>;

/** Fills the form from a stored contact (for editing). */
export function fillContactForm(form: ContactForm, contact: ContactListItem): void {
  form.patchValue({
    kind: contact.kind,
    givenNames: contact.givenNames ?? '',
    familyName: contact.familyName ?? '',
    preferredName: contact.preferredName ?? '',
    dateOfBirth: formatDateInput(contact.dateOfBirth),
    dateOfDeath: formatDateInput(contact.dateOfDeath),
    orgName: contact.orgName ?? '',
    abn: contact.abn ?? '',
    tags: contact.tags.join(', '),
    isReferrer: contact.isReferrer,
    referrerCompany: contact.referrerMeta?.company ?? '',
    referrerIndustry: contact.referrerMeta?.industry ?? '',
    notes: contact.notes ?? '',
  });
  form.controls.emails.clear();
  for (const email of contact.emails) form.controls.emails.push(emailGroup(email));
  form.controls.phones.clear();
  for (const phone of contact.phones) {
    const group = phoneGroup({ type: phone.type, number: phone.number });
    group.controls.type.markAsDirty();
    form.controls.phones.push(group);
  }
  form.controls.addresses.clear();
  for (const address of contact.addresses) {
    form.controls.addresses.push(addressGroup({ ...address, line2: address.line2 ?? '' }));
  }
}

/** What `contacts-create` takes as `contact` (and what an edit writes). */
export type ContactInput = ReturnType<typeof Contact.create.parse>;

/** Optional fields an edit may clear (deleted with `remove`). */
const CLEARABLE = [
  'givenNames',
  'familyName',
  'preferredName',
  'dateOfBirth',
  'dateOfDeath',
  'orgName',
  'abn',
  'referrerMeta',
  'notes',
] as const;

const optional = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The form as a contact: trimmed, phones in E.164, dates as DateOnly, the other kind's fields
 * dropped. Validated with `Contact.create`. Call only when the form is valid.
 */
export function contactFromForm(form: ContactForm): ContactInput {
  const value = form.getRawValue();
  const person = value.kind === 'person';
  const candidate: Record<string, unknown> = {
    kind: value.kind,
    givenNames: person ? optional(value.givenNames) : undefined,
    familyName: person ? optional(value.familyName) : undefined,
    preferredName: person ? optional(value.preferredName) : undefined,
    dateOfBirth: person ? (parseDateInput(value.dateOfBirth) ?? undefined) : undefined,
    dateOfDeath: person ? (parseDateInput(value.dateOfDeath) ?? undefined) : undefined,
    orgName: person ? undefined : optional(value.orgName),
    abn: person ? undefined : optional(value.abn.replace(/\s/g, '')),
    emails: value.emails.map((email) => ({ type: email.type, address: email.address.trim() })),
    phones: value.phones.map((phone) => ({ type: phone.type, number: normalisePhone(phone.number) ?? phone.number })),
    addresses: value.addresses.map((address) => ({
      type: address.type,
      line1: address.line1.trim(),
      line2: optional(address.line2),
      suburb: address.suburb.trim(),
      state: address.state,
      postcode: address.postcode.trim(),
      country: 'AU',
    })),
    tags: [
      ...new Set(
        value.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
    isReferrer: value.isReferrer,
    referrerMeta:
      value.isReferrer && (value.referrerCompany.trim() || value.referrerIndustry.trim())
        ? { company: value.referrerCompany.trim(), industry: value.referrerIndustry.trim() }
        : undefined,
    notes: optional(value.notes),
  };
  const defined = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
  return Contact.create.parse(defined);
}

/** The optional fields an edit cleared: they were set on the stored contact and are now empty. */
export function clearedFields(input: ContactInput, stored: ContactListItem): string[] {
  return CLEARABLE.filter(
    (field) => (input as Record<string, unknown>)[field] === undefined && stored[field] !== undefined,
  );
}

/** The duplicate probe for `contacts-findDuplicates`, from the contact about to be created. */
export function duplicateProbe(contact: ContactInput): DuplicateProbe {
  return {
    kind: contact.kind,
    ...(contact.givenNames ? { givenNames: contact.givenNames } : {}),
    ...(contact.familyName ? { familyName: contact.familyName } : {}),
    ...(contact.orgName ? { orgName: contact.orgName } : {}),
    ...(contact.abn ? { abn: contact.abn } : {}),
    ...(contact.dateOfBirth ? { dateOfBirth: contact.dateOfBirth } : {}),
    emails: contact.emails.map((email) => email.address),
    phones: contact.phones.map((phone) => phone.number),
  };
}

/**
 * Puts a refused create's field errors (`INVALID_ARGUMENT`, `details.fields` keyed like
 * `contact.familyName` or `contact.phones.0.number`) on the form's controls. Server messages are
 * for developers, so the controls get our own copy. Returns whether any field matched.
 */
export function applyServerFieldErrors(form: ContactForm, fields: Record<string, unknown>): boolean {
  let matched = false;
  for (const key of Object.keys(fields)) {
    const path = key.replace(/^contact\./, '');
    const control = form.get(path);
    if (!control || control instanceof FormGroup || control instanceof FormArray) continue;
    control.setErrors(/^phones\.\d+\.number$/.test(path) ? { phone: true } : { server: true });
    control.markAsTouched();
    matched = true;
  }
  return matched;
}
