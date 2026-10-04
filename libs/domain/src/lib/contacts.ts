import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import { Contact } from './schemas/contacts-matters';
import { normaliseText, searchTokens, searchWords } from './search';

/**
 * Contacts (CORE-01): display names, phone and address normalisation, search tokens, the
 * duplicate scorer, and the callable inputs. Shared by the web app and Functions.
 */

type ContactNames = Pick<Contact, 'kind' | 'givenNames' | 'familyName' | 'preferredName' | 'orgName'>;

/** "Preferred Family", "Given Family", a mononym, or the organisation's name. */
export function contactDisplayName(contact: Partial<ContactNames>): string {
  if (contact.kind === 'organisation') return contact.orgName?.trim() || 'Unnamed organisation';
  const given = (contact.preferredName || contact.givenNames || '').trim();
  const family = (contact.familyName || '').trim();
  return [given, family].filter(Boolean).join(' ') || 'Unnamed contact';
}

/** Two-letter initials for avatars. */
export function contactInitials(contact: Partial<ContactNames>): string {
  const words = contactDisplayName(contact).split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => (word ?? '').charAt(0).toUpperCase()).join('');
}

// ---------- phones ----------

export type PhoneType = 'mobile' | 'home' | 'work' | 'other';

/**
 * Normalises a typed phone number to E.164, reading local numbers as Australian
 * (`0412 345 678` → `+61412345678`, `(02) 9876 5432` → `+61298765432`). International numbers
 * keep their country code. Returns null when it isn't a valid number.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed.replace(/^00/, '+'), 'AU');
  return parsed?.isValid() ? parsed.number : null;
}

/** An Australian mobile (`+614…`) is a mobile; anything else defaults to home. */
export function guessPhoneType(e164: string): PhoneType {
  return e164.startsWith('+614') ? 'mobile' : 'home';
}

/** `+61412345678` → `0412 345 678`; international numbers stay in international format. */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === 'AU' ? parsed.formatNational() : parsed.formatInternational();
}

// ---------- addresses ----------

export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;
export type AuState = (typeof AU_STATES)[number];

/** Australia Post postcode ranges per state (a sanity check, not a lookup). */
const POSTCODE_RANGES: Record<AuState, [number, number][]> = {
  NSW: [
    [1000, 2599],
    [2619, 2899],
    [2921, 2999],
  ],
  ACT: [
    [200, 299],
    [2600, 2618],
    [2900, 2920],
  ],
  VIC: [
    [3000, 3999],
    [8000, 8999],
  ],
  QLD: [
    [4000, 4999],
    [9000, 9999],
  ],
  SA: [[5000, 5999]],
  WA: [
    [6000, 6797],
    [6800, 6999],
  ],
  TAS: [[7000, 7999]],
  NT: [[800, 999]],
};

/** Whether a four-digit postcode falls in the state's ranges. */
export function postcodeMatchesState(state: string, postcode: string): boolean {
  if (!/^\d{4}$/.test(postcode)) return false;
  const ranges = POSTCODE_RANGES[state as AuState];
  if (!ranges) return false;
  const value = Number(postcode);
  return ranges.some(([from, to]) => value >= from && value <= to);
}

// ---------- search and dedupe keys ----------

/** The texts a contact is found by: names, organisation, emails, phone digits, ABN. */
export function contactSearchTokens(contact: Partial<Contact>): string[] {
  return searchTokens(
    contact.familyName,
    contact.givenNames,
    contact.preferredName,
    contact.orgName,
    ...(contact.emails ?? []).map((email) => email.address.split('@')[0]),
    ...(contact.phones ?? []).map((phone) => phone.number.replace(/^\+61/, '0')),
    contact.abn,
  );
}

const ORG_SUFFIXES = new Set(['pty', 'ltd', 'limited', 'inc', 'co', 'the', 'and', 'trust', 'trustee', 'as']);

/** An organisation name without "Pty Ltd" and similar, for comparing. */
export function normaliseOrgName(name: string): string {
  return searchWords(name)
    .filter((word) => !ORG_SUFFIXES.has(word))
    .join(' ');
}

/**
 * A coarse key for exact-duplicate lookups: sorted normalised name words (so "Smith John" and
 * "John Smith" agree) plus the date of birth, or the organisation's normalised name or ABN.
 */
export function contactDedupeKey(contact: Partial<Contact>): string {
  if (contact.kind === 'organisation') {
    return contact.abn ? `abn:${contact.abn}` : `org:${normaliseOrgName(contact.orgName ?? '')}`;
  }
  const words = [...searchWords(contact.givenNames), ...searchWords(contact.familyName)].sort();
  return `person:${words.join(' ')}|${contact.dateOfBirth ?? ''}`;
}

