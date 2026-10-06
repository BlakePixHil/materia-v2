import type { Firestore, Transaction } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  changedKeyFacts,
  CitationSchema,
  FACT_CITATIONS_MAX,
  FactCitation,
  keyFactValue,
  type Citation,
  type FactMatter,
  type KeyFactId,
} from '@materia/domain';

import { matterPath } from './shared';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import type { TxJoin } from '../core/tx-join';
import type { Clock } from '../ports';

/**
 * Key fact citations (CORE-06a, ADR-049): accepting a Clerk `key_fact` suggestion keeps what Clerk
 * cited with the fact, in `matters/{matterId}/factCitations/{factId}`, and a later change to the
 * fact deletes them (`matters-denormalise`). A citation record stands for the value it was kept
 * with, so readers show it only while the fact still has that value (`keyFactCitations`).
 */

export const factCitationPath = (orgId: string, matterId: string, factId: KeyFactId): string =>
  `${matterPath(orgId, matterId)}/factCitations/${factId}`;

/** What accepting a key-fact suggestion knows about its sources. */
export interface FactSource {
  db: Firestore;
  orgId: string;
  matterId: string;
  uid: string;
  requestId: string;
  clock: Clock;
  /** The fact and the value it is being set to (the edited payload's, when the person edited it). */
  field: KeyFactId;
  value: string | number;
  suggestion: {
    id: string;
    privileged: boolean;
    citations: readonly unknown[];
    /** The payload Clerk proposed, before any edit. */
    proposed: Readonly<Record<string, unknown>>;
  };
}

/**
 * The citations to keep: Clerk's, when the fact gets exactly the value Clerk proposed. A person who
 * changed the value before accepting keeps none, since the sources may not say what they wrote.
 */
export function keptCitations(source: FactSource): Citation[] {
  const { proposed } = source.suggestion;
  if (proposed['field'] !== source.field || proposed['value'] !== source.value) return [];
  const parsed = z.array(CitationSchema).safeParse(source.suggestion.citations);
  return parsed.success ? parsed.data.slice(0, FACT_CITATIONS_MAX) : [];
}

/**
 * Joins keeping the citations to the transaction that sets the fact: wraps the accept's join, so the
 * fact, its citations and the suggestion's resolution commit together (or not at all). It re-reads
 * the cited documents with the other reads: the record is privileged when the suggestion is or a
 * cited document now is, so roles without `privileged.view` never read its quotes. Without
 * citations to keep, the join is returned as is (an earlier record for another value is deleted
 * by `matters-denormalise` once the fact changes).
 */
export function keepFactCitations(join: TxJoin, source: FactSource): TxJoin {
  const citations = keptCitations(source);
  if (!citations.length) return join;
  const { db, orgId, matterId } = source;
  const documentIds = [
    ...new Set(citations.flatMap((cite) => (cite.kind === 'document' && cite.documentId ? [cite.documentId] : []))),
  ];
  let privileged = source.suggestion.privileged;
  return {
    async read(tx: Transaction) {
      await join.read(tx);
      const docs = await Promise.all(
        documentIds.map((id) => tx.get(db.doc(`${matterPath(orgId, matterId)}/documents/${id}`))),
      );
      privileged = source.suggestion.privileged || docs.some((doc) => doc.get('privileged') === true);
    },
    write(tx: Transaction, resultRef: string) {
      join.write(tx, resultRef);
      const now = source.clock.now();
      const record = FactCitation.schema.parse({
        factId: source.field,
        value: source.value,
        citations,
        suggestionId: source.suggestion.id,
        privileged,
        createdAt: now,
        createdBy: source.uid,
        updatedAt: now,
        updatedBy: source.uid,
        schemaVersion: FactCitation.version,
        _requestId: source.requestId,
      });
      tx.set(db.doc(factCitationPath(orgId, matterId, source.field)), record);
    },
  };
}

/**
 * Deletes the citations of the key facts a matter write changed (part of `matters-denormalise`):
 * they supported the old value, so a person's edit clears them. Re-reads the matter and the records
 * in a transaction and deletes only those whose value the fact no longer has, so an accept that
 * just set the fact with new citations keeps them, whatever order the events arrive in. Leaves a
 * destroyed matter's tombstone alone (CORE-19: the destroy job deletes the subcollection).
 */
export async function clearStaleFactCitations(change: TriggerChange, ctx: TriggerContext): Promise<KeyFactId[]> {
  const before = change.before?.data() as FactMatter | undefined;
  const after = change.after?.data() as FactMatter | undefined;
  if (!before || !after) return [];
  const changed = changedKeyFacts(before, after);
  if (!changed.length) return [];
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const matterRef = ctx.db.doc(matterPath(orgId, matterId));
  const refs = changed.map((id) => ctx.db.doc(factCitationPath(orgId, matterId, id)));
  const cleared = await ctx.db.runTransaction(async (tx) => {
    const matter = await tx.get(matterRef);
    if (!matter.exists || matter.get('destroyedAt')) return [];
    const records = await Promise.all(refs.map((ref) => tx.get(ref)));
    const current = matter.data() as FactMatter;
    return changed.filter((id, i) => {
      const record = records[i];
      if (!record?.exists || keyFactValue(current, id) === record.get('value')) return false;
      tx.delete(refs[i] as (typeof refs)[number]);
      return true;
    });
  });
  if (cleared.length) ctx.log.info('key fact citations cleared', { matterId, facts: cleared });
  return cleared;
}
