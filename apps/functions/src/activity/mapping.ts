import { MATTER_STATUS_LABELS, type EventKind, type MatterStatus } from '@materia/domain';

/**
 * The matter activity feed's mapping table (CORE-13, ADR-032): which audit entries (FND-18) become
 * a feed line, and how it reads. Keys are a semantic action as recorded by `audit()`
 * (`matter.status_changed`) or, for a plain write the audit trigger recorded, `{collection}.{action}`
 * (`documents.create`, `notes.soft_delete`). Anything not listed isn't activity.
 *
 * Summaries are actor-less sentences (the feed puts the member's name in front, as for tasks), and
 * are built from ids, enums, dates and names the reader can already see. They never contain note
 * text, and when the matter or the record is privileged they name nothing ("Added a document"),
 * since the feed is readable by every member.
 *
 * A change recorded both ways (a callable's write and its semantic event) is mapped once: the
 * semantic event where there is one (notes created and edited, deadlines overridden or closed,
 * parties, events), the write otherwise (documents, manual deadlines, pinning, deleting and
 * restoring notes).
 */

type Data = Record<string, unknown>;

/** The parts of an `orgs/{orgId}/audit/{id}` entry the mapping reads. */
export interface AuditEntryLike {
  action: string;
  actor?: unknown;
  at?: unknown;
  entity: { path: string; collection?: string; id?: string; matterId?: string };
  changedFields?: string[];
  before?: Data;
  after?: Data;
  data?: Data;
  /** A semantic entry's one line, from ids and enums. */
  summary?: string;
  source?: string;
}

/** What a rule may ask the trigger to look up first. */
export type ActivityNeed = 'entity' | 'stages' | 'template' | 'contact';

/** What the trigger looked up for a rule. */
export interface ActivityFacts {
  /** The matter or the record is privileged: the summary names nothing. */
  restricted: boolean;
  /** The audited document as it is now (`entity` need), when it exists. */
  entity?: Data;
  /** A stage's title by id, from the matter's template or its type's defaults (`stages` need). */
  stageTitle?: (stageId: string) => string | undefined;
  /** The applied template's name (`template` need). */
  templateName?: string;
  /** The party's contact name (`contact` need). */
  contactName?: string;
}

export interface ActivityLine {
  kind: string;
  summary: string;
}

