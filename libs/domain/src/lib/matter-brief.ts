import * as z from 'zod';

import { DOCUMENT_CATEGORY_LABELS } from './documents';
import { numbersIn } from './insights-narrative';
import {
  BRIEF_ITEM_KINDS,
  MATTER_BRIEF_HEADLINE_MAX,
  MATTER_BRIEF_MAX_ITEMS,
  MATTER_BRIEF_REFS_MAX,
  MATTER_BRIEF_TEXT_MAX,
  type BriefItem,
  type BriefItemKind,
  type BriefRead,
  type BriefRefKind,
} from './schemas/clerk';
import { DocIdSchema } from './schemas/common';
import type { SuggestionKind } from './schemas/enums';
import { hashString, stableJson, SUGGESTION_KIND_LABELS, suggestionSummary } from './suggestions';
import { addDays, compareDates, daysBetween, dateOnlyAt, isDateOnly, type DateOnly } from './values/date-only';

/**
 * Clerk's matter brief on Overview (AI-06c, ADR-059): the facts it is built from, the template
 * brief used whenever Clerk isn't (switched off, failed, a limit reached, a role that can't use
 * Clerk), and the checks every Clerk-written item must pass. Facts only: deadlines, tasks, the
 * activity feed's lines, documents added (name and category, never their text) and open
 * suggestions. Pure, so the callable, the context builder, the evals and AI-09's daily brief agree
 * on every fact.
 */

export const MATTER_BRIEF_CALLABLES = { brief: 'clerk-matterBrief' } as const;
/** The prompt that writes it (`libs/clerk/prompts`). */
export const MATTER_BRIEF_PROMPT = 'matter-brief@1.0.0';
/** The brief's document id under `matters/{matterId}/briefs`. */
export const MATTER_BRIEF_DOC_ID = 'latest';
/** "What's due": overdue, and the next this many days. */
export const MATTER_BRIEF_DUE_DAYS = 14;
/** "What changed": the feed and documents added in the last this many days. */
export const MATTER_BRIEF_CHANGES_DAYS = 14;
/** A brief older than this is rebuilt when the matter is opened, even if nothing changed. */
export const MATTER_BRIEF_TTL_HOURS = 24;
/** Refresh presses per matter per day (the org's day). */
export const MATTER_BRIEF_REFRESHES_PER_DAY = 3;
/** Clerk-written briefs per org per day; after that the day's briefs come from the template. */
export const MATTER_BRIEF_ORG_DAILY_LIMIT = 300;
/** After Clerk failed or a limit was reached, the next try waits this long. */
export const MATTER_BRIEF_RETRY_MINUTES = 30;
/** While one call writes a matter's brief, others leave it to that call for this long. */
export const MATTER_BRIEF_LEASE_SECONDS = 120;
/** Records due within this many days (or critical) make an item a warning. */
export const MATTER_BRIEF_WARNING_DAYS = 3;

/** How many of each kind of fact Clerk is given (the counts are always the totals). */
export const BRIEF_FACT_LIMITS = {
  deadlines: 8,
  tasks: 8,
  undatedTasks: 3,
  changes: 12,
  documents: 8,
  suggestions: 5,
} as const;

export const MatterBriefModeSchema = z.enum(['open', 'refresh']);
export type MatterBriefMode = z.infer<typeof MatterBriefModeSchema>;

/**
 * `clerk-matterBrief`: `open` (the Overview opened) returns the kept brief, rebuilding it when it
 * is stale; `refresh` (the card's Refresh) rebuilds it now, at most MATTER_BRIEF_REFRESHES_PER_DAY
 * times a day per matter.
 */
export const MatterBriefInputSchema = z.strictObject({
  matterId: DocIdSchema,
  mode: MatterBriefModeSchema.default('open'),
});
export type MatterBriefInput = z.input<typeof MatterBriefInputSchema>;