/** What `orderBy('sortName')` sorts on: the display name, lower-cased, diacritics stripped. */
export function contactSortName(contact: Partial<Contact>): string {
  return normaliseText(contactDisplayName(contact));
}

/** The server-maintained fields of a contact (`contacts-onWrite` and `contacts-create` write them). */
export interface ContactDerived {
  search: string[];
  dedupeKey: string;
  sortName: string;
}

export function contactDerivedFields(contact: Partial<Contact>): ContactDerived {
  return {
    search: contactSearchTokens(contact),
    dedupeKey: contactDedupeKey(contact),
    sortName: contactSortName(contact),
  };
}

// ---------- duplicate scoring ----------

/** Jaro-Winkler similarity (0–1) of two strings. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, b.length);
    for (let j = from; j < to; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** What `contacts-findDuplicates` compares: the names and identifiers typed into the create form. */
export const DuplicateProbeSchema = z.object({
  kind: z.enum(['person', 'organisation']).default('person'),
  givenNames: z.string().max(200).optional(),
  familyName: z.string().max(200).optional(),
  orgName: z.string().max(200).optional(),
  abn: z.string().max(20).optional(),
  dateOfBirth: z.string().max(10).optional(),
  emails: z.array(z.string().max(320)).max(10).default([]),
  phones: z.array(z.string().max(30)).max(10).default([]),
});
export type DuplicateProbe = z.input<typeof DuplicateProbeSchema>;

/** The fields of a stored contact the scorer reads. */
export type DuplicateCandidate = Pick<
  Contact,
  'kind' | 'givenNames' | 'familyName' | 'preferredName' | 'orgName' | 'abn' | 'dateOfBirth' | 'emails' | 'phones'
>;

export type DuplicateReason = 'name' | 'dateOfBirth' | 'email' | 'phone' | 'abn';

export interface DuplicateScore {
  /** 0–1. */
  score: number;
  reasons: DuplicateReason[];
}

/** Candidates at or above this score are offered as "Use existing". */
export const DUPLICATE_THRESHOLD = 0.75;

function wordsOf(value: string | undefined): string {
  return searchWords(value).join(' ');
}

/**
 * Name similarity for people: given and family names compared part by part, also with the order
 * swapped ("Smith John"), taking the better. A mononym compares against either part.
 */
export function personNameSimilarity(
  a: { givenNames?: string | undefined; familyName?: string | undefined },
  b: { givenNames?: string | undefined; familyName?: string | undefined; preferredName?: string | undefined },
): number {
  const aGiven = wordsOf(a.givenNames);
  const aFamily = wordsOf(a.familyName);
  const bFamily = wordsOf(b.familyName);
  const bGivens = [wordsOf(b.givenNames), wordsOf(b.preferredName)].filter(Boolean);
  if (!bGivens.length) bGivens.push('');
  const pair = (given: string, family: string, otherGiven: string, otherFamily: string): number => {
    if (!given && !otherGiven) return jaroWinkler(family, otherFamily);
    if (!family && !otherFamily) return jaroWinkler(given, otherGiven);
    // First given name only, so a middle name on one side doesn't sink the match.
    const firstGiven = given.split(' ')[0] ?? '';
    const otherFirstGiven = otherGiven.split(' ')[0] ?? '';
    return 0.55 * jaroWinkler(family, otherFamily) + 0.45 * jaroWinkler(firstGiven, otherFirstGiven);
  };
  let best = 0;
  for (const bGiven of bGivens) {
    best = Math.max(best, pair(aGiven, aFamily, bGiven, bFamily), pair(aFamily, aGiven, bGiven, bFamily));
    // A mononym on one side: compare it with the other side's whole name.
    if (!aGiven || !aFamily) {
      const single = aGiven || aFamily;
      best = Math.max(best, jaroWinkler(single, bGiven), jaroWinkler(single, bFamily));
    }
  }
  return best;
}

/** Dates of birth a typo apart: one digit wrong, two adjacent digits swapped, or day and month swapped. */
export function nearDate(a: string, b: string): boolean {
  if (a.length !== 10 || b.length !== 10 || a === b) return false;
  const differing: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing.push(i);
  if (differing.length === 1) return true;
  const [first = 0, second = 0] = differing;
  if (differing.length === 2 && second === first + 1 && a[first] === b[second] && a[second] === b[first]) return true;
  const [ay, am, ad] = a.split('-');
  const [by, bm, bd] = b.split('-');
  return ay === by && am === bd && ad === bm;
}

const digits = (value: string) => value.replace(/\D/g, '');

