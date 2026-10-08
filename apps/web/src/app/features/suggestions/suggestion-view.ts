import type { SuggestionItem } from '@materia/data-access/repository';
import {
  basisPartLabel,
  DocumentCategorySchema,
  EventKindSchema,
  KEY_FACTS,
  PartyRoleSchema,
  PrioritySchema,
  SUGGESTION_ACCEPT_LABELS,
  SUGGESTION_KIND_LABELS,
  SUGGESTION_PAYLOADS,
  suggestionSummary,
  type SuggestionKind,
} from '@materia/domain';
import type { SuggestionVm } from '@materia/ui/suggestion';

/**
 * How the suggestion card (AI-07) shows and edits a suggestion: its view model, the fields of the
 * inline editor per kind, the draft ↔ payload conversion (validated by the kind's payload schema,
 * the same one the server checks), and the stale re-review lines.
 */

export type SuggestionRecord = SuggestionItem & { id: string };

/** The card's view model: kind label, one-line summary, rationale, citations and who asked for it. */
export function suggestionVm(item: SuggestionRecord): SuggestionVm {
  return {
    id: item.id,
    kind: SUGGESTION_KIND_LABELS[item.kind],
    title: suggestionSummary(item) || SUGGESTION_KIND_LABELS[item.kind],
    rationale: item.rationale,
    // Labelled with the documents' names where the screen resolves them (`CitationSources`, AI-05).
    citations: item.citations.map((citation, i) => ({
      n: i + 1,
      documentId: citation.documentId ?? citation.recordRef?.id ?? '',
      label: citation.page ? `p. ${citation.page}` : 'Source',
      version: citation.docVersion,
      page: citation.page,
      quote: citation.quote,
      ...(citation.kind === 'record' ? { kind: 'record' as const } : {}),
      ...(citation.verified === false ? { verified: false } : {}),
    })),
    acceptLabel: SUGGESTION_ACCEPT_LABELS[item.kind],
    // Made by a person's own Claude through the connector (INT-07), not by Clerk.
    ...(item.requestedBy ? { origin: `Suggested in Claude by ${item.requestedBy.name}` } : {}),
  };
}

/**
 * Where a letter suggestion (AI-10b) opens: the draft start page's query, with the letter filled in
 * (`type`, `instructions`, the parties as `to`, someone typed in as `toName`/`toAddress`), the
 * suggestion it accepts as the draft starts (`suggestion`) and, after a re-review, the basis it
 * accepts against (`basis`).
 */
export function letterStartParams(item: SuggestionRecord, basis?: string): Record<string, string> {
  const payload = item.payload as {
    typeId?: string;
    recipients?: readonly { partyId?: string; name?: string; address?: string }[];
    instructions?: string;
  };
  const recipients = payload.recipients ?? [];
  const partyIds = recipients.flatMap((recipient) => (recipient.partyId ? [recipient.partyId] : []));
  const typed = recipients.find((recipient) => !recipient.partyId && recipient.name);
  return {
    type: payload.typeId ?? '',
    ...(payload.instructions?.trim() ? { instructions: payload.instructions.trim() } : {}),
    ...(partyIds.length ? { to: partyIds.join(',') } : {}),
    ...(typed?.name ? { toName: typed.name } : {}),
    ...(typed?.address ? { toAddress: typed.address } : {}),
    suggestion: item.id,
    ...(basis ? { basis } : {}),
  };
}

/** An open suggestion past its expiry (the hourly sweep may not have marked it yet), or an expired one. */
export const isExpired = (item: Pick<SuggestionItem, 'status' | 'expiresAt'>, now: number) =>
  item.status === 'expired' ||
  ((item.status === 'proposed' || item.status === 'stale') && item.expiresAt.getTime() <= now);

// ---------- inline editor ----------

export type EditFieldType = 'text' | 'textarea' | 'date' | 'select' | 'checkbox' | 'money' | 'number';

export interface EditField {
  key: string;
  label: string;
  type: EditFieldType;
  options?: readonly { value: string; label: string }[];
  optional?: boolean;
}

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ') }));

