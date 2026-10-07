import type { Phase } from './entities.ts';
import { FILE_MISSING, FILE_NOT_COPIED, type LoadLine } from './run-files.ts';
import type { WriteOp } from './target.ts';
import { changedFields, editedAfterLoad, provenanceOf, type Data } from './values.ts';
import { REVIEW_CODES } from '../transform/context.ts';

/** The review codes the transform and load stamp; others on a record are the app's (MIG-09's). */
const LOAD_CODES: ReadonlySet<string> = new Set([...REVIEW_CODES, FILE_MISSING, FILE_NOT_COPIED]);

/**
 * What the load does with one line, given what v2 already holds at its path:
 * - `create`: nothing there yet;
 * - `update`: a document this migration loaded, unchanged by anyone since, that differs;
 * - `unchanged`: the same as the line (a re-run after an interruption writes nothing again);
 * - `user_edited`: someone changed it in v2 after the load, so it is left alone (`MIG_C_USER_EDITED`);
 * - `not_migrated`: something v2 made itself is at the path (an account's own `users/{uid}`), left alone;
 * - `raise` / `keep`: a matter counter moved up to the run's, or already past it;
 * - `clash`: a matter number held by another matter, which stops the load.
 */
export type Decision = 'create' | 'update' | 'unchanged' | 'user_edited' | 'not_migrated' | 'raise' | 'keep' | 'clash';

export interface Planned {
  path: string;
  legacyPath: string;
  decision: Decision;
  op?: WriteOp;
  /** The fields an update changes. */
  changed?: string[];
}

/** The conflict codes the load reports (Legacy migration plan, Load). */
export const CONFLICT_CODES: Partial<Record<Decision, string>> = {
  user_edited: 'MIG_C_USER_EDITED',
  not_migrated: 'MIG_C_NOT_MIGRATED',
  clash: 'MIG_C_NUMBER_TAKEN',
};

export function planLine(phase: Phase, line: LoadLine, existing: Data | undefined, now: Date): Planned {
  const base = { path: line.path, legacyPath: line.legacyPath };
  const set = (data: Data): WriteOp => ({ op: 'set', path: line.path, data });
  if (phase.kind === 'counter') {
    if (!existing) return { ...base, decision: 'create', op: set(line.data) };
    const ours = Number(line.data['next']);
    if (Number(existing['next'] ?? 0) >= ours) return { ...base, decision: 'keep' };
    return {
      ...base,
      decision: 'raise',
      op: set({ ...existing, next: ours, updatedAt: now, updatedBy: 'system' }),
      changed: ['next'],
    };
  }
  if (phase.kind === 'reservation') {
    if (!existing) return { ...base, decision: 'create', op: set(line.data) };
    return { ...base, decision: existing['matterId'] === line.data['matterId'] ? 'unchanged' : 'clash' };
  }

  if (!existing) return { ...base, decision: 'create', op: set(line.data) };
  const loaded = provenanceOf(existing);
  if (!loaded) return { ...base, decision: 'not_migrated' };
  if (editedAfterLoad(existing)) return { ...base, decision: 'user_edited' };

  const next = reconcile(phase, line.data, existing);
  // Compared as loaded: only the content decides whether to write. A record a later run (a delta)
  // finds unchanged keeps the run that wrote it, so rolling the delta back leaves it.
  const comparable = { ...next, migration: existing['migration'] };
  const changed = changedFields(comparable, existing);
  if (!changed.length) return { ...base, decision: 'unchanged' };
  return { ...base, decision: 'update', op: set(next), changed };
}

/**
 * A line as v2 should hold it now: the fields v2 maintains itself (the phase's `reconciled`, such
 * as counts and search) as v2 has them; the person's review (MIG-08, D-22); and when a trigger
 * stamped the document after the load (`updatedBy: 'system'`), that stamp.
 */
export function reconcile(phase: Phase, data: Data, existing: Data): Data {
  const next: Data = { ...data };
  for (const field of phase.reconciled) {
    if (field in existing) next[field] = existing[field];
  }
  reconcileReview(next, existing);
  const loaded = provenanceOf(existing)?.loadedAt.getTime();
  const updated = existing['updatedAt'] instanceof Date ? existing['updatedAt'].getTime() : undefined;
  if (existing['updatedBy'] === 'system' && loaded !== undefined && updated !== undefined && updated >= loaded) {
    next['updatedAt'] = existing['updatedAt'];
    next['updatedBy'] = 'system';
  }
  return next;
}

const codesIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];

/**
 * The review is the app's once loaded (MIG-08, D-22): a code the person reviewed or put right stays
 * reviewed rather than open again, and a code the app added (MIG-09's unreadable file) stays open.
 * So a re-run or delta that brings the same codes writes nothing for them.
 */
function reconcileReview(next: Data, existing: Data): void {
  const reviewed = codesIn(existing['reviewed']);
  const appCodes = codesIn(existing['needsReview']).filter((code) => !LOAD_CODES.has(code));
  if (!reviewed.length && !appCodes.length) return;
  const open = [...new Set([...codesIn(next['needsReview']), ...appCodes])].filter((code) => !reviewed.includes(code));
  if (open.length) next['needsReview'] = open;
  else delete next['needsReview'];
  if (reviewed.length) next['reviewed'] = existing['reviewed'];
}