export interface ActivityRule {
  needs?: readonly ActivityNeed[];
  /** The feed line, or null when this particular entry isn't activity. */
  map: (entry: AuditEntryLike, facts: ActivityFacts) => ActivityLine | null;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** `“name”` when the summary may name the record, else undefined. */
const named = (facts: ActivityFacts, value: unknown): string | undefined => {
  const name = text(value);
  return name && !facts.restricted ? `“${name}”` : undefined;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A DateOnly as "12 Mar 2026" (undefined for anything else). */
export function formatDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : dayFormat.format(date);
}

const statusLabel = (value: unknown) =>
  typeof value === 'string' && value in MATTER_STATUS_LABELS
    ? MATTER_STATUS_LABELS[value as MatterStatus]
    : text(value)?.replaceAll('_', ' ');

/** An enum value as words: `other_side_solicitor` → "other side solicitor". */
const words = (value: unknown) => text(value)?.replaceAll('_', ' ');

export const EVENT_LABELS: Readonly<Record<EventKind, string>> = {
  date_of_death: 'Date of death',
  will_located: 'Will located',
  notice_published: 'Notice published',
  probate_filed: 'Probate filed',
  grant_issued: 'Grant issued',
  statutory_notice_published: 'Statutory notice published',
  caveat_lodged: 'Caveat lodged',
  grant_served: 'Grant served',
  fp_claim_filed: 'FP claim filed',
  hearing: 'Hearing',
  order_made: 'Order made',
  offer_made: 'Offer made',
  custom: 'Event',
};

const data = (entry: AuditEntryLike): Data => entry.data ?? {};
const line = (kind: string, summary: string): ActivityLine => ({ kind, summary });

/** The deadline's title from the entity lookup, quoted, else "a deadline". */
const deadline = (facts: ActivityFacts, prefix = '') => {
  const title = named(facts, facts.entity?.['title']);
  return title ? `${prefix}${title}` : 'a deadline';
};

/** A manual deadline: no `computed` (engine deadlines come and go with the rules, in bulk). */
const isManualDeadline = (doc: Data | undefined) =>
  !!doc && (doc['computed'] === undefined || doc['computed'] === null);

const party = (entry: AuditEntryLike, facts: ActivityFacts) => {
  const role = words(data(entry)['role']) ?? 'party';
  const name = facts.restricted ? undefined : text(facts.contactName);
  return { role, name };
};

export const ACTIVITY_RULES: Readonly<Record<string, ActivityRule>> = {
  // ---------- matters (semantic) ----------
  'matter.created': {
    map: (entry) =>
      line('matter.created', data(entry)['status'] === 'lead' ? 'Created the matter as a lead' : 'Opened the matter'),
  },
  'matter.status_changed': {
    map: (entry) => {
      const { from, to } = data(entry);
      const next = statusLabel(to);
      if (!next) return null;
      const previous = statusLabel(from);
      return line(
        'matter.status_changed',
        previous ? `Changed the status from ${previous} to ${next}` : `Changed the status to ${next}`,
      );
    },
  },
  'matter.stage_changed': {
    needs: ['stages'],
    map: (entry, facts) => {
      const to = text(data(entry)['to']);
      if (!to) return null;
      const title = facts.stageTitle?.(to) ?? words(to) ?? to;
      const back = data(entry)['direction'] === 'back';
      return line('matter.stage_changed', `${back ? 'Moved back to' : 'Moved to'} stage “${title}”`);
    },
  },
  'matter.template_applied': {
    needs: ['template'],
    map: (_entry, facts) => {
      const name = text(facts.templateName);
      return line('matter.template_applied', name ? `Applied template “${name}”` : 'Applied a template');
    },
  },
  'matter.template_upgraded': {
    map: (entry) => {
      const to = data(entry)['to'];
      return line(
        'matter.template_upgraded',
        typeof to === 'number' ? `Upgraded the matter’s template to version ${to}` : 'Upgraded the matter’s template',
      );
    },
  },
  'matter.renumbered': {
    map: (entry) => {
      const to = text(data(entry)['to']);
      return line('matter.renumbered', to ? `Renumbered the matter to ${to}` : 'Renumbered the matter');
    },
  },
  'matter.restored': { map: () => line('matter.restored', 'Restored the matter') },
  'matter.conflict_determined': {
    map: (entry) => {
      const status = words(data(entry)['status']);
      return line(
        'matter.conflict_determined',
        status ? `Recorded the conflict check as ${status}` : 'Recorded the conflict check',
      );
    },
  },
  'matter.party_added': {
    needs: ['contact'],
    map: (entry, facts) => {
      const { role, name } = party(entry, facts);
      return line('matter.party_added', name ? `Added ${name} as ${role}` : `Added a party as ${role}`);
    },
  },
  'matter.party_updated': {
    needs: ['contact'],
    map: (entry, facts) => {
      const { role, name } = party(entry, facts);
      return line('matter.party_updated', name ? `Updated ${name} (${role})` : `Updated a party (${role})`);
    },
  },
  'matter.party_removed': {
    needs: ['contact'],
    map: (entry, facts) => {
      const { role, name } = party(entry, facts);
      return line('matter.party_removed', name ? `Removed ${name} (${role})` : `Removed a party (${role})`);
    },
  },
  'matter.event_recorded': {
    needs: ['entity'],
    map: (entry, facts) => {
      const kind = data(entry)['kind'] as EventKind | undefined;
      const custom = kind === 'custom' ? named(facts, facts.entity?.['label']) : undefined;
      const label = custom ?? (kind && kind !== 'custom' && EVENT_LABELS[kind] ? `“${EVENT_LABELS[kind]}”` : undefined);
      const day = formatDay(data(entry)['date']);
      // deadlines-upsertEvent records an edit under the same action; only its summary says so.
      const verb = / edited on matter /.test(entry.summary ?? '') ? 'Updated' : 'Recorded';
      const what = label ? `event ${label}` : 'an event';
      return line('matter.event_recorded', `${verb} ${what}${day ? ` (${day})` : ''}`);
    },
  },
  'matter.event_deleted': { map: () => line('matter.event_deleted', 'Deleted an event') },

  // ---------- deadlines (semantic; the callables' writes aren't mapped) ----------
  'deadline.overridden': {
    needs: ['entity'],
    map: (entry, facts) => {
      const day = formatDay(data(entry)['dueDate']);
      return line('deadline.overridden', `Moved ${deadline(facts)}${day ? ` to ${day}` : ''}`);
    },
  },
  'deadline.override_cleared': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.override_cleared', `Cleared the date override on ${deadline(facts)}`),
  },
  'deadline.done': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.done', `Completed ${deadline(facts, 'deadline ')}`),
  },
  'deadline.waived': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.waived', `Waived ${deadline(facts, 'deadline ')}`),
  },
  'deadline.missed': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.missed', `Marked ${deadline(facts, 'deadline ')} as missed`),
  },
  'deadline.acknowledged': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.acknowledged', `Acknowledged ${deadline(facts, 'deadline ')}`),
  },
  'deadline.change_accepted': {
    needs: ['entity'],
    map: (entry, facts) => {
      if (data(entry)['kind'] === 'removed') {
        return line('deadline.change_accepted', `Accepted removing ${deadline(facts, 'deadline ')}`);
      }
      const day = formatDay(data(entry)['toDueDate']);
      return line('deadline.change_accepted', `Accepted the new date for ${deadline(facts)}${day ? ` (${day})` : ''}`);
    },
  },
  'deadline.change_rejected': {
    needs: ['entity'],
    map: (_entry, facts) => line('deadline.change_rejected', `Kept ${deadline(facts)} as it was`),
  },

  // ---------- deadlines (writes: manual deadlines only) ----------
  'deadlines.create': {
    map: (entry, facts) => {
      if (!isManualDeadline(entry.after)) return null;
      const title = named(facts, entry.after?.['title']);
      const day = formatDay(entry.after?.['dueDate']);
      return line(
        'deadline.created',
        `${title ? `Added deadline ${title}` : 'Added a deadline'}${day ? ` due ${day}` : ''}`,
      );
    },
  },
  'deadlines.soft_delete': {
    needs: ['entity'],
    map: (_entry, facts) =>
      isManualDeadline(facts.entity) ? line('deadline.deleted', `Deleted ${deadline(facts, 'deadline ')}`) : null,
  },
  'deadlines.restore': {
    needs: ['entity'],
    map: (_entry, facts) =>
      isManualDeadline(facts.entity) ? line('deadline.restored', `Restored ${deadline(facts, 'deadline ')}`) : null,
  },

  // ---------- documents (writes) ----------
  'documents.create': {
    needs: ['entity'],
    map: (entry, facts) => {
      const name = named(facts, entry.after?.['name'] ?? facts.entity?.['name']);
      return line('document.added', name ? `Added document ${name}` : 'Added a document');
    },
  },
  'documents.soft_delete': {
    needs: ['entity'],
    map: (_entry, facts) => {
      const name = named(facts, facts.entity?.['name']);
      return line('document.removed', name ? `Removed document ${name}` : 'Removed a document');
    },
  },
  'documents.restore': {
    needs: ['entity'],
    map: (_entry, facts) => {
      const name = named(facts, facts.entity?.['name']);
      return line('document.restored', name ? `Restored document ${name}` : 'Restored a document');
    },
  },

  // ---------- notes (semantic for text, writes for the rest) ----------
  'note.created': { map: () => line('note.created', 'Added a note') },
  'note.edited': { map: () => line('note.edited', 'Edited a note') },
  'notes.soft_delete': { map: () => line('note.deleted', 'Deleted a note') },
  'notes.restore': { map: () => line('note.restored', 'Restored a note') },
  'notes.update': {
    map: (entry) => {
      const fields = entry.changedFields ?? [];
      if (fields.length !== 1 || fields[0] !== 'pinned') return null;
      return entry.after?.['pinned'] === true
        ? line('note.pinned', 'Pinned a note')
        : line('note.unpinned', 'Unpinned a note');
    },
  },
};

