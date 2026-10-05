import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

import {
  basisDocumentIds,
  partyDocId,
  suggestionBasis,
  suggestionBasisParts,
  suggestionMetricKeys,
  sourcesPrivileged,
  type Basis,
  type BasisSources,
  type PartyRole,
  type SuggestionKind,
  type SuggestionOutcome,
} from '@materia/domain';

import { meteringPeriod } from '../clerk/features';
import type { Log } from '../core/log';
import { matterPath } from '../matters/shared';

/** Shared helpers for Clerk suggestions (AI-07, ADR-037). */

export type Data = Record<string, unknown>;

export const suggestionsPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/suggestions`;
export const suggestionPath = (orgId: string, matterId: string, id: string) =>
  `${suggestionsPath(orgId, matterId)}/${id}`;

/** The actor proposals and the expiry sweep write as (the audit trigger's `clerk` and `system`). */
export const CLERK_ACTOR = 'clerk';
export const SYSTEM_ACTOR = 'system';

/** Reads through a transaction, or directly. */
export interface Reader {
  doc(ref: DocumentReference): Promise<DocumentSnapshot>;
  query(query: Query): Promise<QuerySnapshot>;
}

export const txReader = (tx: Transaction): Reader => ({
  doc: (ref) => tx.get(ref),
  query: (query) => tx.get(query),
});

export const directReader: Reader = {
  doc: (ref) => ref.get(),
  query: (query) => query.get(),
};

/** What a suggestion's basis needs: its kind, payload and citations. */
export interface BasisSubject {
  kind: SuggestionKind;
  payload: unknown;
  citations?: readonly { documentId: string }[] | undefined;
}

const isLiveData = (data: Data | undefined) =>
  !!data && (data['deletedAt'] === undefined || data['deletedAt'] === null);

/**
 * Reads what a suggestion's basis covers (`suggestionBasisParts`), given the matter already read:
 * cited and targeted documents, a party suggestion's row, an event suggestion's live events of
 * its kind. Read in the accept transaction, so the check and the write see the same data.
 */
export async function readBasisSources(
  read: Reader,
  db: Firestore,
  orgId: string,
  matterId: string,
  matter: Data,
  subject: BasisSubject,
): Promise<BasisSources> {
  const base = matterPath(orgId, matterId);
  const documents: Record<string, Data | undefined> = {};
  for (const id of basisDocumentIds(subject)) {
    const snap = await read.doc(db.doc(`${base}/documents/${id}`));
    documents[id] = snap.exists ? (snap.data() as Data) : undefined;
  }
  const p = (subject.payload ?? {}) as Data;
  const sources: BasisSources = { matter, documents };
  if (subject.kind === 'party') {
    const snap = await read.doc(
      db.doc(`${base}/parties/${partyDocId(p['role'] as PartyRole, String(p['contactId']))}`),
    );
    sources.party = snap.exists ? (snap.data() as Data) : undefined;
  }
  if (subject.kind === 'event') {
    const snap = await read.query(db.collection(`${base}/events`).where('kind', '==', p['kind']));
    sources.events = snap.docs
      .filter((doc) => isLiveData(doc.data() as Data))
      .map((doc) => ({ id: doc.id, date: String(doc.get('date') ?? '') }));
  }
  return sources;
}

/** A suggestion's basis now, and whether its sources make it privileged. */
export async function currentBasis(
  read: Reader,
  db: Firestore,
  orgId: string,
  matterId: string,
  matter: Data,
  subject: BasisSubject,
): Promise<Basis & { privileged: boolean }> {
  const sources = await readBasisSources(read, db, orgId, matterId, matter, subject);
  return {
    ...suggestionBasis(suggestionBasisParts(subject, sources)),
    privileged: sourcesPrivileged(subject, sources),
  };
}

/** One outcome to count in the org's Clerk metrics. */
export interface MetricEntry {
  kind: SuggestionKind;
  promptId: string;
  promptVersion: string;
  outcome: SuggestionOutcome;
}

/**
 * Adds outcomes to the org's monthly Clerk metrics (`metrics/clerk-{YYYY-MM}`, the AI-02 metering
 * document): `suggestions.{outcome}`, per kind and per prompt version, for acceptance rates (the
 * evals and AI-13). Best effort: a failure is logged, never fails the action it counts.
 */
export async function countOutcomes(
  db: Firestore,
  orgId: string,
  at: Date,
  entries: readonly MetricEntry[],
  log: Log,
): Promise<void> {
  if (!entries.length) return;
  const values: Record<string, FieldValue> = {};
  const totals = new Map<string, number>();
  for (const entry of entries) {
    for (const key of suggestionMetricKeys(entry)) totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  for (const [key, count] of totals) values[key] = FieldValue.increment(count);
  const period = meteringPeriod(at);
  const ref = db.doc(`orgs/${orgId}/metrics/${period}`);
  try {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const meta = snapshot.exists
        ? { updatedAt: at, updatedBy: SYSTEM_ACTOR }
        : {
            period,
            createdAt: at,
            createdBy: SYSTEM_ACTOR,
            updatedAt: at,
            updatedBy: SYSTEM_ACTOR,
            schemaVersion: 1,
          };
      tx.set(ref, { ...meta, values }, { merge: true });
    });
  } catch (error) {
    log.error('suggestion metrics failed', {
      orgId,
      period,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** The metrics entry of a stored suggestion. */
export const metricOf = (data: Data, outcome: SuggestionOutcome): MetricEntry => ({
  kind: data['kind'] as SuggestionKind,
  promptId: String(data['promptId'] ?? 'unknown'),
  promptVersion: String(data['promptVersion'] ?? '0.0.0'),
  outcome,
});

/** A stored instant (a Firestore Timestamp, or a Date in tests) as a Date. */
export const asDate = (value: unknown): Date | undefined =>
  value instanceof Date ? value : (value as { toDate?: () => Date } | undefined)?.toDate?.();
