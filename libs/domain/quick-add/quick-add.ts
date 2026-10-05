import { casual as US, GB } from 'chrono-node/en';

import { DEFAULT_ORG_TIMEZONE } from '../src/lib/constants';
import type { Priority } from '../src/lib/schemas/enums';
import { dateOnly, today, type DateOnly } from '../src/lib/values/date-only';

/**
 * The tasks quick-add line (CORE-08): `Lodge inventory @jordan !high due fri` becomes a title, an
 * assignee, a priority and a due date. A date is found anywhere in the line, with or without
 * `due`/`by`/`on` (CORE-08b): `fri`, `this Tuesday`, `tmrw`, `in 3 days`, `14 Oct`, `Oct 14`,
 * `14/10/2026`, `14-10-26`, `14.10.2026`, `2026-10-14`. Dates use chrono-node's day-month English
 * parser (en-AU writes 2/1 for 2 January) and are worked out from today's date in the org's time zone, as
 * calendar dates: a pinned `now` and zone give the same answer on any machine, across DST changes,
 * and a day-month without a year is the next one to come (`due 2 Jan` typed on 20 December is next
 * year). This module pulls in chrono-node, so import it from lazily loaded routes only.
 */

export interface QuickAddMember {
  uid: string;
  displayName: string;
  /** Matched too (`@JP`). */
  initials?: string | undefined;
}

export interface QuickAddOptions {
  /** Who `@name` may refer to: the org's current members. */
  members: readonly QuickAddMember[];
  /** The current instant (pin it in tests). */
  now: Date;
  /** The org's time zone (`Australia/Melbourne` by default). */
  timeZone?: string | undefined;
  /**
   * Date phrases the user dismissed (as `dateKey` gives them): they stay in the title and are no
   * longer read as the due date.
   */
  ignoreDates?: readonly string[] | undefined;
}

