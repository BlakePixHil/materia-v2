import * as z from 'zod';

import {
  Contact,
  contactPassesFilters,
  Matter,
  Party,
  searchQueryToken,
  SoftDeleteShape,
  type PartyRole,
  type ReferrerIndustry,
} from '@materia/domain';

import type { QuerySpec, WhereOp } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

const contact = Contact.schema.shape;

/**
 * What the contacts screen reads from `orgs/{orgId}/contacts/{id}` (CORE-01): the fields it shows
 * and filters by, validated by the `libs/domain` Contact schema. Other fields (`search`,
 * `dedupeKey`) are dropped, not rejected. `sortName` is server-maintained (the lower-cased display
 * name) and orders the list; it's optional here until the domain schema carries it.
 */
export const ContactListItemSchema = /* @__PURE__ */ z.object({
  kind: contact.kind,
  givenNames: contact.givenNames,
  familyName: contact.familyName,
  preferredName: contact.preferredName,
  dateOfBirth: contact.dateOfBirth,
  dateOfDeath: contact.dateOfDeath,
  orgName: contact.orgName,
  abn: contact.abn,
  emails: contact.emails,
  phones: contact.phones,
  addresses: contact.addresses,
  tags: contact.tags,
  isReferrer: contact.isReferrer,
  referrerMeta: contact.referrerMeta,
  notes: contact.notes,
  mergedInto: contact.mergedInto,
  /** Roles on live, unprivileged matters (CORE-01a), server-maintained; empty until the backfill reaches it. */
  matterRoles: contact.matterRoles,
  sortName: z.string().optional(),
  createdAt: contact.createdAt.optional(),
  createdBy: contact.createdBy.optional(),
  updatedAt: contact.updatedAt.optional(),
  updatedBy: contact.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type ContactListItem = z.infer<typeof ContactListItemSchema>;

/** The list's filters. At most one becomes a Firestore filter; the others apply to the loaded rows. */
export interface ContactFilters {
  /** What was typed in the search box. */
  query?: string;
  kind?: 'person' | 'organisation' | null;
  tag?: string | null;
  /** Only contacts who refer work to the practice. */
  referrersOnly?: boolean;
  /** Referrers in this industry (CORE-18); implies `referrersOnly`. */
  industry?: ReferrerIndustry | null;
  /** Contacts holding this role on a live, unprivileged matter (CORE-01a: "Role in matters"). */
  role?: PartyRole | null;
}

export const CONTACT_PAGE_SIZE = 50;

/**
 * The Firestore query for the contacts list, ordered by `sortName`. Firestore allows one
 * `array-contains` per query and each combination needs its own composite index, so the query
 * carries one filter, in this order: the search token, role in matters, kind, referrer, tag.
 * Indexes (contacts): (search array-contains, sortName), (matterRoles array-contains, sortName),
 * (kind, sortName), (isReferrer, sortName), (tags array-contains, sortName).
 * `contactMatchesFilters` applies the rest.
 */
export function contactListQuery(
  filters: ContactFilters = {},
  pageSize = CONTACT_PAGE_SIZE,
): QuerySpec<ContactListItem> {
  const token = searchQueryToken(filters.query ?? '');
  let where: readonly [string, WhereOp, unknown] | null = null;
  if (token) where = ['search', 'array-contains', token];
  else if (filters.role) where = ['matterRoles', 'array-contains', filters.role];
  else if (filters.kind) where = ['kind', '==', filters.kind];
  else if (filters.referrersOnly || filters.industry) where = ['isReferrer', '==', true];
  else if (filters.tag) where = ['tags', 'array-contains', filters.tag];
  const spec: QuerySpec = { ...(where ? { where: [where] } : {}), orderBy: [['sortName', 'asc']], pageSize };
  return spec as QuerySpec<ContactListItem>;
}

/**
 * Whether a loaded contact passes every filter (the ones the query couldn't carry, and every word
 * of a multi-word search). Tombstones of merged contacts never show. The same check decides what
 * the list's CSV export holds (`contactPassesFilters`, INS-03).
 */
export function contactMatchesFilters(row: ContactListItem, filters: ContactFilters = {}): boolean {
  return contactPassesFilters(row, {
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.referrersOnly ? { referrersOnly: true } : {}),
    ...(filters.industry ? { industry: filters.industry } : {}),
    ...(filters.role ? { role: filters.role } : {}),
  });
}

/**
 * The contacts repository (CORE-01): live lists and documents, and client-direct edits of the
 * whitelisted fields (`Contact.update`; `search`, `dedupeKey`, `mergedInto` and `sortName` are
 * server-owned). Creates, deletes and merges go through the `contacts-*` callables.
 */
export function contactsRepository(): Repository<ContactListItem> {
  return repo((orgId) => `orgs/${orgId}/contacts`, {
    schema: ContactListItemSchema,
    version: Contact.version,
    create: Contact.create,
    update: Contact.update,
  });
}

const party = Party.schema.shape;

/** A contact's role on a matter, from the `parties` collection group (orgId and matterId are server-set). */
export const ContactPartySchema = /* @__PURE__ */ z.object({
  contactId: party.contactId,
  role: party.role,
  share: party.share,
  matterId: party.matterId,
  orgId: party.orgId,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type ContactParty = z.infer<typeof ContactPartySchema>;

/**
 * Every matter role a contact holds in the active org: a collection-group query on `parties`
 * (`orgId == org` is added by `groupRepo`). Index: parties collection group (orgId, contactId).
 */
export function contactPartiesRepository(): GroupRepository<ContactParty> {
  return groupRepo('parties', { schema: ContactPartySchema, version: Party.version });
}

/** The parties of one contact (at most 100 matters; enough for the detail pane). */
export function contactPartiesQuery(contactId: string): QuerySpec<ContactParty> {
  return { where: [['contactId', '==', contactId]], pageSize: 100 };
}

const matter = Matter.schema.shape;

/** What a matter link shows: its number, title, type and status. */
export const MatterSummarySchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterSummary = z.infer<typeof MatterSummarySchema>;

/** Matters, read for their number and title only (the contacts screen's "Matters" list). */
export function matterSummariesRepository(): Repository<MatterSummary> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: MatterSummarySchema, version: Matter.version });
}

/**
 * A matter in a referrer's "Referrals" section (CORE-18): what it is, where it is, when it came in,
 * and its budget (BILL-05), whose `billedCents` the section totals for billing.view roles.
 */
export const ReferredMatterSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  privileged: matter.privileged,
  referrerContactId: matter.referrerContactId,
  createdAt: matter.createdAt.optional(),
  closedAt: matter.closedAt,
  budget: matter.budget,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type ReferredMatter = z.infer<typeof ReferredMatterSchema>;

/** The most matters a referrer's section reads (newest first, sorted here). */
export const REFERRED_MATTERS_LIMIT = 200;

/**
 * The live matters a contact referred (`referrerContactId == id`). Equality filters only, so
 * Firestore serves it from single-field indexes; sorted here. Without `privileged.view` the rules
 * allow only queries that prove `privileged == false`.
 */
export function referredMattersQuery(contactId: string, privilegedVisible: boolean): QuerySpec<ReferredMatter> {
  return {
    where: [
      ['referrerContactId', '==', contactId],
      ['deletedAt', '==', null],
      ...(privilegedVisible ? [] : [['privileged', '==', false] as const]),
    ],
    pageSize: REFERRED_MATTERS_LIMIT,
  };
}

/** Matters as a referrer's history reads them (CORE-18). */
export function referredMattersRepository(): Repository<ReferredMatter> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: ReferredMatterSchema, version: Matter.version });
}
