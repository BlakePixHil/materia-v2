import { domain } from '../domain.ts';
import { buildContact, emailEntry, parseAddress, phoneEntry } from './contact.ts';
import type { ReviewCode, TransformContext, TransformedRecord } from './context.ts';
import { createdAndUpdated } from './dates.ts';
import { cleanText, splitName } from './values.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { docId } from '../legacy/snapshot.ts';

const { referrerIndustryFromText } = domain;

/**
 * `referrers/*` → contacts with `isReferrer` (CORE-18; Legacy migration plan, Mapping). A referrer
 * with a `name` is a person (`company` goes in `referrerMeta.company`); one with only a `company`
 * is an organisation. Free-text industries map through `referrerIndustryFromText`. Phones become
 * E.164; a phone, email or address that doesn't read cleanly is kept in the contact's notes, so
 * nothing is lost. Referrers have no dates in older data: the export time stands in.
 */

export interface ReferrersResult {
  records: TransformedRecord[];
  /** Legacy referrer id (the document id, as cards' `referrerId` holds it) → v2 contact id. */
  contactIds: Map<string, string>;
}

export function mapReferrers(ctx: TransformContext, referrers: readonly ExportRecord[]): ReferrersResult {
  const records: TransformedRecord[] = [];
  const contactIds = new Map<string, string>();
  for (const { path, data } of referrers) {
    if (!data) continue;
    const record = mapReferrer(ctx, path, data);
    records.push(record);
    contactIds.set(docId(path), docId(record.path));
  }
  return { records, contactIds };
}

export function mapReferrer(ctx: TransformContext, path: string, data: Record<string, unknown>): TransformedRecord {
  const name = cleanText(data['name']);
  const company = cleanText(data['company']);
  const review: ReviewCode[] = [];
  const kept: string[] = [];

  let names: { kind: 'person' | 'organisation'; givenNames?: string; familyName?: string; orgName?: string };
  if (name) names = { kind: 'person', ...splitName(name) };
  else if (company) names = { kind: 'organisation', orgName: company };
  else {
    names = { kind: 'organisation', orgName: 'Unnamed referrer (imported)' };
    review.push('referrer_unnamed');
    ctx.warnings.add('MIG_W_REFERRER_UNNAMED', path);
  }

  const phoneText = cleanText(data['phone']);
  const phone = phoneText ? phoneEntry(phoneText) : null;
  if (phoneText && !phone) {
    ctx.warnings.add('MIG_W_PHONE_INVALID', path);
    kept.push(`Phone (imported): ${phoneText}`);
  }
  const emailText = cleanText(data['email']);
  const email = emailText ? emailEntry(emailText, 'work') : null;
  if (emailText && !email) {
    ctx.warnings.add('MIG_W_EMAIL_INVALID', path);
    kept.push(`Email (imported): ${emailText}`);
  }
  const addressText = cleanText(data['address']);
  const address = addressText ? parseAddress(addressText, 'business') : null;
  if (addressText && !address) {
    ctx.warnings.add('MIG_W_ADDRESS_UNPARSED', path);
    kept.push(`Address (imported): ${addressText}`);
  }

  const industry = referrerIndustryFromText(cleanText(data['industry']));
  const hasDates = [data['createdOn'], data['updatedOn']].some(
    (value) => value !== undefined && value !== null && value !== '',
  );
  if (!hasDates) ctx.warnings.add('MIG_W_REFERRER_NO_TIMESTAMPS', path);
  const { createdAt, updatedAt } = hasDates
    ? createdAndUpdated(ctx, data, path)
    : { createdAt: ctx.asOf, updatedAt: ctx.asOf };

  return buildContact(ctx, {
    legacyPath: path,
    ...names,
    emails: email ? [email] : [],
    phones: phone ? [phone] : [],
    addresses: address ? [address] : [],
    isReferrer: true,
    referrerMeta: {
      ...(name && company ? { company } : {}),
      ...(industry ? { industry } : {}),
    },
    ...(kept.length ? { notes: kept.join('\n') } : {}),
    createdAt,
    updatedAt,
    needsReview: review,
  });
}
