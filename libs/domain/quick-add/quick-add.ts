import { GB } from 'chrono-node/en';

import { DEFAULT_ORG_TIMEZONE } from '../src/lib/constants';
import type { Priority } from '../src/lib/schemas/enums';
import { dateOnly, today, type DateOnly } from '../src/lib/values/date-only';

/**
 * The tasks quick-add line (CORE-08): `Lodge inventory @jordan !high due fri` becomes a title, an
 * assignee, a priority and a due date. Dates use chrono-node's day-month English parser (en-AU
 * writes 2/1 for 2 January) and are worked out from today's date in the org's time zone, as
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
const DUE_RE = /(^|\s)due\s+/giu;

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

function parseDue(text: string, ref: Date): { date: DateOnly; length: number } | null {
  const [result] = GB.parse(text, ref, { forwardDate: true });
  if (!result || result.index !== 0) return null;
  const year = result.start.get('year');
  const month = result.start.get('month');
  const day = result.start.get('day');
  if (!year || !month || !day) return null;
  try {
    return { date: dateOnly(`${year}-${pad(month)}-${pad(day)}`), length: result.text.length };
  } catch {
    return null;
  }
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
  for (const match of input.matchAll(DUE_RE)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    const phraseStart = (match.index ?? 0) + match[0].length;
    if (tokens.some((token) => start >= token.start && start < token.end)) continue;
    // The phrase runs to the next @mention or !priority (or the end).
    const rest = input.slice(phraseStart);
    const stop = rest.search(/\s[@!]/u);
    const phrase = stop < 0 ? rest : rest.slice(0, stop);
    const due = parseDue(phrase, ref);
    if (!due) continue;
    const end = phraseStart + due.length;
    tokens.push({ kind: 'due', text: input.slice(start, end), start, end });
    result.dueDate = due.date;
    break;
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