/** How a dismissed date phrase is remembered: lower case, single spaces, without `due`/`by`/`on`. */
export function dateKey(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/^(?:due|by|on|before)\s+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export type QuickAddTokenKind = 'assignee' | 'priority' | 'due';

/** A recognised part of the input, `[start, end)` in the input string, for highlighting. */
export interface QuickAddToken {
  kind: QuickAddTokenKind;
  text: string;
  start: number;
  end: number;
}

export interface QuickAddResult {
  /** The input without the recognised parts (whitespace collapsed). Empty means nothing to save. */
  title: string;
  assigneeUid?: string;
  priority?: Priority;
  dueDate?: DateOnly;
  tokens: QuickAddToken[];
  /** `@names` that matched no member (`unknown`) or several (`ambiguous`, with the candidates' uids). */
  unresolved: { text: string; reason: 'unknown' | 'ambiguous'; candidates: string[] }[];
}

const PRIORITY_WORDS: Readonly<Record<string, Priority>> = {
  urgent: 'urgent',
  urg: 'urgent',
  u: 'urgent',
  high: 'high',
  hi: 'high',
  h: 'high',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  low: 'low',
  lo: 'low',
  l: 'low',
  none: 'none',
};

const PRIORITY_RE = /(^|\s)!([a-z]+)(?=\s|$)/giu;
const MENTION_RE = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}.'’-]*)/gu;
/** Words before a date that belong to it (`due fri`, `by Friday`). */
const DATE_LEAD_RE = /(?:^|\s)(?:due|by|on|before)\s+$/iu;
/** `Oct 14`: month first, which the day-month parser reads as October 2014. */
const MONTH_DAY_RE = /^[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?$/iu;
/** Phrases chrono reads as a date that aren't a due date in a task title. */
const NOT_A_DUE_DATE = new Set(['now', 'tonight', 'this morning', 'this afternoon', 'this evening']);

const fold = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/** Members a mention matches: the whole name (no spaces), a word of it, or the initials, by prefix. */
function matchMembers(token: string, members: readonly QuickAddMember[]): QuickAddMember[] {
  const needle = fold(token);
  if (!needle) return [];
  const exact = members.filter((m) => fold(m.displayName) === needle || (m.initials && fold(m.initials) === needle));
  if (exact.length) return exact;
  return members.filter(
    (m) =>
      fold(m.displayName).startsWith(needle) ||
      m.displayName.split(/\s+/u).some((word) => fold(word).startsWith(needle)),
  );
}

/** The reference chrono reads relative dates from: noon (host time) on the org's calendar date. */
function reference(todayDate: DateOnly): Date {
  const [y, m, d] = todayDate.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

const pad = (n: number) => String(n).padStart(2, '0');

function toDateOnly(year: number | null, month: number | null, day: number | null): DateOnly | null {
  if (!year || !month || !day) return null;
  try {
    return dateOnly(`${year}-${pad(month)}-${pad(day)}`);
  } catch {
    return null;
  }
}

/**
 * The first date in the text (other tokens already blanked out), as `[start, end)` and a calendar
 * date. A phrase counts only when it names a day (`14 Oct`, `tomorrow`) or a weekday (`fri`): a
 * bare month or a time (`March`, `at 5`) doesn't make a due date.
 */
function findDue(
  text: string,
  ref: Date,
  ignored: ReadonlySet<string>,
): { date: DateOnly; start: number; end: number } | null {
  for (const result of GB.parse(text, ref, { forwardDate: true })) {
    const phrase = result.text.trim();
    if (NOT_A_DUE_DATE.has(phrase.toLowerCase()) || ignored.has(dateKey(phrase))) continue;
    // Month first (`Oct 14`) reads as October 2014 day-month: read it month-day instead.
    const read = MONTH_DAY_RE.test(phrase) ? US.parse(phrase, ref, { forwardDate: true })[0]?.start : result.start;
    if (!read || (!read.isCertain('day') && !read.isCertain('weekday'))) continue;
    const date = toDateOnly(read.get('year'), read.get('month'), read.get('day'));
    if (!date) continue;
    let from = result.index;
    const lead = DATE_LEAD_RE.exec(text.slice(0, from));
    if (lead) from -= lead[0].trimStart().length;
    return { date, start: from, end: result.index + result.text.length };
  }
  return null;
}

/** Parses a quick-add line. Unrecognised `!words` and unmatched `@names` stay in the title. */
export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddResult {
  const timeZone = options.timeZone ?? DEFAULT_ORG_TIMEZONE;
  const tokens: QuickAddToken[] = [];
  const unresolved: QuickAddResult['unresolved'] = [];
  const result: Omit<QuickAddResult, 'title' | 'tokens' | 'unresolved'> = {};

  for (const match of input.matchAll(PRIORITY_RE)) {
    const priority = PRIORITY_WORDS[(match[2] ?? '').toLowerCase()];
    if (!priority) continue;
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const end = start + 1 + (match[2] ?? '').length;
    tokens.push({ kind: 'priority', text: input.slice(start, end), start, end });
    // The last one wins: typing "!low … !high" changes your mind.
    result.priority = priority;
  }

  for (const match of input.matchAll(MENTION_RE)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const name = (match[2] ?? '').replace(/[.'’-]+$/u, '');
    let end = start + 1 + name.length;
    const found = matchMembers(name, options.members);
    if (found.length === 1 && found[0]) {
      // "@Jordan Price": take the rest of the member's name when it follows.
      const words = found[0].displayName.split(/\s+/u).map(fold);
      let next = words.indexOf(fold(name)) + 1;
      while (next > 0 && next < words.length) {
        const following = /^\s+([^\s@!]+)/u.exec(input.slice(end));
        if (!following?.[1] || fold(following[1]) !== words[next]) break;
        end += following[0].length;
        next += 1;
      }
      tokens.push({ kind: 'assignee', text: input.slice(start, end), start, end });
      result.assigneeUid = found[0].uid;
    } else {
      unresolved.push({
        text: input.slice(start, end),
        reason: found.length ? 'ambiguous' : 'unknown',
        candidates: found.map((m) => m.uid),
      });
    }
  }

  const ref = reference(today(timeZone, options.now));
  // Blank out the @mentions and !priorities so a date can't run into them.
  let masked = input;
  for (const token of tokens) {
    masked = masked.slice(0, token.start) + ' '.repeat(token.end - token.start) + masked.slice(token.end);
  }
  const due = findDue(masked, ref, new Set((options.ignoreDates ?? []).map(dateKey)));
  if (due) {
    tokens.push({ kind: 'due', text: input.slice(due.start, due.end), start: due.start, end: due.end });
    result.dueDate = due.date;
  }

  tokens.sort((a, b) => a.start - b.start);
  let title = '';
  let at = 0;
  for (const token of tokens) {
    title += `${input.slice(at, token.start)} `;
    at = token.end;
  }
  title += input.slice(at);
  return { title: title.replace(/\s+/gu, ' ').trim(), ...result, tokens, unresolved };
}

/**
 * A date typed on its own (the due date dialog): `fri`, `14/10/2026`, `next tue`. `null` when the
 * text is anything more or less than a date.
 */
export function parseDatePhrase(text: string, options: Pick<QuickAddOptions, 'now' | 'timeZone'>): DateOnly | null {
  const result = parseQuickAdd(text, { members: [], now: options.now, timeZone: options.timeZone });
  return result.dueDate && !result.title ? result.dueDate : null;
}