/** What the callable answers: the brief as kept (ISO instants), and whether this call rebuilt it. */
export interface MatterBriefView {
  source: 'clerk' | 'template';
  reason?: string;
  headline: string;
  items: (Omit<BriefItem, 'at'> & { at?: string })[];
  read: BriefRead;
  day: string;
  privileged: boolean;
  generatedAt: string;
  /** Another call is writing a newer brief: it arrives through the listener. */
  pending: boolean;
  /** Refresh presses left today. */
  refreshesLeft: number;
}

export interface MatterBriefResult {
  brief: MatterBriefView;
  /** `kept`: nothing changed; `rebuilt`: this call wrote it; `pending`: another call is writing it. */
  outcome: 'kept' | 'rebuilt' | 'pending';
}

// ---------- the sources ----------

/** The rows the facts are built from, already read (live rows only; the builder filters the rest). */
export interface MatterBriefSources {
  today: DateOnly;
  now: Date;
  timeZone: string;
  /**
   * The brief is shared by everyone who can read the matter, so privileged documents and
   * suggestions are left out unless the matter itself is privileged (then only privileged.view
   * roles can read it at all).
   */
  matterPrivileged: boolean;
  deadlines: readonly { id: string; title: string; dueDate?: string; status: string; critical?: boolean }[];
  tasks: readonly { id: string; title: string; dueDate?: string; status: string }[];
  activity: readonly { id: string; kind: string; summary: string; at: Date; refs: Readonly<Record<string, string>> }[];
  documents: readonly { id: string; name: string; category: string; createdAt: Date; privileged: boolean }[];
  suggestions: readonly {
    id: string;
    kind: SuggestionKind;
    payload: unknown;
    status: string;
    privileged: boolean;
    expiresAt?: Date;
  }[];
}

// ---------- the facts ----------

export interface BriefDeadlineFact {
  ref: string;
  title: string;
  due: string;
  /** Negative when overdue. */
  inDays: number;
  critical?: true;
}
export interface BriefTaskFact {
  ref: string;
  title: string;
  due?: string;
  inDays?: number;
}
export interface BriefChangeFact {
  ref: string;
  on: string;
  text: string;
}
export interface BriefDocumentFact {
  ref: string;
  name: string;
  type: string;
  added: string;
}
export interface BriefSuggestionFact {
  ref: string;
  kind: string;
  text: string;
}

/** What Clerk is given (`<matter_brief_facts>`), every date already written out. */
export interface MatterBriefFacts {
  today: string;
  counts: {
    overdueDeadlines: number;
    upcomingDeadlines: number;
    overdueTasks: number;
    upcomingTasks: number;
    openTasks: number;
    changes: number;
    documentsAdded: number;
    openSuggestions: number;
  };
  overdueDeadlines: BriefDeadlineFact[];
  upcomingDeadlines: BriefDeadlineFact[];
  overdueTasks: BriefTaskFact[];
  upcomingTasks: BriefTaskFact[];
  undatedTasks: BriefTaskFact[];
  changes: BriefChangeFact[];
  documentsAdded: BriefDocumentFact[];
  suggestions: BriefSuggestionFact[];
}

/** What a ref (`task:abc`) stands for: the chip, its tone, its newest change, and its facts' text. */
export interface BriefRefInfo {
  kind: BriefRefKind;
  id: string;
  label: string;
  tone?: 'danger' | 'warning';
  at?: Date;
  /** The fact rows that carry this ref, as JSON: the numbers and dates an item citing it may write. */
  text: string;
}

export interface MatterBriefFactSet {
  facts: MatterBriefFacts;
  refs: ReadonlyMap<string, BriefRefInfo>;
  read: BriefRead;
  /** Changes when any fact does (today included): a different hash makes the kept brief stale. */
  hash: string;
  /** Nothing due, changed or suggested: the brief says so without asking Clerk. */
  quiet: boolean;
}

const OPEN_TASK = new Set(['todo', 'in_progress', 'blocked']);
const OPEN_SUGGESTION = new Set(['proposed', 'stale']);
const LABEL_MAX = 80;

