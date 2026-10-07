import type { MatterDeadline, MatterDetail, MatterParty, MatterTask, WithId } from '@materia/data-access/repository';
import {
  compareDeadlines,
  DomainError,
  EventKindSchema,
  KEY_FACTS,
  MATTER_STATUS_LABELS,
  MATTER_TRANSITIONS,
  PARTY_ROLE_ORDER,
  transitionRequirements,
  type DateOnly,
  type EventKind,
  type KeyFactId,
  type KeyFactKind,
  type MatterStatus,
  type PartyRole,
} from '@materia/domain';
import { formatAud, formatDateOnly } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';
import { formatDateInput, parseDateInput, PARTY_ROLE_LABELS } from '../contacts/contact-form';
import { eventKindLabel } from '../deadlines/deadline-view';
import { retentionErrorCopy } from '../matters/matters-view';

/** The matter on the screen. */
export type MatterRecord = WithId<MatterDetail>;

/**
 * What the matter screen's callables refused, in words: a closed matter's stage, or the field the
 * server named (a contact who already has that role), else the code's copy.
 */
export function matterErrorCopy(error: unknown): string {
  const details = error instanceof DomainError ? error.details : undefined;
  const reason = details?.['reason'];
  if (reason === 'matter_closed') return 'Reopen the matter before changing its stage.';
  const retention = retentionErrorCopy(reason);
  if (retention) return retention;
  if (reason === 'stage_back_requires_lawyer') return 'Only a lawyer can move a matter back a stage.';
  if (reason === 'no_template') return 'This matter isn’t on a template, so there’s nothing to upgrade.';
  if (reason === 'stage_unmapped') {
    return 'The matter’s stage isn’t in that version. Ask an admin to map the stage when publishing.';
  }
  const fields = details?.['fields'];
  if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && fields && typeof fields === 'object') {
    const messages = Object.values(fields as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [],
    );
    if (messages.length) return `${messages.join('. ')}.`;
  }
  return errorCopy(error);
}

/** "Updated by Priya Shah just now" shows for this long after someone else's change. */
export const RECENT_UPDATE_MS = 2 * 60_000;

/** Titles longer than this may wrap past two lines; the full title is in a tooltip. */
export const LONG_TITLE = 70;

/** A key fact as shown: `22 Jul 2026`, `$1,250,000.00` or the text; empty when not recorded. */
export function keyFactText(kind: KeyFactKind, value: string | number | undefined): string {
  if (value === undefined || value === '') return '';
  if (kind === 'date') return formatDateOnly(String(value));
  if (kind === 'money') return formatAud(Number(value));
  return String(value);
}

/** A key fact as the editor starts it: `22/07/2026`, `1250000.00` or the text. */
export function keyFactInput(kind: KeyFactKind, value: string | number | undefined): string {
  if (value === undefined || value === '') return '';
  if (kind === 'date') return formatDateInput(String(value));
  if (kind === 'money') return (Number(value) / 100).toFixed(2);
  return String(value);
}

export const KEY_FACT_PLACEHOLDERS: Readonly<Record<KeyFactKind, string>> = {
  date: 'DD/MM/YYYY',
  money: '$0.00',
  text: '',
};

/**
 * What was typed into a key fact's editor: an ISO date, cents or trimmed text, `undefined` to
 * clear it, or the error to show.
 */
export function parseKeyFactInput(
  kind: KeyFactKind,
  text: string,
): { value: string | number | undefined } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined };
  if (kind === 'date') {
    const date = parseDateInput(trimmed);
    return date ? { value: date } : { error: 'Enter a date like 14/06/2026.' };
  }
  if (kind === 'money') {
    const amount = trimmed.replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) return { error: 'Enter an amount like 1,250,000.00.' };
    return { value: Math.round(Number(amount) * 100) };
  }
  if (trimmed.length > 60) return { error: 'Keep it to 60 characters or fewer.' };
  return { value: trimmed };
}

export function keyFactLabel(id: KeyFactId): string {
  return KEY_FACTS.find((fact) => fact.id === id)?.label ?? id;
}

// Event kinds in words live with the deadlines feature, which Today loads without this file.
export { EVENT_KIND_LABELS, eventKindLabel } from '../deadlines/deadline-view';

/** What a refused stage move is missing: key facts, matter events and template task keys. */
export interface StageRequirements {
  facts: KeyFactId[];
  events: EventKind[];
  tasks: string[];
}

/**
 * What a refused stage move names (`MATTER_STAGE_REQUIREMENTS`): `details.requirements` (key
 * facts), and with templates on (CORE-07) `details.events` and `details.tasks`. Null for other errors.
 */
