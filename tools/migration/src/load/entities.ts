import type * as z from 'zod';

import { domain } from '../domain.ts';

/**
 * What the load (MIG-06) writes, in order: each `transformed/{file}.jsonl` of the transform
 * (MIG-03), its entity, and how a re-load treats a document that is already there.
 *
 * - `doc`: an upsert by its deterministic path, under the conflict rule.
 * - `counter`: `counters/matter-{YYYY}`, never lowered (the user may have numbered matters since).
 * - `reservation`: `matterNumbers/{key}`; one held by another matter stops the load.
 *
 * Documents come from the attachment copy's `files/documents.jsonl` (MIG-05), which holds the
 * transform's lines with version 1, the sha256 and the scan filled in.
 */
export type PhaseKind = 'doc' | 'counter' | 'reservation';

interface Entity {
  schema: z.ZodType;
  path: string;
}

export interface Phase {
  /** The transform's file name, `transformed/{file}.jsonl`. */
  file: string;
  entity: Entity;
  kind: PhaseKind;
  /** The collection group a rollback queries by `migration.runId`, for `doc` phases. */
  group?: string;
  /**
   * Fields v2 keeps up to date itself (triggers, the claims sync, ingestion). A re-load keeps the
   * values a document already has, so counts and state stay right; a new document takes the
   * transform's defaults and the triggers fill them in.
   */
  reconciled: readonly string[];
  /** The file is read from this path of the run instead of `transformed/{file}.jsonl`. */
  source?: string;
}

const d = domain;

export const PHASES: readonly Phase[] = [
  { file: 'orgs', entity: d.Org, kind: 'doc', group: 'orgs', reconciled: ['security'] },
  {
    file: 'users',
    entity: d.User,
    kind: 'doc',
    group: 'users',
    reconciled: ['orgIds', 'activeOrgId', 'memberships', 'claimsVersion'],
  },
  { file: 'members', entity: d.Member, kind: 'doc', group: 'members', reconciled: ['sessionsValidAfter'] },
  { file: 'counters', entity: d.Counter, kind: 'counter', reconciled: [] },
  { file: 'matter-numbers', entity: d.MatterNumber, kind: 'reservation', reconciled: [] },
  {
    file: 'contacts',
    entity: d.Contact,
    kind: 'doc',
    group: 'contacts',
    reconciled: ['search', 'sortName', 'dedupeKey', 'matterRoles'],
  },
  {
    file: 'checklist-templates',
    entity: d.ChecklistTemplate,
    kind: 'doc',
    group: 'checklistTemplates',
    reconciled: [],
  },
  {
    file: 'matters',
    entity: d.Matter,
    kind: 'doc',
    group: 'matters',
    reconciled: [
      'search',
      'nextDeadline',
      'openTaskCount',
      'wipCents',
      'lastInvoicedOn',
      'disbursementWipCents',
      'outstandingCents',
      'lastActivityAt',
      'litigationSummary',
      'estateRegister',
      'recomputeVersion',
    ],
  },
  { file: 'parties', entity: d.Party, kind: 'doc', group: 'parties', reconciled: [] },
  {
    file: 'tasks',
    entity: d.Task,
    kind: 'doc',
    group: 'tasks',
    // `matter`: the copy of its matter that tasks-onWrite keeps (SEC-07e).
    reconciled: ['countedOpen', 'reminderSentFor', 'search', 'matter'],
  },
  { file: 'notes', entity: d.Note, kind: 'doc', group: 'notes', reconciled: [] },
  { file: 'activity', entity: d.Activity, kind: 'doc', group: 'activity', reconciled: [] },
  {
    file: 'documents',
    entity: d.MatterDocument,
    kind: 'doc',
    group: 'documents',
    reconciled: ['ingest', 'search', 'renditions', 'pageCount'],
    source: 'files/documents.jsonl',
  },
  {
    file: 'personal-tasks',
    entity: d.PersonalTask,
    kind: 'doc',
    group: 'tasks',
    reconciled: ['reminderSentFor', 'search'],
  },
];

/** Every file the transform writes under `transformed/`; anything else there is a contract change. */
export const TRANSFORMED_FILES = new Set([...PHASES.map((phase) => phase.file), 'avatars']);

/** The pattern an entity's document paths match: `orgs/{orgId}/matters` → `orgs/x/matters/y`. */
export function docPathPattern(collectionTemplate: string): RegExp {
  const escaped = collectionTemplate
    .split('/')
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}/[^/]+$`);
}

/** The org a path belongs to (`orgs/{orgId}/…`), if any. */
export function orgOf(path: string): string | undefined {
  const match = /^orgs\/([^/]+)(?:\/|$)/.exec(path);
  return match?.[1];
}
