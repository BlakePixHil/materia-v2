import { domain } from '../domain.ts';
import { migratedMeta, migId, type ReviewCode, type TransformContext, type TransformedRecord } from './context.ts';

const { contactDerivedFields, EmailSchema, guessPhoneType, normalisePhone, AU_STATES } = domain;

/** Builds a migrated contact (CORE-01) with the fields `contacts-onWrite` would derive. */

export interface ContactInput {
  legacyPath: string;
  kind: 'person' | 'organisation';
  givenNames?: string;
  familyName?: string;
  orgName?: string;
  emails?: { type: 'personal' | 'work' | 'other'; address: string }[];
  phones?: { type: 'mobile' | 'home' | 'work' | 'other'; number: string }[];
  addresses?: Record<string, unknown>[];
  tags?: string[];
  isReferrer?: boolean;
  referrerMeta?: { company?: string; industry?: string };
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  needsReview?: ReviewCode[];
}

export function contactPath(ctx: TransformContext, id: string): string {
  return `orgs/${ctx.orgId}/contacts/${id}`;
}

export function buildContact(ctx: TransformContext, input: ContactInput): TransformedRecord {
  const id = migId(input.legacyPath);
  const fields = {
    kind: input.kind,
    ...(input.givenNames ? { givenNames: input.givenNames } : {}),
    ...(input.familyName ? { familyName: input.familyName } : {}),
    ...(input.orgName ? { orgName: input.orgName } : {}),
    emails: input.emails ?? [],
    phones: input.phones ?? [],
    addresses: input.addresses ?? [],
    tags: [...new Set(input.tags ?? [])].sort(),
    isReferrer: input.isReferrer ?? false,
    ...(input.referrerMeta && Object.keys(input.referrerMeta).length ? { referrerMeta: input.referrerMeta } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    matterRoles: [],
  };
  return {
    entity: 'contacts',
    path: contactPath(ctx, id),
    legacyPath: input.legacyPath,
    data: {
      ...fields,
      ...contactDerivedFields(fields as unknown as Parameters<typeof contactDerivedFields>[0]),
      ...migratedMeta(ctx, {
        legacyPath: input.legacyPath,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        by: ctx.uid,
        ...(input.needsReview ? { needsReview: input.needsReview } : {}),
      }),
    },
  };
}

/** The display name a contact record shows (for matter search tokens). */
export function contactName(record: TransformedRecord): string {
  return domain.contactDisplayName((record.data ?? {}) as Parameters<typeof domain.contactDisplayName>[0]);
}

/** A typed phone as an E.164 phone entry, or null when it isn't a valid number. */
export function phoneEntry(raw: string): { type: 'mobile' | 'home'; number: string } | null {
  const number = normalisePhone(raw);
  return number ? { type: guessPhoneType(number) === 'mobile' ? 'mobile' : 'home', number } : null;
}

/** A typed email as an email entry, or null when it isn't valid. */
export function emailEntry(
  raw: string,
  type: 'personal' | 'work' | 'other',
): { type: typeof type; address: string } | null {
  const parsed = EmailSchema.safeParse({ type, address: raw.trim() });
  return parsed.success ? { type, address: parsed.data.address } : null;
}

const STATES = AU_STATES.join('|');
/**
 * `1 Example St, Geelong VIC 3220` (or `Geelong, VIC 3220`, and an optional `, Australia`): line(s),
 * suburb, state, postcode.
 */
const ADDRESS = new RegExp(
  `^(.+?),\\s*([^,]+?)(?:\\s*,\\s*|\\s+)(${STATES})\\s+(\\d{4})(?:\\s*,?\\s*australia)?$`,
  'i',
);

/** A one-line Australian address split into its parts, or null when it doesn't read as one. */
export function parseAddress(
  raw: string,
  type: 'residential' | 'postal' | 'business' | 'other',
): Record<string, unknown> | null {
  const match = ADDRESS.exec(raw.replace(/\s+/g, ' ').trim());
  if (!match) return null;
  const [line1, ...rest] = (match[1] ?? '').split(',').map((part) => part.trim());
  if (!line1) return null;
  return {
    type,
    line1,
    ...(rest.filter(Boolean).length ? { line2: rest.filter(Boolean).join(', ') } : {}),
    suburb: (match[2] ?? '').trim(),
    state: (match[3] ?? '').toUpperCase(),
    postcode: match[4] ?? '',
    country: 'AU',
  };
}
