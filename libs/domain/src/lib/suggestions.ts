import * as z from 'zod';

import { KEY_FACTS, keyFactValue, partyDocId, type FactMatter, type KeyFactId } from './matter-detail';
import { can, type Action } from './permissions';
import type { SuggestionPayload } from './schemas/clerk';
import { DocIdSchema } from './schemas/common';
import { EventKindSchema, type EventKind, type Role, type SuggestionKind } from './schemas/enums';
import { EVENT_KEY_FACTS } from './templates';

/**
 * Clerk suggestions (AI-07, ADR-037): what each kind needs to be accepted, how a suggestion is
 * summarised, de-duplicated and checked for staleness (`basis`), the `suggestions-*` callables'
 * inputs and results, and the acceptance metrics keys. Clerk proposes; a person accepts.
 */

// ---------- lifecycle ----------

/** How long a suggestion stays open before the sweep marks it `expired`. */
export const SUGGESTION_TTL_DAYS = 14;
/** The most suggestions one `suggestions-acceptMany` call accepts. */
export const SUGGESTION_ACCEPT_MANY_MAX = 25;
/** The most proposals one `proposeSuggestions` call takes. */
export const SUGGESTION_PROPOSE_MAX = 50;
export const SUGGESTION_DISMISS_REASON_MAX = 500;

/** Statuses a person can still act on: `stale` ones need a re-review first. */
export const OPEN_SUGGESTION_STATUSES = ['proposed', 'stale'] as const;
export type OpenSuggestionStatus = (typeof OPEN_SUGGESTION_STATUSES)[number];

export const isOpenSuggestion = (status: unknown): status is OpenSuggestionStatus =>
  (OPEN_SUGGESTION_STATUSES as readonly unknown[]).includes(status);

/** An open suggestion whose `expiresAt` has passed (the sweep may not have run yet). */
export function suggestionExpired(suggestion: { status: unknown; expiresAt: Date }, now: Date): boolean {
  return isOpenSuggestion(suggestion.status) && suggestion.expiresAt.getTime() <= now.getTime();
}

// ---------- permissions ----------

/**
 * The action a person needs to accept each kind: the one the manual path needs (a read-only member
 * can't accept a task suggestion because they can't add a task).
 */
export const SUGGESTION_KIND_ACTION: Readonly<Record<SuggestionKind, Action>> = {
  task: 'task.edit',
  deadline: 'task.edit',
  event: 'matter.edit',
  party: 'matter.edit',
  key_fact: 'matter.edit',
  note: 'note.write',
  time_entry: 'time.record',
  document_meta: 'document.upload',
  chronology: 'matter.edit',
  order: 'matter.edit',
  evidence: 'matter.edit',
};

/** Whether a role may accept a suggestion of this kind (privileged ones need `privileged.view`). */
export function canAcceptSuggestion(role: Role, kind: SuggestionKind, privileged = false): boolean {
  return can(role, 'clerk.use') && can(role, SUGGESTION_KIND_ACTION[kind], { privileged });
}

// ---------- labels and summaries ----------

export const SUGGESTION_KIND_LABELS: Readonly<Record<SuggestionKind, string>> = {
  task: 'Task',
  deadline: 'Deadline',
  event: 'Event',
  party: 'Party',
  key_fact: 'Key fact',
  note: 'Note',
  time_entry: 'Time entry',
  document_meta: 'Document details',
  chronology: 'Chronology',
  order: 'Court order',
  evidence: 'Evidence',
};

/** The card's accept button per kind ("Add task"). */
export const SUGGESTION_ACCEPT_LABELS: Readonly<Record<SuggestionKind, string>> = {
  task: 'Add task',
  deadline: 'Add deadline',
  event: 'Record event',
  party: 'Add party',
  key_fact: 'Save fact',
  note: 'Add note',
  time_entry: 'Add time',
  document_meta: 'Update document',
  chronology: 'Add to chronology',
  order: 'Add order',
  evidence: 'Add evidence',
};