const short = (text: string, max = LABEL_MAX) => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const dayFormat = (withYear: boolean) =>
  new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });

/** "Fri 16 Oct", with the year when it isn't today's ("Mon 4 Jan 2027"). */
export function briefDay(date: DateOnly, today: DateOnly): string {
  const parts = dayFormat(date.slice(0, 4) !== today.slice(0, 4)).formatToParts(new Date(`${date}T00:00:00Z`));
  return parts
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join(' ');
}

/** "Wed 7 Oct 2026". */
export function briefToday(today: DateOnly): string {
  return dayFormat(true)
    .formatToParts(new Date(`${today}T00:00:00Z`))
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join(' ');
}

/** The ref a record goes by in the facts and in Clerk's reply. */
export const briefRef = (kind: BriefRefKind, id: string) => `${kind}:${id}`;

/** Which ref an activity line is about: the record it names, or the line itself. */
function activityRef(refs: Readonly<Record<string, string>>, id: string): { kind: BriefRefKind; id: string } {
  if (refs['deadlineId']) return { kind: 'deadline', id: refs['deadlineId'] };
  if (refs['taskId']) return { kind: 'task', id: refs['taskId'] };
  if (refs['documentId']) return { kind: 'document', id: refs['documentId'] };
  if (refs['noteId']) return { kind: 'note', id: refs['noteId'] };
  return { kind: 'activity', id };
}

/**
 * The brief's facts (AI-06c): overdue and next-14-day deadlines and tasks, a few undated open
 * tasks, the feed's lines and the documents added in the last 14 days, and the open suggestions,
 * each list capped (BRIEF_FACT_LIMITS) with the totals in `counts`. Dates are written out against
 * today, so Clerk copies them rather than working them out.
 */