/** Writes are `create`, `update`, `delete`, `soft_delete` and `restore`; semantic actions are dotted. */
const isSemantic = (action: string) => action.includes('.');

/** The mapping-table key for an entry: its semantic action, else `{collection}.{action}`. */
export function activityKey(entry: AuditEntryLike): string | null {
  if (isSemantic(entry.action)) return entry.action;
  return entry.entity.collection ? `${entry.entity.collection}.${entry.action}` : null;
}

/**
 * The rule for an entry, or undefined when it isn't feed activity: not about a matter, a task
 * (`tasks-onWrite` writes those lines itself), loaded by the legacy migration, or not in the table.
 */
export function ruleFor(entry: AuditEntryLike): ActivityRule | undefined {
  if (!entry.entity?.matterId) return undefined;
  if (entry.entity.collection === 'tasks') return undefined;
  if (entry.source === 'migration') return undefined;
  const key = activityKey(entry);
  return key && Object.hasOwn(ACTIVITY_RULES, key) ? ACTIVITY_RULES[key] : undefined;
}

/** Which `refs` key names the audited record, by collection. */
const REF_KEYS: Readonly<Record<string, string>> = {
  notes: 'noteId',
  documents: 'documentId',
  deadlines: 'deadlineId',
  parties: 'partyId',
  events: 'eventId',
};

/** The feed line's `refs`: the audit entry, the record (`noteId`, `documentId`…) and a party's contact. */
export function activityRefs(entry: AuditEntryLike, entryId: string): Record<string, string> {
  const refs: Record<string, string> = { auditId: entryId };
  const key = entry.entity.collection ? REF_KEYS[entry.entity.collection] : undefined;
  if (key && entry.entity.id) refs[key] = entry.entity.id;
  const contactId = entry.data?.['contactId'];
  if (entry.entity.collection === 'parties' && typeof contactId === 'string') refs['contactId'] = contactId;
  return refs;
}

/** Who the line is about: the entry's member, else `system` or `clerk`. */
export function actorUid(entry: AuditEntryLike): string {
  const actor = entry.actor;
  if (actor === 'system' || actor === 'clerk') return actor;
  const uid = (actor as { uid?: unknown } | undefined)?.uid;
  return typeof uid === 'string' && uid ? uid : 'system';
}