export function stageRequirementsOf(error: unknown): StageRequirements | null {
  const domain = error instanceof DomainError ? error : null;
  if (domain?.code !== 'MATTER_STAGE_REQUIREMENTS') return null;
  const list = (key: string) => {
    const value = domain.details?.[key];
    return Array.isArray(value) ? value.map(String) : [];
  };
  const facts = new Set<string>(KEY_FACTS.map((fact) => fact.id));
  const events = new Set<string>(EventKindSchema.options);
  return {
    facts: list('requirements').filter((id): id is KeyFactId => facts.has(id)),
    events: list('events').filter((kind): kind is EventKind => events.has(kind)),
    tasks: list('tasks'),
  };
}

/** "Updated by Priya Shah just now": someone else changed the matter in the last two minutes. */
export function recentUpdateText(
  matter: Pick<MatterDetail, 'updatedAt' | 'updatedBy'>,
  me: string | null,
  now: number,
  name: (uid: string) => string,
): string | null {
  const at = matter.updatedAt?.getTime();
  if (!matter.updatedBy || matter.updatedBy === me || at === undefined) return null;
  if (now - at > RECENT_UPDATE_MS || at - now > RECENT_UPDATE_MS) return null;
  return `Updated by ${name(matter.updatedBy)} just now`;
}

// ---------- status ----------

/** A status the matter can move to from where it is, as the status menu offers it. */
export interface StatusChoice {
  to: MatterStatus;
  label: string;
  /** Ask for a reason first (closing, reopening). */
  needsReason: boolean;
  /** Why it isn't available yet (a lead whose conflict check doesn't allow opening). */
  blocked?: string;
}

const STATUS_ACTIONS: Readonly<Record<MatterStatus, string>> = {
  lead: 'Lead',
  open: 'Open',
  on_hold: 'Put on hold',
  closed: 'Close matter…',
  archived: 'Archive',
};

export function statusChoices(status: MatterStatus, conflictOpenable: boolean): StatusChoice[] {
  return MATTER_TRANSITIONS[status].map((to) => {
    const requirements = transitionRequirements(status, to);
    const reopen = (status === 'closed' || status === 'archived') && to === 'open';
    const choice: StatusChoice = {
      to,
      label: reopen ? 'Reopen…' : STATUS_ACTIONS[to],
      // Closing asks through the closing checklist (CORE-19) instead.
      needsReason: requirements.includes('reason'),
    };
    if (requirements.includes('conflict_openable') && !conflictOpenable) {
      choice.blocked = 'The conflict check needs a lawyer’s determination first';
    }
    return choice;
  });
}

export function statusLabel(status: MatterStatus): string {
  return MATTER_STATUS_LABELS[status];
}

// ---------- overview ----------

/**
 * A deadline's date in force. Since CORE-10 `dueDate` already carries an override; older documents
 * kept the override beside it. Undefined while the deadline is blocked (no date yet).
 */
export function effectiveDue(deadline: MatterDeadline): DateOnly | undefined {
  return (deadline.override?.dueDate ?? deadline.dueDate) as DateOnly | undefined;
}

/** The next `count` open deadlines: dated ones soonest (or most overdue) first, then waiting ones. */
export function nextDeadlines(rows: readonly WithId<MatterDeadline>[], count = 5): WithId<MatterDeadline>[] {
  return [...rows]
    .sort((a, b) => compareDeadlines({ ...a, dueDate: effectiveDue(a) }, { ...b, dueDate: effectiveDue(b) }))
    .slice(0, count);
}

/** "Due date pending: Grant issued unknown" for a template task waiting on its anchor event (CORE-07). */
export function duePendingText(task: Pick<MatterTask, 'dueDate' | 'duePending'>): string | null {
  return !task.dueDate && task.duePending ? `Due date pending: ${eventKindLabel(task.duePending)} unknown` : null;
}

/** Open tasks: dated ones first by due date, then the rest in their list order. */
export function sortOpenTasks(rows: readonly WithId<MatterTask>[]): WithId<MatterTask>[] {
  return [...rows].sort((a, b) => {
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
    return a.order - b.order;
  });
}

// ---------- parties ----------

export const PARTY_ROLE_OPTIONS = PARTY_ROLE_ORDER.map((role) => ({ value: role, label: PARTY_ROLE_LABELS[role] }));

export function partyRoleLabel(role: PartyRole): string {
  return PARTY_ROLE_LABELS[role];
}

export interface PartyGroup {
  role: PartyRole;
  label: string;
  parties: WithId<MatterParty>[];
}

/** Parties by role in `PARTY_ROLE_ORDER`, each group by name. */
export function groupParties(
  parties: readonly WithId<MatterParty>[],
  name: (contactId: string) => string,
): PartyGroup[] {
  return PARTY_ROLE_ORDER.map((role) => ({
    role,
    label: PARTY_ROLE_LABELS[role],
    parties: parties
      .filter((party) => party.role === role)
      .sort((a, b) => name(a.contactId).localeCompare(name(b.contactId))),
  })).filter((group) => group.parties.length > 0);
}