const EVENT_LABELS: Partial<Record<EventKind, string>> = {
  date_of_death: 'Date of death',
  will_located: 'Will located',
  notice_published: 'Notice published',
  probate_filed: 'Probate filed',
  grant_issued: 'Grant issued',
  hearing: 'Hearing',
  order_made: 'Order made',
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const firstLine = (value: string, max = 120) => {
  const line = value.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One line saying what the suggestion would do ("Request date-of-death valuation · due 2026-10-12"). */
export function suggestionSummary(suggestion: { kind: SuggestionKind; payload: unknown }): string {
  const p = (suggestion.payload ?? {}) as Record<string, unknown>;
  const due = (date: unknown) => (typeof date === 'string' && date ? ` · due ${date}` : '');
  switch (suggestion.kind) {
    case 'task':
      return `${text(p['title'])}${due(p['dueDate'])}`;
    case 'deadline':
      return `${text(p['title'])}${due(p['dueDate'])}`;
    case 'event': {
      const kind = EventKindSchema.safeParse(p['kind']);
      const label = text(p['label']) || (kind.success ? (EVENT_LABELS[kind.data] ?? kind.data.replace(/_/g, ' ')) : '');
      return `${label} on ${text(p['date'])}`;
    }
    case 'party':
      return `Add contact ${text(p['contactId'])} as ${text(p['role']).replace(/_/g, ' ')}`;
    case 'key_fact': {
      const fact = KEY_FACTS.find((definition) => definition.id === p['field']);
      const value =
        fact?.kind === 'money' && typeof p['value'] === 'number'
          ? `$${(p['value'] / 100).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`
          : String(p['value'] ?? '');
      return `${fact?.label ?? text(p['field'])}: ${value}`;
    }
    case 'note':
      return firstLine(text(p['bodyMd']));
    case 'time_entry':
      return `${String(p['minutes'] ?? '')} min · ${firstLine(text(p['narrative']), 80)}`;
    case 'document_meta':
      return [
        p['title'] ? `Rename to “${text(p['title'])}”` : '',
        p['category'] ? `file as ${text(p['category'])}` : '',
      ]
        .filter(Boolean)
        .join(', ');
    case 'chronology':
      return `${text(p['date'])}: ${firstLine(text(p['title']), 100)}`;
    case 'order':
      return `Order ${text(p['orderNo'])}: ${firstLine(text(p['text']), 100)}`;
    case 'evidence':
      return `Evidence (${text(p['supports'])})${p['documentId'] ? ` from document ${text(p['documentId'])}` : ''}`;
  }
}

// ---------- dedupe ----------

/** Lower case, single spaces: "Request  Valuation " and "request valuation" are the same proposal. */
export const normaliseForDedupe = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The default `dedupeKey`: the kind plus what makes two proposals the same thing (a task's title
 * and due date, a fact's field and value, a party's contact and role). A feature may pass its own.
 */
export function defaultDedupeKey(suggestion: SuggestionPayload): string {
  const p = suggestion.payload as Record<string, unknown>;
  const n = normaliseForDedupe;
  const key = (() => {
    switch (suggestion.kind) {
      case 'task':
      case 'deadline':
        return `${n(p['title'])}|${n(p['dueDate'])}`;
      case 'event':
        return `${n(p['kind'])}|${n(p['date'])}`;
      case 'party':
        return `${n(p['contactId'])}|${n(p['role'])}`;
      case 'key_fact':
        return `${n(p['field'])}|${n(p['value'])}`;
      case 'note':
        return hashString(n(p['bodyMd']));
      case 'time_entry':
        return `${n(p['date'])}|${n(p['minutes'])}|${hashString(n(p['narrative']))}`;
      case 'document_meta':
        return `${n(p['documentId'])}|${n(p['category'])}|${n(p['title'])}`;
      default:
        return hashString(stableJson(p));
    }
  })();
  return `${suggestion.kind}:${key}`.slice(0, 500);
}

// ---------- basis ----------

/** A basis part's value: scalars only, so the hash is stable. */
export type BasisValue = string | number | boolean | null;
export type BasisParts = Record<string, BasisValue>;

/** What the basis is computed from, as stored (the server reads it in the accept transaction). */
export interface BasisSources {
  matter: Record<string, unknown>;
  /** Cited and targeted documents by id (`undefined`: missing). */
  documents: Readonly<Record<string, Record<string, unknown> | undefined>>;
  /** A party suggestion's row (`parties/{role}-{contactId}`), if any. */
  party?: Record<string, unknown> | undefined;
  /** An event suggestion's live events of its kind. */
  events?: readonly { id: string; date: string }[] | undefined;
}

/** The documents a suggestion's basis covers: its citations, and a `document_meta` target. */
export function basisDocumentIds(suggestion: {
  kind: SuggestionKind;
  payload: unknown;
  citations?: readonly { documentId: string }[] | undefined;
}): string[] {
  const ids = (suggestion.citations ?? []).map((citation) => citation.documentId);
  const target = (suggestion.payload as { documentId?: unknown } | undefined)?.documentId;
  if (suggestion.kind === 'document_meta' && typeof target === 'string') ids.push(target);
  return [...new Set(ids)];
}

const isDeleted = (data: Record<string, unknown> | undefined) =>
  !data || (data['deletedAt'] !== undefined && data['deletedAt'] !== null);
const scalar = (value: unknown): BasisValue =>
  value === undefined
    ? null
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
      ? value
      : stableJson(value);

/** The key fact an event kind stands for, by fact id (`date_of_death` → `dateOfDeath`). */
const FACT_EVENT = new Map(
  Object.entries(EVENT_KEY_FACTS).map(([kind, fact]) => [fact as KeyFactId, kind as EventKind] as const),
);
/** The event kind that records a key fact (`dateOfDeath` → `date_of_death`), if any. */
export const keyFactEventKind = (fact: KeyFactId): EventKind | undefined => FACT_EVENT.get(fact);

/**
 * The source data a suggestion depends on, as named scalar parts (ADR-037): the matter's state
 * (status, stage, privilege, deletion) for every kind, plus what the kind reads (the fact it sets,
 * the events of its kind, its party row, its target document) and each cited document's version,
 * privilege and deletion. Fields the suggestion doesn't depend on (counters, activity, titles)
 * are left out, so accepting one task suggestion never makes the next one stale.
 */
export function suggestionBasisParts(
  suggestion: {
    kind: SuggestionKind;
    payload: unknown;
    citations?: readonly { documentId: string }[] | undefined;
  },
  sources: BasisSources,
): BasisParts {
  const m = sources.matter;
  const p = (suggestion.payload ?? {}) as Record<string, unknown>;
  const parts: BasisParts = {
    'matter.status': scalar(m['status']),
    'matter.stageId': scalar(m['stageId']),
    'matter.privileged': m['privileged'] === true,
    'matter.deleted': isDeleted(m),
  };
  const fact = (id: KeyFactId) => {
    parts[`fact.${id}`] = scalar(keyFactValue(m as FactMatter, id));
  };
  switch (suggestion.kind) {
    case 'key_fact':
      fact(p['field'] as KeyFactId);
      break;
    case 'event': {
      const kind = p['kind'] as EventKind;
      parts[`events.${kind}`] = (sources.events ?? [])
        .map((event) => `${event.id}:${event.date}`)
        .sort()
        .join(',');
      const related = EVENT_KEY_FACTS[kind];
      if (related) fact(related);
      break;
    }
    case 'party': {
      const id = partyDocId(p['role'] as never, String(p['contactId']));
      parts[`party.${id}`] = sources.party && !isDeleted(sources.party) ? 'live' : 'none';
      break;
    }
    case 'document_meta': {
      const doc = sources.documents[String(p['documentId'])];
      parts[`document.${String(p['documentId'])}.name`] = scalar(doc?.['name']);
      parts[`document.${String(p['documentId'])}.category`] = scalar(doc?.['category']);
      break;
    }
    default:
      break;
  }
  for (const id of basisDocumentIds(suggestion)) {
    const doc = sources.documents[id];
    parts[`document.${id}.version`] = scalar(doc?.['version']);
    parts[`document.${id}.privileged`] = doc?.['privileged'] === true;
    parts[`document.${id}.deleted`] = isDeleted(doc);
  }
  return parts;
}

/** Whether the sources make a suggestion privileged: the matter, or a cited or targeted document. */
export function sourcesPrivileged(
  suggestion: { kind: SuggestionKind; payload: unknown; citations?: readonly { documentId: string }[] | undefined },
  sources: BasisSources,
): boolean {
  if (sources.matter['privileged'] === true) return true;
  return basisDocumentIds(suggestion).some((id) => sources.documents[id]?.['privileged'] === true);
}

/** A basis: the hash over every part, and each part's own hash (for the stale diff). */
export interface Basis {
  basis: string;
  parts: Record<string, string>;
}

export function suggestionBasis(parts: BasisParts): Basis {
  const hashed = Object.fromEntries(
    Object.keys(parts)
      .sort()
      .map((key) => [key, hashString(stableJson(parts[key] ?? null))]),
  );
  return { basis: hashString(stableJson(hashed)), parts: hashed };
}

/** The parts whose hash differs between the stored basis and now (added and removed ones too), sorted. */
export function basisChanges(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

const FACT_LABEL = new Map<string, string>(KEY_FACTS.map((fact) => [`fact.${fact.id}`, fact.label]));

/** What a basis part is, for the re-review ("Matter status", "Grant number", "A cited document"). */
export function basisPartLabel(key: string): string {
  if (key === 'matter.status') return 'Matter status';
  if (key === 'matter.stageId') return 'Matter stage';
  if (key === 'matter.privileged') return 'Whether the matter is privileged';
  if (key === 'matter.deleted') return 'Whether the matter was deleted';
  const fact = FACT_LABEL.get(key);
  if (fact) return fact;
  if (key.startsWith('events.')) return `Recorded ${key.slice('events.'.length).replace(/_/g, ' ')} events`;
  if (key.startsWith('party.')) return 'The party on the matter';
  const doc = /^document\.[^.]+\.(\w+)$/.exec(key)?.[1];
  if (doc === 'privileged') return 'Whether a cited document is privileged';
  if (doc === 'version') return 'A cited document’s version';
  if (doc === 'deleted') return 'Whether a cited document was deleted';
  if (doc === 'name') return 'The document’s title';
  if (doc === 'category') return 'The document’s category';
  return key;
}

// ---------- hashing (change detection, not security) ----------

/** JSON with sorted keys, so equal values hash the same. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const toDate = (value as { toDate?: () => Date }).toDate;
  if (typeof toDate === 'function') return JSON.stringify(toDate.call(value).toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** cyrb53: a fast 53-bit string hash, as 14 hex characters. Runs the same in browsers, Node and tests. */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ---------- callables ----------

export const SUGGESTION_CALLABLES = {
  accept: 'suggestions-accept',
  acceptMany: 'suggestions-acceptMany',
  dismiss: 'suggestions-dismiss',
} as const;

const RequestId = z.uuid();

/**
 * `suggestions-accept` (`clerk.use` plus the kind's action, idempotent). Re-validates the
 * suggestion: its sources must still hash to `expectedBasis` (default: the stored basis), else it
 * is marked `stale` and the call fails with SUGGESTION_STALE (`details.changed`, `details.basis`).
 * `editedPayload` replaces the payload (validated per kind; field errors keyed by payload path)
 * and makes the status `edited`.
 */
export const AcceptSuggestionInput = z.strictObject({
  requestId: RequestId,
  matterId: DocIdSchema,
  suggestionId: DocIdSchema,
  editedPayload: z.record(z.string(), z.unknown()).optional(),
  expectedBasis: z.string().min(1).max(100).optional(),
});
export type AcceptSuggestionInput = z.input<typeof AcceptSuggestionInput>;

export interface AcceptSuggestionResult {
  suggestionId: string;
  status: 'accepted' | 'edited';
  /** The record created or changed (a document path). */
  resultRef: string;
}

/** `suggestions-acceptMany`: the same accept for each id, in order, each with its own result. */
export const AcceptManySuggestionsInput = z.strictObject({
  requestId: RequestId,
  matterId: DocIdSchema,
  suggestionIds: z.array(DocIdSchema).min(1).max(SUGGESTION_ACCEPT_MANY_MAX),
});
export type AcceptManySuggestionsInput = z.input<typeof AcceptManySuggestionsInput>;

export type AcceptManyItemResult =
  | ({ ok: true } & AcceptSuggestionResult)
  | { ok: false; suggestionId: string; code: string; details?: Record<string, unknown> };

export interface AcceptManySuggestionsResult {
  results: AcceptManyItemResult[];
  accepted: number;
  failed: number;
}

/** `suggestions-dismiss` (`clerk.use`, idempotent): an open suggestion becomes `dismissed`. */
export const DismissSuggestionInput = z.strictObject({
  requestId: RequestId,
  matterId: DocIdSchema,
  suggestionId: DocIdSchema,
  reason: z.string().trim().max(SUGGESTION_DISMISS_REASON_MAX).optional(),
});
export type DismissSuggestionInput = z.input<typeof DismissSuggestionInput>;

export interface DismissSuggestionResult {
  suggestionId: string;
  status: 'dismissed';
}

/** The stale details of a refused accept. */
export interface SuggestionStaleDetails {
  basis: string;
  changed: { key: string; label: string }[];
}

/** Quick reasons on the dismiss form; "Other" takes free text. */
export const SUGGESTION_DISMISS_REASONS = ['Not relevant', 'Already done', 'Incorrect', 'Duplicate'] as const;

// ---------- metrics ----------

export type SuggestionOutcome = 'proposed' | 'accepted' | 'edited' | 'dismissed' | 'expired' | 'stale';

/**
 * The counters one outcome increments in the org's monthly Clerk metrics
 * (`metrics/clerk-{YYYY-MM}` `values`): the total, per kind and per prompt version.
 */
export function suggestionMetricKeys(input: {
  kind: SuggestionKind;
  promptId: string;
  promptVersion: string;
  outcome: SuggestionOutcome;
}): string[] {
  return [
    `suggestions.${input.outcome}`,
    `suggestions.kind.${input.kind}.${input.outcome}`,
    `suggestions.prompt.${input.promptId}@${input.promptVersion}.${input.outcome}`,
  ];
}

export interface AcceptanceRate {
  accepted: number;
  edited: number;
  dismissed: number;
  expired: number;
  /** (accepted + edited) / resolved; null before anything is resolved. */
  rate: number | null;
}

/**
 * Acceptance rates from a metrics document's `values`, by scope: `all`, `kind.{kind}` and
 * `prompt.{id}@{version}` (for the evals and AI-13).
 */
export function suggestionAcceptanceRates(values: Readonly<Record<string, number>>): Record<string, AcceptanceRate> {
  const scopes = new Map<string, AcceptanceRate>();
  const outcomes = ['accepted', 'edited', 'dismissed', 'expired'] as const;
  for (const [key, count] of Object.entries(values)) {
    if (!key.startsWith('suggestions.')) continue;
    const rest = key.slice('suggestions.'.length);
    const dot = rest.lastIndexOf('.');
    const outcome = (dot < 0 ? rest : rest.slice(dot + 1)) as (typeof outcomes)[number];
    if (!outcomes.includes(outcome)) continue;
    const scope = dot < 0 ? 'all' : rest.slice(0, dot);
    const entry = scopes.get(scope) ?? { accepted: 0, edited: 0, dismissed: 0, expired: 0, rate: null };
    entry[outcome] += count;
    scopes.set(scope, entry);
  }
  for (const entry of scopes.values()) {
    const resolved = entry.accepted + entry.edited + entry.dismissed + entry.expired;
    entry.rate = resolved ? (entry.accepted + entry.edited) / resolved : null;
  }
  return Object.fromEntries(scopes);
}
