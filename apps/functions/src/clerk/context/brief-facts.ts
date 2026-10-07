import {
  matterBriefFacts,
  SuggestionKindSchema,
  type DateOnly,
  type MatterBriefFactSet,
  type MatterBriefSources,
} from '@materia/domain';

import type { ContextSource, Row } from './ports';

/**
 * How many rows the matter brief reads (AI-06c): enough to fill BRIEF_FACT_LIMITS after the live,
 * window and privilege filters, and never a whole matter.
 */
export const BRIEF_READ_LIMITS = { activity: 40, documents: 20, suggestions: 30 } as const;

type Data = Record<string, unknown>;

const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** A Firestore Timestamp or a Date as a Date (undefined for anything else). */
export function dateOf(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  const toDate = (value as { toDate?: () => Date } | undefined)?.toDate;
  return typeof toDate === 'function' ? toDate.call(value) : undefined;
}

/** The rows as `matterBriefFacts` takes them: live ones, with their dates as Dates. */
export function briefSources(input: {
  rows: { deadlines: Row[]; tasks: Row[]; activity: Row[]; documents: Row[]; suggestions: Row[] };
  matterPrivileged: boolean;
  today: DateOnly;
  now: Date;
  timeZone: string;
}): MatterBriefSources {
  const live = (rows: Row[]) => rows.filter((row) => !isDeleted(row.data));
  const { rows } = input;
  return {
    today: input.today,
    now: input.now,
    timeZone: input.timeZone,
    matterPrivileged: input.matterPrivileged,
    deadlines: live(rows.deadlines).map(({ id, data }) => ({
      id,
      title: str(data['title']),
      ...(typeof data['dueDate'] === 'string' ? { dueDate: data['dueDate'] } : {}),
      status: str(data['status']),
      critical: data['critical'] === true,
    })),
    tasks: live(rows.tasks).map(({ id, data }) => ({
      id,
      title: str(data['title']),
      ...(typeof data['dueDate'] === 'string' ? { dueDate: data['dueDate'] } : {}),
      status: str(data['status']),
    })),
    activity: rows.activity.flatMap(({ id, data }) => {
      const at = dateOf(data['at']);
      const refs = (data['refs'] ?? {}) as Record<string, unknown>;
      return at
        ? [
            {
              id,
              kind: str(data['kind']),
              summary: str(data['summary']),
              at,
              refs: Object.fromEntries(Object.entries(refs).filter(([, v]) => typeof v === 'string')) as Record<
                string,
                string
              >,
            },
          ]
        : [];
    }),
    // Documents still being scanned (no clean version yet) aren't "added" until they are.
    documents: live(rows.documents).flatMap(({ id, data }) => {
      const createdAt = dateOf(data['createdAt']);
      const clean = (data['scan'] as { status?: unknown } | undefined)?.status === 'clean';
      return createdAt && clean
        ? [
            {
              id,
              name: str(data['name']),
              category: str(data['category']),
              createdAt,
              privileged: data['privileged'] === true,
            },
          ]
        : [];
    }),
    suggestions: rows.suggestions.flatMap(({ id, data }) => {
      const kind = SuggestionKindSchema.safeParse(data['kind']);
      const expiresAt = dateOf(data['expiresAt']);
      return kind.success
        ? [
            {
              id,
              kind: kind.data,
              payload: data['payload'],
              status: str(data['status']),
              privileged: data['privileged'] === true,
              ...(expiresAt ? { expiresAt } : {}),
            },
          ]
        : [];
    }),
  };
}

/** Reads a matter's brief sources and builds its facts (the caller has checked access to the matter). */
export async function readMatterBriefFacts(
  source: ContextSource,
  input: { orgId: string; matterId: string; matterPrivileged: boolean; today: DateOnly; now: Date; timeZone: string },
): Promise<MatterBriefFactSet> {
  const { orgId, matterId } = input;
  const [deadlines, tasks, activity, documents, suggestions] = await Promise.all([
    source.openDeadlines(orgId, matterId),
    source.openTasks(orgId, matterId),
    source.recentActivity(orgId, matterId, { limit: BRIEF_READ_LIMITS.activity }),
    source.recentDocuments(orgId, matterId, { limit: BRIEF_READ_LIMITS.documents }),
    source.openSuggestions(orgId, matterId, { limit: BRIEF_READ_LIMITS.suggestions }),
  ]);
  return matterBriefFacts(
    briefSources({
      rows: { deadlines, tasks, activity, documents, suggestions },
      matterPrivileged: input.matterPrivileged,
      today: input.today,
      now: input.now,
      timeZone: input.timeZone,
    }),
  );
}