export function matterBriefFacts(sources: MatterBriefSources): MatterBriefFactSet {
  const { today, now, timeZone } = sources;
  const until = addDays(today, MATTER_BRIEF_DUE_DAYS);
  const since = new Date(now.getTime() - MATTER_BRIEF_CHANGES_DAYS * 24 * 60 * 60 * 1000);
  const refs = new Map<string, BriefRefInfo>();
  const note = (
    kind: BriefRefKind,
    id: string,
    label: string,
    row: object,
    extra: { tone?: 'danger' | 'warning' | undefined; at?: Date } = {},
  ) => {
    const ref = briefRef(kind, id);
    const known = refs.get(ref);
    const tone = known?.tone === 'danger' || extra.tone === 'danger' ? 'danger' : (known?.tone ?? extra.tone);
    const at = known?.at && extra.at ? (known.at > extra.at ? known.at : extra.at) : (known?.at ?? extra.at);
    refs.set(ref, {
      kind,
      id,
      label: known?.label ?? short(label),
      ...(tone ? { tone } : {}),
      ...(at ? { at } : {}),
      text: `${known?.text ?? ''}${stableJson(row)}`,
    });
    return ref;
  };
  const toneFor = (inDays: number, critical: boolean) =>
    inDays < 0
      ? ('danger' as const)
      : inDays <= MATTER_BRIEF_WARNING_DAYS || critical
        ? ('warning' as const)
        : undefined;

  // Deadlines: upcoming ones with a date, overdue (still upcoming, or waiting to be confirmed missed).
  const dated = sources.deadlines
    .filter((row) => row.status === 'upcoming' && isDateOnly(row.dueDate))
    .map((row) => ({ row, due: row.dueDate as DateOnly }))
    .sort((a, b) => compareDates(a.due, b.due) || a.row.title.localeCompare(b.row.title));
  const deadlineFact = ({ row, due }: (typeof dated)[number]): BriefDeadlineFact => {
    const inDays = daysBetween(today, due);
    const fact: BriefDeadlineFact = {
      ref: briefRef('deadline', row.id),
      title: short(row.title, 200),
      due: briefDay(due, today),
      inDays,
      ...(row.critical ? { critical: true as const } : {}),
    };
    note('deadline', row.id, row.title, fact, { tone: toneFor(inDays, !!row.critical) });
    return fact;
  };
  const overdueDeadlineRows = dated.filter(({ due }) => compareDates(due, today) < 0);
  const upcomingDeadlineRows = dated.filter(
    ({ due }) => compareDates(due, today) >= 0 && compareDates(due, until) <= 0,
  );
  const overdueDeadlines = overdueDeadlineRows.slice(0, BRIEF_FACT_LIMITS.deadlines).map(deadlineFact);
  const upcomingDeadlines = upcomingDeadlineRows.slice(0, BRIEF_FACT_LIMITS.deadlines).map(deadlineFact);

  // Tasks: open ones, overdue and due soon by date, and a few with no date (next steps).
  const open = sources.tasks.filter((row) => OPEN_TASK.has(row.status));
  const datedTasks = open
    .filter((row) => isDateOnly(row.dueDate))
    .map((row) => ({ row, due: row.dueDate as DateOnly }))
    .sort((a, b) => compareDates(a.due, b.due) || a.row.title.localeCompare(b.row.title));
  const taskFact = ({ row, due }: (typeof datedTasks)[number]): BriefTaskFact => {
    const inDays = daysBetween(today, due);
    const fact: BriefTaskFact = {
      ref: briefRef('task', row.id),
      title: short(row.title, 200),
      due: briefDay(due, today),
      inDays,
    };
    note('task', row.id, row.title, fact, { tone: toneFor(inDays, false) });
    return fact;
  };
  const overdueTaskRows = datedTasks.filter(({ due }) => compareDates(due, today) < 0);
  const upcomingTaskRows = datedTasks.filter(
    ({ due }) => compareDates(due, today) >= 0 && compareDates(due, until) <= 0,
  );
  const overdueTasks = overdueTaskRows.slice(0, BRIEF_FACT_LIMITS.tasks).map(taskFact);
  const upcomingTasks = upcomingTaskRows.slice(0, BRIEF_FACT_LIMITS.tasks).map(taskFact);
  const undatedTasks = open
    .filter((row) => !isDateOnly(row.dueDate))
    .slice(0, BRIEF_FACT_LIMITS.undatedTasks)
    .map((row) => {
      const fact: BriefTaskFact = { ref: briefRef('task', row.id), title: short(row.title, 200) };
      note('task', row.id, row.title, fact);
      return fact;
    });

  // Documents added: privileged ones only on a privileged matter (the brief is shared).
  const added = sources.documents
    .filter((row) => row.createdAt >= since && (sources.matterPrivileged || !row.privileged))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const addedIds = new Set(added.map((row) => row.id));
  const documentsAdded = added.slice(0, BRIEF_FACT_LIMITS.documents).map((row) => {
    const fact: BriefDocumentFact = {
      ref: briefRef('document', row.id),
      name: short(row.name, 200),
      type: DOCUMENT_CATEGORY_LABELS[row.category as keyof typeof DOCUMENT_CATEGORY_LABELS] ?? 'Other',
      added: briefDay(dateOnlyAt(row.createdAt, timeZone), today),
    };
    note('document', row.id, row.name, fact, { at: row.createdAt });
    return fact;
  });

  // The feed's lines (already worded for every reader), newest first; documents added are above.
  const lines = sources.activity
    .filter((row) => row.at >= since && row.at <= now && row.summary.trim())
    .map((row) => ({ row, about: activityRef(row.refs, row.id) }))
    .filter(({ about }) => !(about.kind === 'document' && addedIds.has(about.id)))
    .sort((a, b) => b.row.at.getTime() - a.row.at.getTime());
  const changes = lines.slice(0, BRIEF_FACT_LIMITS.changes).map(({ row, about }) => {
    const fact: BriefChangeFact = {
      ref: briefRef(about.kind, about.id),
      on: briefDay(dateOnlyAt(row.at, timeZone), today),
      text: short(row.summary, 200),
    };
    note(about.kind, about.id, row.summary, fact, { at: row.at });
    return fact;
  });

  // Open suggestions a person can accept or dismiss (privileged ones only on a privileged matter).
  const openSuggestions = sources.suggestions.filter(
    (row) =>
      OPEN_SUGGESTION.has(row.status) &&
      (sources.matterPrivileged || !row.privileged) &&
      !(row.expiresAt && row.expiresAt <= now),
  );
  const suggestions = openSuggestions.slice(0, BRIEF_FACT_LIMITS.suggestions).map((row) => {
    const summary = short(
      suggestionSummary({ kind: row.kind, payload: row.payload }) || SUGGESTION_KIND_LABELS[row.kind],
      200,
    );
    const fact: BriefSuggestionFact = {
      ref: briefRef('suggestion', row.id),
      kind: SUGGESTION_KIND_LABELS[row.kind],
      text: summary,
    };
    note('suggestion', row.id, `${SUGGESTION_KIND_LABELS[row.kind]}: ${summary}`, fact);
    return fact;
  });

  const facts: MatterBriefFacts = {
    today: briefToday(today),
    counts: {
      overdueDeadlines: overdueDeadlineRows.length,
      upcomingDeadlines: upcomingDeadlineRows.length,
      overdueTasks: overdueTaskRows.length,
      upcomingTasks: upcomingTaskRows.length,
      openTasks: open.length,
      changes: lines.length,
      documentsAdded: added.length,
      openSuggestions: openSuggestions.length,
    },
    overdueDeadlines,
    upcomingDeadlines,
    overdueTasks,
    upcomingTasks,
    undatedTasks,
    changes,
    documentsAdded,
    suggestions,
  };
  const read: BriefRead = {
    deadlines: overdueDeadlines.length + upcomingDeadlines.length,
    tasks: overdueTasks.length + upcomingTasks.length + undatedTasks.length,
    changes: changes.length,
    documents: documentsAdded.length,
    suggestions: suggestions.length,
  };
  const quiet =
    !overdueDeadlines.length &&
    !upcomingDeadlines.length &&
    !overdueTasks.length &&
    !upcomingTasks.length &&
    !undatedTasks.length &&
    !changes.length &&
    !documentsAdded.length &&
    !suggestions.length;
  return { facts, refs, read, hash: hashString(stableJson(facts)), quiet };
}