/** Scores a stored contact against what was typed (CORE-01 duplicate detection). */
export function scoreDuplicate(probeInput: DuplicateProbe, candidate: DuplicateCandidate): DuplicateScore {
  const probe = DuplicateProbeSchema.parse(probeInput);
  const reasons: DuplicateReason[] = [];
  const emails = new Set(probe.emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const phones = new Set(
    probe.phones.map((phone) => normalisePhone(phone) ?? digits(phone)).filter((phone) => phone.length >= 6),
  );
  const emailMatch = (candidate.emails ?? []).some((email) => emails.has(email.address.toLowerCase()));
  const phoneMatch = (candidate.phones ?? []).some((phone) => phones.has(phone.number));
  if (emailMatch) reasons.push('email');
  if (phoneMatch) reasons.push('phone');

  if (probe.kind === 'organisation' || candidate.kind === 'organisation') {
    if (probe.kind !== candidate.kind) {
      const score = emailMatch || phoneMatch ? 0.5 : 0;
      return { score, reasons };
    }
    const abnMatch = !!probe.abn && digits(probe.abn) === candidate.abn;
    if (abnMatch) reasons.push('abn');
    const similarity = jaroWinkler(normaliseOrgName(probe.orgName ?? ''), normaliseOrgName(candidate.orgName ?? ''));
    if (similarity >= 0.9) reasons.unshift('name');
    const score = Math.min(
      1,
      similarity * 0.7 + (abnMatch ? 0.6 : 0) + (emailMatch ? 0.3 : 0) + (phoneMatch ? 0.3 : 0),
    );
    return { score: round(score), reasons };
  }

  const similarity = personNameSimilarity(probe, candidate);
  const dob = probe.dateOfBirth && candidate.dateOfBirth;
  const dobExact = !!dob && probe.dateOfBirth === candidate.dateOfBirth;
  const dobNear = !!dob && nearDate(probe.dateOfBirth ?? '', candidate.dateOfBirth ?? '');
  const dobConflict = !!dob && !dobExact && !dobNear;
  if (similarity >= 0.88) reasons.unshift('name');
  if (dobExact || dobNear) reasons.push('dateOfBirth');
  let score =
    similarity * 0.75 + (dobExact ? 0.25 : dobNear ? 0.15 : 0) + (emailMatch ? 0.35 : 0) + (phoneMatch ? 0.3 : 0);
  // Two different dates of birth and nothing else in common: likely relatives, not the same person.
  if (dobConflict && !emailMatch && !phoneMatch) score -= 0.2;
  return { score: round(Math.max(0, Math.min(1, score))), reasons };
}

const round = (value: number) => Math.round(value * 100) / 100;

// ---------- callable inputs ----------

const RequestId = z.uuid();

/** `contacts-create`: the contact's fields (`search` and `dedupeKey` are the trigger's). */
export const CreateContactInput = z.object({ requestId: RequestId, contact: Contact.create });
/** `contacts-findDuplicates`. */
export const FindDuplicatesInput = DuplicateProbeSchema;
/** `contacts-merge` (admin and owner): `mergeId` becomes a tombstone pointing at `keepId`. */
export const MergeContactsInput = z
  .object({ requestId: RequestId, keepId: DocIdSchema, mergeId: DocIdSchema })
  .refine((input) => input.keepId !== input.mergeId, { message: 'Pick two different contacts', path: ['mergeId'] });
/** `contacts-delete`: soft delete, refused while matters reference the contact. */
export const DeleteContactInput = z.object({ requestId: RequestId, contactId: DocIdSchema });

export interface CreateContactResult {
  contactId: string;
}
export interface DuplicateMatch extends DuplicateScore {
  contactId: string;
  displayName: string;
  dateOfBirth?: string;
  email?: string;
  phone?: string;
}
export interface FindDuplicatesResult {
  matches: DuplicateMatch[];
}
export interface MergeContactsResult {
  /** References re-pointed in the call itself. */
  repointed: number;
  /** True when the rest is still being re-pointed by queued tasks (large fan-outs). */
  queued: boolean;
}
export interface DeleteContactResult {
  deleted: boolean;
}
/**
 * Why a delete was refused (`details.references` on the FAILED_PRECONDITION error, with
 * `details.reason: 'contact_referenced'`): the matters that still reference the contact. `role`
 * is a party role (`executor`…) or `client`, `referrer`, `deceased`, `testator`. A safe custody
 * packet is listed with `role: 'safe_custody'`, its `safeCustodyId`, an empty `matterId` and the
 * packet number as `matterTitle`.
 */
export interface ContactReference {
  matterId: string;
  matterTitle: string;
  role: string;
  safeCustodyId?: string;
}
