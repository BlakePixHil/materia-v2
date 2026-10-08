import { JurisdictionSchema, MatterTypeSchema } from './schemas/enums';
import type { DeadlineMatterCopy, RecentMatterCopy, TaskMatterCopy } from './schemas/matter-records';

/*
 * Copies of a matter on the records other screens list (SEC-07c, SEC-07e): deadlines and pending
 * proposals (`DeadlineMatterCopySchema`), matter tasks (`TaskMatterCopySchema`) and recent matters
 * (`RecentMatterCopySchema`). The Deadlines and Today screens name their rows from them instead of
 * reading each row's matter. Each helper makes its copy from the matter's fields, and returns null
 * for a record without a number and title, which leaves any copy as it is.
 */

type MatterFields = Readonly<Record<string, unknown>>;

interface MatterName {
  number: string;
  title: string;
  type?: DeadlineMatterCopy['type'];
  deleted?: true;
}

/** The number, title and type every copy shares, and `deleted` while the matter is in the bin. */
function matterName(matter: MatterFields): MatterName | null {
  const { number, title } = matter;
  if (typeof number !== 'string' || !number.trim() || typeof title !== 'string' || !title.trim()) return null;
  const type = MatterTypeSchema.safeParse(matter['type']);
  return {
    number,
    title,
    ...(type.success ? { type: type.data } : {}),
    ...(isDeleted(matter) ? { deleted: true as const } : {}),
  };
}

const isDeleted = (matter: MatterFields) => (matter['deletedAt'] ?? null) !== null;

/** A deadline's (or pending proposal's) copy of its matter (`Deadline.matter`, SEC-07c). */
export function deadlineMatterCopy(matter: MatterFields): DeadlineMatterCopy | null {
  const name = matterName(matter);
  if (!name) return null;
  const { responsibleUid, teamUids } = matter;
  const jurisdiction = JurisdictionSchema.safeParse(matter['jurisdiction']);
  return {
    ...name,
    ...(jurisdiction.success ? { jurisdiction: jurisdiction.data } : {}),
    ...(typeof responsibleUid === 'string' && responsibleUid ? { responsibleUid } : {}),
    teamUids: Array.isArray(teamUids)
      ? teamUids.filter((uid): uid is string => typeof uid === 'string' && uid.length > 0)
      : [],
  };
}

/**
 * A matter task's copy of its matter (`Task.matter`, SEC-07e). A privileged matter's says only
 * that, since the task's assignee may not be allowed to read the matter (ADR-026).
 */
export function taskMatterCopy(matter: MatterFields): TaskMatterCopy | null {
  if (matter['privileged'] === true) return { privileged: true, ...(isDeleted(matter) ? { deleted: true } : {}) };
  const name = matterName(matter);
  return name ? { ...name, privileged: false } : null;
}

/** A recent matter's copy of it (`RecentMatter.matter`, SEC-07e). */
export function recentMatterCopy(matter: MatterFields): RecentMatterCopy | null {
  const name = matterName(matter);
  return name ? { ...name, privileged: matter['privileged'] === true } : null;
}

/**
 * Whether a stored copy already says what `copy` says, field by field (Firestore doesn't keep a
 * map's key order; a missing field, an undefined one and a null one are the same). True when `copy` is null,
 * since nothing would be written.
 */
export function matterCopyIsCurrent(stored: unknown, copy: object | null): boolean {
  return !copy || same(stored, copy);
}

function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => same(left[key], right[key]));
  }
  return a === b;
}