const FIELDS: Partial<Record<SuggestionKind, readonly EditField[]>> = {
  task: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'dueDate', label: 'Due date', type: 'date', optional: true },
    { key: 'priority', label: 'Priority', type: 'select', options: options(PrioritySchema.options) },
    { key: 'descriptionMd', label: 'Description', type: 'textarea', optional: true },
  ],
  deadline: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'dueDate', label: 'Due date', type: 'date' },
    { key: 'kind', label: 'Kind', type: 'select', options: options(['internal', 'contractual', 'court']) },
    { key: 'critical', label: 'Critical', type: 'checkbox' },
  ],
  event: [
    { key: 'kind', label: 'Event', type: 'select', options: options(EventKindSchema.options) },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'label', label: 'Label', type: 'text', optional: true },
  ],
  party: [
    { key: 'role', label: 'Role', type: 'select', options: options(PartyRoleSchema.options) },
    { key: 'share', label: 'Share', type: 'text', optional: true },
    { key: 'notes', label: 'Notes', type: 'textarea', optional: true },
  ],
  note: [
    { key: 'bodyMd', label: 'Note', type: 'textarea' },
    { key: 'pinned', label: 'Pin to the Overview', type: 'checkbox' },
  ],
  document_meta: [
    { key: 'title', label: 'Title', type: 'text', optional: true },
    {
      key: 'category',
      label: 'Category',
      type: 'select',
      options: options(DocumentCategorySchema.options),
      optional: true,
    },
  ],
  time_entry: [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'minutes', label: 'Minutes', type: 'number' },
    { key: 'narrative', label: 'Narrative', type: 'textarea' },
  ],
};

/** The editable fields of a suggestion (a key fact's depend on the fact); none for the litigation kinds. */
export function editFields(item: Pick<SuggestionItem, 'kind' | 'payload'>): readonly EditField[] {
  if (item.kind === 'key_fact') {
    const fact = KEY_FACTS.find((definition) => definition.id === item.payload['field']);
    const type: EditFieldType = fact?.kind === 'date' ? 'date' : fact?.kind === 'money' ? 'money' : 'text';
    return [{ key: 'value', label: fact?.label ?? 'Value', type }];
  }
  return FIELDS[item.kind] ?? [];
}

export type Draft = Record<string, string | boolean>;

/** A date-only value as typed in the editor (DD/MM/YYYY). */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

/** DD/MM/YYYY (or ISO) as an ISO date, or null. */
export function parseDay(text: string): string | null {
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text.trim());
  const iso = local ? `${local[3]}-${local[2]?.padStart(2, '0')}-${local[1]?.padStart(2, '0')}` : text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null;
}

/** The editor's starting values: the payload's, as text (cents as dollars, dates as DD/MM/YYYY). */
export function draftFrom(item: Pick<SuggestionItem, 'kind' | 'payload'>): Draft {
  const draft: Draft = {};
  for (const field of editFields(item)) {
    const value = item.payload[field.key];
    if (field.type === 'checkbox') draft[field.key] = value === true;
    else if (field.type === 'money') draft[field.key] = typeof value === 'number' ? (value / 100).toFixed(2) : '';
    else if (field.type === 'date') draft[field.key] = typeof value === 'string' ? formatDay(value) : '';
    else draft[field.key] = value === undefined || value === null ? '' : String(value);
  }
  return draft;
}

/**
 * The payload an edit makes: the original with the edited fields (empty optional ones dropped,
 * numbers and money converted), validated by the kind's schema. Errors are keyed by payload path,
 * as the server returns them.
 */
export function payloadFrom(
  item: Pick<SuggestionItem, 'kind' | 'payload'>,
  draft: Draft,
): { payload: Record<string, unknown> } | { errors: Record<string, string[]> } {
  const edited = new Set(editFields(item).map((field) => field.key));
  // The original's fields the editor doesn't show; empty edited ones stay out (dropped optionals).
  const payload: Record<string, unknown> = Object.fromEntries(
    Object.entries(item.payload).filter(([key]) => !edited.has(key)),
  );
  const errors: Record<string, string[]> = {};
  for (const field of editFields(item)) {
    const raw = draft[field.key];
    if (field.type === 'checkbox') {
      payload[field.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (!field.optional) errors[field.key] = [`${field.label} can’t be empty`];
      continue;
    }
    if (field.type === 'money') {
      const dollars = Number(text.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(dollars)) errors[field.key] = ['Enter an amount in dollars'];
      else payload[field.key] = Math.round(dollars * 100);
    } else if (field.type === 'date') {
      const iso = parseDay(text);
      if (!iso) errors[field.key] = ['Enter a date as DD/MM/YYYY'];
      else payload[field.key] = iso;
    } else if (field.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) errors[field.key] = ['Enter a number'];
      else payload[field.key] = n;
    } else payload[field.key] = text;
  }
  if (Object.keys(errors).length) return { errors };
  const parsed = SUGGESTION_PAYLOADS[item.kind].safeParse(payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      (errors[issue.path.map(String).join('.') || 'form'] ??= []).push(issue.message);
    return { errors };
  }
  return { payload: parsed.data as Record<string, unknown> };
}

/** The changed sources of a stale suggestion, as labels for the re-review. */
export function staleLines(keys: readonly string[]): string[] {
  return [...new Set(keys.map(basisPartLabel))];
}

/** "Accept all 3 tasks". */
export function bulkLabel(kind: SuggestionKind, count: number): string {
  const label = SUGGESTION_KIND_LABELS[kind].toLowerCase();
  return `Accept all ${count} ${label === 'key fact' ? 'key facts' : label.endsWith('s') ? label : `${label}s`}`;
}