// ---------- the template brief ----------

/** One item before its refs are resolved: what Clerk's reply and the template both produce. */
export interface BriefItemDraft {
  kind: BriefItemKind;
  text: string;
  refs: string[];
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const quoted = (text: string) => `“${text}”`;
const when = (inDays: number, due: string) =>
  inDays === 0 ? 'today' : inDays === 1 ? 'tomorrow' : inDays === -1 ? `yesterday (${due})` : due;

/** Today's numbers in a sentence: "2 items overdue and 3 due in the next 14 days." */
export function briefHeadline(set: Pick<MatterBriefFactSet, 'facts'>): string {
  const c = set.facts.counts;
  const overdue = c.overdueDeadlines + c.overdueTasks;
  const due = c.upcomingDeadlines + c.upcomingTasks;
  const window = `in the next ${MATTER_BRIEF_DUE_DAYS} days`;
  if (overdue && due) return `${plural(overdue, 'item')} overdue and ${due} due ${window}.`;
  if (overdue) return `${plural(overdue, 'item')} overdue, nothing else due ${window}.`;
  if (due) return `Nothing overdue; ${plural(due, 'item')} due ${window}.`;
  if (c.changes || c.documentsAdded || c.openSuggestions) return `Nothing due ${window}.`;
  return `Nothing due ${window} and no recent changes.`;
}

/**
 * The brief built from the facts alone, the same way every time: the overdue first, then what's
 * due, the next step (Clerk's open suggestions, else the next undated task), and what changed,
 * at most MATTER_BRIEF_MAX_ITEMS items. Used whenever Clerk doesn't write it, so the card is never
 * a placeholder.
 */
export function templateBrief(set: MatterBriefFactSet): { headline: string; items: BriefItemDraft[] } {
  const f = set.facts;
  const c = f.counts;
  const refsOf = (rows: readonly { ref: string }[]) => rows.slice(0, 3).map((row) => row.ref);
  const candidates: { order: number; item: BriefItemDraft }[] = [];
  const add = (order: number, kind: BriefItemKind, text: string, refs: string[]) => {
    if (refs.length) candidates.push({ order, item: { kind, text, refs } });
  };

  const [od] = f.overdueDeadlines;
  if (od)
    add(
      0,
      'due',
      c.overdueDeadlines === 1
        ? `Deadline ${quoted(od.title)} was due ${when(od.inDays, od.due)}.`
        : `${c.overdueDeadlines} deadlines are overdue, the oldest ${quoted(od.title)} (due ${od.due}).`,
      refsOf(f.overdueDeadlines),
    );
  const [ot] = f.overdueTasks;
  if (ot)
    add(
      1,
      'due',
      c.overdueTasks === 1
        ? `Task ${quoted(ot.title)} was due ${when(ot.inDays ?? 0, ot.due ?? '')}.`
        : `${c.overdueTasks} tasks are overdue, the oldest ${quoted(ot.title)} (due ${ot.due}).`,
      refsOf(f.overdueTasks),
    );
  const [ud] = f.upcomingDeadlines;
  if (ud)
    add(
      2,
      'due',
      c.upcomingDeadlines === 1
        ? `Deadline ${quoted(ud.title)} is due ${when(ud.inDays, ud.due)}.`
        : `${c.upcomingDeadlines} deadlines are due in the next ${MATTER_BRIEF_DUE_DAYS} days, the first ${quoted(ud.title)} ${ud.inDays <= 1 ? when(ud.inDays, ud.due) : `on ${ud.due}`}.`,
      refsOf(f.upcomingDeadlines),
    );
  const [s] = f.suggestions;
  const [undated] = f.undatedTasks;
  if (s)
    add(
      3,
      'next',
      c.openSuggestions === 1
        ? `Review Clerk’s suggestion: ${s.kind.toLowerCase()} ${quoted(s.text)}.`
        : `Review Clerk’s ${c.openSuggestions} suggestions, starting with the ${s.kind.toLowerCase()} ${quoted(s.text)}.`,
      [s.ref],
    );
  else if (undated) add(3, 'next', `Next on the task list: ${quoted(undated.title)}.`, [undated.ref]);
  const [doc] = f.documentsAdded;
  if (doc)
    add(
      4,
      'changed',
      c.documentsAdded === 1
        ? `${quoted(doc.name)} (${doc.type}) was added on ${doc.added}.`
        : `${c.documentsAdded} documents were added, most recently ${quoted(doc.name)} (${doc.type}) on ${doc.added}.`,
      refsOf(f.documentsAdded),
    );
  const [ut] = f.upcomingTasks;
  if (ut)
    add(
      5,
      'due',
      c.upcomingTasks === 1
        ? `Task ${quoted(ut.title)} is due ${when(ut.inDays ?? 0, ut.due ?? '')}.`
        : `${c.upcomingTasks} tasks are due in the next ${MATTER_BRIEF_DUE_DAYS} days, the first ${quoted(ut.title)} ${(ut.inDays ?? 2) <= 1 ? when(ut.inDays ?? 0, ut.due ?? '') : `on ${ut.due}`}.`,
      refsOf(f.upcomingTasks),
    );
  const [change] = f.changes;
  if (change)
    add(
      6,
      'changed',
      c.changes === 1
        ? `${change.text} (${change.on}).`
        : `${c.changes} changes in the last ${MATTER_BRIEF_CHANGES_DAYS} days, most recently: ${change.text} (${change.on}).`,
      refsOf(f.changes),
    );

  const kindOrder: Record<BriefItemKind, number> = { due: 0, changed: 1, next: 2 };
  const items = candidates
    .sort((a, b) => a.order - b.order)
    .slice(0, MATTER_BRIEF_MAX_ITEMS)
    .sort((a, b) => kindOrder[a.item.kind] - kindOrder[b.item.kind] || a.order - b.order)
    .map(({ item }) => item);
  return { headline: briefHeadline(set), items };
}

// ---------- resolving and checking ----------

/** An item's refs as chips, with its tone and newest change from what it cites. */
export function resolveBriefItem(draft: BriefItemDraft, set: Pick<MatterBriefFactSet, 'refs'>): BriefItem | null {
  const infos = [...new Set(draft.refs)]
    .map((ref) => set.refs.get(ref))
    .filter((info): info is BriefRefInfo => !!info)
    .slice(0, MATTER_BRIEF_REFS_MAX);
  if (!infos.length) return null;
  const tone = infos.some((info) => info.tone === 'danger')
    ? 'danger'
    : infos.some((info) => info.tone === 'warning') && draft.kind === 'due'
      ? 'warning'
      : undefined;
  const at = infos.reduce<Date | undefined>(
    (newest, info) => (info.at && (!newest || info.at > newest) ? info.at : newest),
    undefined,
  );
  return {
    kind: draft.kind,
    text: draft.text.trim(),
    ...(tone ? { tone } : {}),
    refs: infos.map((info) => ({ kind: info.kind, id: info.id, label: info.label })),
    ...(at ? { at } : {}),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/gi;
/** A day and month with its year when written ("16 Oct", "4 January 2027"). */
const DATE_SPAN =
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b(?:,?\s+\d{4}\b)?/gi;

/** Every "16 Oct" (or "16th October") in a text, as `16 oct`. */
export function dayMonthsIn(text: string): string[] {
  return [...text.matchAll(DAY_MONTH)].map(
    (match) => `${Number(match[1])} ${MONTHS[MONTHS.indexOf((match[2] ?? '').slice(0, 3).toLowerCase())] ?? ''}`,
  );
}

/** The totals an item may state, by the kind of record it cites ("3 tasks are overdue"). */
const COUNTS_BY_KIND: Readonly<Record<BriefRefKind, readonly (keyof MatterBriefFacts['counts'])[]>> = {
  deadline: ['overdueDeadlines', 'upcomingDeadlines'],
  task: ['overdueTasks', 'upcomingTasks', 'openTasks'],
  document: ['documentsAdded', 'changes'],
  note: ['changes'],
  activity: ['changes'],
  suggestion: ['openSuggestions'],
};

/** Numbers written outside dates ("in 9 days", "2 tasks"); dates are checked as dates. */
export function countsIn(text: string): number[] {
  return numbersIn(text.replace(DATE_SPAN, ' '));
}

export interface BriefCheckResult {
  headline: string;
  /** Clerk's headline failed its number check (or was empty) and the template's was used. */
  headlineReplaced: boolean;
  items: BriefItem[];
  /** Items dropped, by why: an unknown kind, no ref that is in the facts, a number or date not in what it cites, too long, over the cap. */
  dropped: { kind: number; refs: number; numbers: number; dates: number; length: number; extra: number };
}

/**
 * Clerk's reply, checked (AI-06c): an item must cite at least one record from the facts (refs not
 * in the facts are removed), and every number and date it writes must be in the facts it cites
 * (or today's), so it can't invent a date, a count or a deadline. The headline's numbers and dates
 * must be the facts' totals or in what its items cite, else the template's headline is used. At most MATTER_BRIEF_MAX_ITEMS items.
 */
export function checkBrief(reply: { headline?: unknown; items?: unknown }, set: MatterBriefFactSet): BriefCheckResult {
  const dropped = { kind: 0, refs: 0, numbers: 0, dates: 0, length: 0, extra: 0 };
  const todayText = set.facts.today;
  const totals = new Set<number>([
    ...Object.values(set.facts.counts),
    MATTER_BRIEF_DUE_DAYS,
    MATTER_BRIEF_CHANGES_DAYS,
  ]);
  const items: BriefItem[] = [];
  const keptSources: string[] = [todayText];
  for (const raw of Array.isArray(reply.items) ? reply.items : []) {
    const candidate = (raw ?? {}) as { kind?: unknown; text?: unknown; refs?: unknown };
    const kind = candidate.kind as BriefItemKind;
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    if (!(BRIEF_ITEM_KINDS as readonly string[]).includes(kind as string) || !text) {
      dropped.kind++;
      continue;
    }
    if (text.length > MATTER_BRIEF_TEXT_MAX) {
      dropped.length++;
      continue;
    }
    const refs = (Array.isArray(candidate.refs) ? candidate.refs : []).filter(
      (ref): ref is string => typeof ref === 'string' && set.refs.has(ref),
    );
    const cited = [...new Set(refs)].map((ref) => set.refs.get(ref) as BriefRefInfo);
    if (!cited.length) {
      dropped.refs++;
      continue;
    }
    const source = `${cited.map((info) => info.text).join(' ')} ${todayText}`;
    // Its numbers: what it cites, today, the windows, and the totals of the kinds it cites.
    const counts = set.facts.counts;
    const allowed = new Set<number>([
      ...countsIn(source),
      MATTER_BRIEF_DUE_DAYS,
      MATTER_BRIEF_CHANGES_DAYS,
      ...cited.flatMap((info) => COUNTS_BY_KIND[info.kind].map((key) => counts[key])),
    ]);
    if (countsIn(text).some((n) => !allowed.has(n))) {
      dropped.numbers++;
      continue;
    }
    const days = new Set(dayMonthsIn(source));
    if (dayMonthsIn(text).some((day) => !days.has(day))) {
      dropped.dates++;
      continue;
    }
    if (items.length >= MATTER_BRIEF_MAX_ITEMS) {
      dropped.extra++;
      continue;
    }
    const item = resolveBriefItem({ kind, text, refs }, set);
    if (!item) continue;
    items.push(item);
    keptSources.push(source);
  }
  const headline = typeof reply.headline === 'string' ? reply.headline.trim() : '';
  // The headline states the conclusion of the items it heads: its numbers are the totals or in
  // what those items cite, and so are its dates.
  const kept = keptSources.join(' ');
  const headlineNumbers = new Set<number>([...totals, items.length, ...countsIn(kept)]);
  const headlineDays = new Set(dayMonthsIn(kept));
  const headlineOk =
    !!headline &&
    headline.length <= MATTER_BRIEF_HEADLINE_MAX &&
    countsIn(headline).every((n) => headlineNumbers.has(n)) &&
    dayMonthsIn(headline).every((day) => headlineDays.has(day));
  return { headline: headlineOk ? headline : briefHeadline(set), headlineReplaced: !headlineOk, items, dropped };
}

// ---------- keeping it ----------

/**
 * Whether a kept brief must be rebuilt when the matter is opened: its facts changed (a new day
 * included), or it is older than MATTER_BRIEF_TTL_HOURS.
 */
export function matterBriefStale(kept: { factsHash: string; generatedAt: Date }, hash: string, now: Date): boolean {
  return (
    kept.factsHash !== hash || now.getTime() - kept.generatedAt.getTime() > MATTER_BRIEF_TTL_HOURS * 60 * 60 * 1000
  );
}

/** Refresh presses left today. */
export function briefRefreshesLeft(refreshes: { day: string; count: number } | undefined, today: string): number {
  const used = refreshes?.day === today ? refreshes.count : 0;
  return Math.max(0, MATTER_BRIEF_REFRESHES_PER_DAY - used);
}
