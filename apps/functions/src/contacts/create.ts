import type { z } from 'zod';

import {
  Contact,
  contactDerivedFields,
  CreateContactInput,
  DomainError,
  normalisePhone,
  PERMISSIONS,
  type CreateContactResult,
  type FieldErrors,
} from '@materia/domain';

import { compact, contactsPath } from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

type ContactInput = z.output<typeof CreateContactInput>['contact'];

const trimmed = (value: string | undefined) => {
  const text = value?.trim();
  return text ? text : undefined;
};

/**
 * Normalises what the create form sent: trims names, re-validates phones as E.164 (the UI already
 * normalises them), drops repeated emails and numbers, and requires a name. Throws
 * INVALID_ARGUMENT with field paths.
 */
export function normaliseContact(contact: ContactInput): ContactInput {
  const fields: FieldErrors = {};
  const seenPhones = new Set<string>();
  const phones = contact.phones.flatMap((phone, index) => {
    const number = normalisePhone(phone.number);
    if (!number) {
      fields[`contact.phones.${index}.number`] = ['Enter a valid phone number'];
      return [];
    }
    if (seenPhones.has(number)) return [];
    seenPhones.add(number);
    return [{ ...phone, number }];
  });
  const seenEmails = new Set<string>();
  const emails = contact.emails.filter((email) => {
    const address = email.address.toLowerCase();
    if (seenEmails.has(address)) return false;
    seenEmails.add(address);
    return true;
  });
  const tags = [...new Set(contact.tags.map((tag) => tag.trim()).filter(Boolean))];
  const names = {
    givenNames: trimmed(contact.givenNames),
    familyName: trimmed(contact.familyName),
    preferredName: trimmed(contact.preferredName),
    orgName: trimmed(contact.orgName),
  };
  if (contact.kind === 'person' && !names.givenNames && !names.familyName) {
    fields['contact.familyName'] = ['Enter a name'];
  }
  if (contact.kind === 'organisation' && !names.orgName) fields['contact.orgName'] = ['Enter the organisation’s name'];
  if (Object.keys(fields).length) throw new DomainError('INVALID_ARGUMENT', 'Invalid contact', { fields });
  return compact({ ...contact, ...names, notes: trimmed(contact.notes), phones, emails, tags });
}

/**
 * `contacts-create` (CORE-01). Creates are callable-only (the rules let clients update whitelisted
 * fields, never create), so the server writes meta and the derived `search`, `dedupeKey` and
 * `sortName` from the start; `contacts-onWrite` keeps them current afterwards.
 */
export const createDefinition = {
  name: 'contacts-create',
  input: CreateContactInput,
  roles: PERMISSIONS['contact.edit'],
  idempotent: true,
  handler: async ({ input, uid, orgId, db, clock, requestId, log }): Promise<CreateContactResult> => {
    const contact = normaliseContact(input.contact);
    const now = clock.now();
    const ref = db.collection(contactsPath(orgId)).doc();
    const data = Contact.schema.parse(
      compact({
        ...contact,
        ...contactDerivedFields(contact),
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        schemaVersion: Contact.version,
        _requestId: requestId,
      }),
    );
    await ref.create(data);
    log.info('contact created', { contactId: ref.id, kind: contact.kind });
    return { contactId: ref.id };
  },
} satisfies CallableDefinition<typeof CreateContactInput, CreateContactResult>;

export const create = defineCallable(createDefinition);
