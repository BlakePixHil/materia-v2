import { Timestamp } from 'firebase-admin/firestore';

import { systemTemplate } from '@materia/domain';

import {
  ACTIVITY_RULES,
  activityKey,
  activityRefs,
  actorUid,
  formatDay,
  ruleFor,
  type AuditEntryLike,
} from './mapping';
import { onAuditDefinition, projectActivity } from './on-audit';
import { EXCLUDED_COLLECTIONS, NOISE_FIELDS } from '../audit/entry';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the matter activity feed (CORE-13). Every org, person, matter and record is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const NOW = new Date('2026-10-05T00:00:00.000Z');
const AT = new Date('2026-10-04T23:00:00.000Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

type Data = Record<string, unknown>;

const matter = (extra: Data = {}) => ({
  ...meta,
  number: 'RM-2026-0001',
  title: 'Estate of Fictional Wren',
  type: 'probate',
  status: 'open',
  privileged: false,
  templateId: 'system-probate',
  templateVersion: systemTemplate('system-probate')?.version,
  lastActivityAt: new Date('2026-10-01T00:00:00.000Z'),
  deletedAt: null,
  ...extra,
});

function world(initial: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne' },
    [`${M}/m1`]: matter(),
    [`${M}/m-priv`]: matter({ number: 'RM-2026-0002', privileged: true }),
    [`orgs/${ORG}/contacts/c-exec`]: { ...meta, kind: 'person', givenNames: 'Robin', familyName: 'Fictional' },
    [`${M}/m1/deadlines/manual-1`]: { ...meta, title: 'Send the offer letter', dueDate: '2026-11-02' },
    [`${M}/m1/deadlines/rule-grant`]: {
      ...meta,
      title: 'Apply for the grant',
      dueDate: '2027-04-01',
      computed: { ruleId: 'grant' },
    },
    [`${M}/m1/documents/doc-1`]: { ...meta, name: 'Will of Fictional Wren.pdf', privileged: false },
    [`${M}/m1/documents/doc-priv`]: { ...meta, name: 'Counsel advice.pdf', privileged: true },
    [`${M}/m1/events/ev-custom`]: { ...meta, kind: 'custom', date: '2026-09-30', label: 'Family meeting' },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  let count = 0;
  /** Writes an audit entry and runs the trigger for its creation. */
  const fire = async (entry: Data, id = `entry-${++count}`) => {
    const path = `orgs/${ORG}/audit/${id}`;
    store.docs.set(path, { at: Timestamp.fromDate(AT), ...entry });
    const change = { before: undefined, after: { ref: { path }, data: () => store.docs.get(path) } };
    const ctx = {
      eventId: `event-${id}`,
      time: NOW,
      params: { orgId: ORG, entryId: id },
      log,
      clock,
      db: store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    const result = await projectActivity(change as unknown as TriggerChange, ctx);
    return { result, activity: store.docs.get(`${M}/${(entry['entity'] as Data)['matterId']}/activity/audit-${id}`) };
  };
  return { ...store, fire };
}

/** A semantic entry, as `audit()` records it. */
const semantic = (action: string, path: string, data: Data = {}, summary = ''): Data => ({
  action,
  actor: { uid: 'user-lawyer' },
  entity: entity(path),
  summary,
  data,
  source: 'callable',
});
/** A write entry, as the audit trigger records it. */
const write = (action: string, path: string, extra: Data = {}): Data => ({
  action,
  actor: { uid: 'user-paralegal' },
  entity: entity(path),
  changedFields: [],
  source: 'client',
  ...extra,
});
function entity(path: string) {
  const parts = path.split('/');
  return {
    path,
    collection: parts.at(-2),
    id: parts.at(-1),
    ...(parts[2] === 'matters' && parts[3] ? { matterId: parts[3] } : {}),
  };
}

const MATTER_PATH = `${M}/m1`;
const NOTE = `${M}/m1/notes/n1`;
const DEADLINE = `${M}/m1/deadlines/manual-1`;
const PARTY = `${M}/m1/parties/executor-c-exec`;

/** Every mapped key, with an entry and the line it gives on the ordinary (non-privileged) matter. */
const CASES: [string, Data, string, string][] = [
  [
    'matter.created',
    semantic('matter.created', MATTER_PATH, { status: 'open' }),
    'matter.created',
    'Opened the matter',
  ],
  [
    'matter.status_changed',
    semantic('matter.status_changed', MATTER_PATH, { from: 'open', to: 'on_hold', reason: 'Client overseas' }),
    'matter.status_changed',
    'Changed the status from Open to On hold',
  ],
  [
    'matter.stage_changed',
    semantic('matter.stage_changed', MATTER_PATH, { from: 'instructions', to: 'application_filed' }),
    'matter.stage_changed',
    'Moved to stage “Application filed (RedCrest)”',
  ],
  [
    'matter.template_applied',
    semantic('matter.template_applied', MATTER_PATH, {
      templateId: 'system-probate',
      version: systemTemplate('system-probate')?.version,
    }),
    'matter.template_applied',
    `Applied template “${systemTemplate('system-probate')?.name}”`,
  ],
  [
    'matter.template_upgraded',
    semantic('matter.template_upgraded', MATTER_PATH, { to: 3 }),
    'matter.template_upgraded',
    'Upgraded the matter’s template to version 3',
  ],
  [
    'matter.renumbered',
    semantic('matter.renumbered', MATTER_PATH, { from: 'RM-2026-0009', to: 'RM-2026-0001' }),
    'matter.renumbered',
    'Renumbered the matter to RM-2026-0001',
  ],
  ['matter.restored', semantic('matter.restored', MATTER_PATH), 'matter.restored', 'Restored the matter'],
  [
    'matter.conflict_determined',
    semantic('matter.conflict_determined', MATTER_PATH, { status: 'clear' }),
    'matter.conflict_determined',
    'Recorded the conflict check as clear',
  ],
  [
    'matter.party_added',
    semantic('matter.party_added', PARTY, { contactId: 'c-exec', role: 'executor' }),
    'matter.party_added',
    'Added Robin Fictional as executor',
  ],
  [
    'matter.party_updated',
    semantic('matter.party_updated', PARTY, { contactId: 'c-exec', role: 'other_side_solicitor' }),
    'matter.party_updated',
    'Updated Robin Fictional (other side solicitor)',
  ],
  [
    'matter.party_removed',
    semantic('matter.party_removed', PARTY, { contactId: 'c-exec', role: 'executor' }),
    'matter.party_removed',
    'Removed Robin Fictional (executor)',
  ],
  [
    'matter.event_recorded',
    semantic(
      'matter.event_recorded',
      `${M}/m1/events/ev-1`,
      { kind: 'date_of_death', date: '2026-03-12' },
      'Event date_of_death recorded on matter m1',
    ),
    'matter.event_recorded',
    'Recorded event “Date of death” (12 Mar 2026)',
  ],
  [
    'matter.event_deleted',
    semantic('matter.event_deleted', `${M}/m1/events/ev-1`),
    'matter.event_deleted',
    'Deleted an event',
  ],
  [
    'deadline.overridden',
    semantic('deadline.overridden', DEADLINE, { dueDate: '2026-11-09', reason: 'Agreed with the other side' }),
    'deadline.overridden',
    'Moved “Send the offer letter” to 9 Nov 2026',
  ],
  [
    'deadline.override_cleared',
    semantic('deadline.override_cleared', DEADLINE),
    'deadline.override_cleared',
    'Cleared the date override on “Send the offer letter”',
  ],
  ['deadline.done', semantic('deadline.done', DEADLINE), 'deadline.done', 'Completed deadline “Send the offer letter”'],
  [
    'deadline.waived',
    semantic('deadline.waived', DEADLINE),
    'deadline.waived',
    'Waived deadline “Send the offer letter”',
  ],
  [
    'deadline.missed',
    semantic('deadline.missed', DEADLINE),
    'deadline.missed',
    'Marked deadline “Send the offer letter” as missed',
  ],
  [
    'deadline.acknowledged',
    semantic('deadline.acknowledged', DEADLINE),
    'deadline.acknowledged',
    'Acknowledged deadline “Send the offer letter”',
  ],
  [
    'deadline.change_accepted',
    semantic('deadline.change_accepted', DEADLINE, { kind: 'moved', toDueDate: '2026-12-01' }),
    'deadline.change_accepted',
    'Accepted the new date for “Send the offer letter” (1 Dec 2026)',
  ],
  [
    'deadline.change_rejected',
    semantic('deadline.change_rejected', DEADLINE, { kind: 'moved' }),
    'deadline.change_rejected',
    'Kept “Send the offer letter” as it was',
  ],
  [
    'deadlines.create',
    write('create', DEADLINE, { after: { title: 'Send the offer letter', dueDate: '2026-11-02', status: 'upcoming' } }),
    'deadline.created',
    'Added deadline “Send the offer letter” due 2 Nov 2026',
  ],
  [
    'deadlines.soft_delete',
    write('soft_delete', DEADLINE),
    'deadline.deleted',
    'Deleted deadline “Send the offer letter”',
  ],
  ['deadlines.restore', write('restore', DEADLINE), 'deadline.restored', 'Restored deadline “Send the offer letter”'],
  [
    'documents.create',
    write('create', `${M}/m1/documents/doc-1`, {
      actor: { uid: 'user-lawyer' },
      after: { name: 'Will of Fictional Wren.pdf', privileged: false },
    }),
    'document.added',
    'Added document “Will of Fictional Wren.pdf”',
  ],
  [
    'documents.soft_delete',
    write('soft_delete', `${M}/m1/documents/doc-1`),
    'document.removed',
    'Removed document “Will of Fictional Wren.pdf”',
  ],
  [
    'documents.restore',
    write('restore', `${M}/m1/documents/doc-1`),
    'document.restored',
    'Restored document “Will of Fictional Wren.pdf”',
  ],
  ['note.created', semantic('note.created', NOTE, { privileged: false }), 'note.created', 'Added a note'],
  ['note.edited', semantic('note.edited', NOTE, { privileged: false }), 'note.edited', 'Edited a note'],
  ['notes.soft_delete', write('soft_delete', NOTE), 'note.deleted', 'Deleted a note'],
  ['notes.restore', write('restore', NOTE), 'note.restored', 'Restored a note'],
  [
    'notes.update',
    write('update', NOTE, { changedFields: ['pinned'], after: { pinned: true } }),
    'note.pinned',
    'Pinned a note',
  ],
];

describe('activity mapping table', () => {
  it('has a case here for every mapped key', () => {
    expect(CASES.map(([key]) => key).sort()).toEqual(Object.keys(ACTIVITY_RULES).sort());
  });

  it.each(CASES)('%s', async (key, entry, kind, summary) => {
    const w = world();
    expect(activityKey(entry as unknown as AuditEntryLike)).toBe(key);
    const { result, activity } = await w.fire(entry);
    expect(result).toBe('written');
    expect(activity).toMatchObject({ kind, summary, createdBy: 'system', updatedBy: 'system' });
    expect((activity?.['at'] as Timestamp).toDate()).toEqual(AT);
    expect(activity?.['actorUid']).toBe((entry['actor'] as { uid: string }).uid);
  });

  it('a lead, a stage moved back and an edited or custom event read accordingly', async () => {
    const w = world();
    expect((await w.fire(semantic('matter.created', MATTER_PATH, { status: 'lead' }))).activity?.['summary']).toBe(
      'Created the matter as a lead',
    );
    expect(
      (await w.fire(semantic('matter.stage_changed', MATTER_PATH, { to: 'instructions', direction: 'back' })))
        .activity?.['summary'],
    ).toBe('Moved back to stage “Instructions”');
    const edited = semantic(
      'matter.event_recorded',
      `${M}/m1/events/ev-custom`,
      { kind: 'custom', date: '2026-09-30' },
      'Event custom edited on matter m1',
    );
    expect((await w.fire(edited)).activity?.['summary']).toBe('Updated event “Family meeting” (30 Sept 2026)');
    expect(
      (await w.fire(write('update', NOTE, { changedFields: ['pinned'], after: { pinned: false } }))).activity?.[
        'summary'
      ],
    ).toBe('Unpinned a note');
    expect(
      (await w.fire(semantic('deadline.change_accepted', DEADLINE, { kind: 'removed' }))).activity?.['summary'],
    ).toBe('Accepted removing deadline “Send the offer letter”');
  });

  it('names nothing on a privileged matter or for a privileged record', async () => {
    const w = world({
      [`${M}/m-priv/deadlines/d1`]: { ...meta, title: 'Serve the without prejudice offer', dueDate: '2026-11-02' },
      [`${M}/m-priv/documents/d1`]: { ...meta, name: 'Advice on prospects.pdf', privileged: true },
    });
    const lines = await Promise.all([
      w.fire(semantic('deadline.done', `${M}/m-priv/deadlines/d1`)),
      w.fire(
        write('create', `${M}/m-priv/documents/d1`, { after: { name: 'Advice on prospects.pdf', privileged: true } }),
      ),
      w.fire(semantic('matter.party_added', `${M}/m-priv/parties/p1`, { contactId: 'c-exec', role: 'beneficiary' })),
      w.fire(
        write('create', `${M}/m1/documents/doc-priv`, { after: { name: 'Counsel advice.pdf', privileged: true } }),
      ),
      w.fire(write('soft_delete', `${M}/m1/documents/doc-priv`)),
    ]);
    expect(lines.map(({ activity }) => activity?.['summary'])).toEqual([
      'Completed a deadline',
      'Added a document',
      'Added a party as beneficiary',
      'Added a document',
      'Removed a document',
    ]);
  });

  it('skips entries without a matter, about tasks, from the migration, unmapped or for a missing matter', async () => {
    const w = world();
    const skipped = [
      semantic('member.role_changed', `orgs/${ORG}/members/user-paralegal`, { from: 'paralegal', to: 'lawyer' }),
      write('update', `orgs/${ORG}/contacts/c-exec`, { changedFields: ['familyName'] }),
      write('create', `${M}/m1/tasks/t1`, { after: { title: 'Lodge the inventory' } }),
      write('soft_delete', `${M}/m1/tasks/t1`),
      { ...write('create', `${M}/m1/documents/doc-1`, { after: { name: 'Old.pdf' } }), source: 'migration' },
      write('update', MATTER_PATH, { changedFields: ['title'] }),
      write('create', `${M}/m1/timeEntries/te-1`, { after: { minutes: 6 } }),
      semantic('matter.created', `${M}/m-missing`, { status: 'open' }),
      // A note edit through notes-update is the semantic note.edited, not this write.
      write('update', NOTE, { changedFields: ['bodyMd', 'editedAt', 'editedBy', 'mentions'] }),
      write('update', NOTE, { changedFields: ['pinned', 'privileged'], after: { pinned: true } }),
      // Rule deadlines come and go with the engine, in bulk.
      write('create', `${M}/m1/deadlines/rule-grant`, { after: { title: 'Apply for the grant', computed: {} } }),
      write('soft_delete', `${M}/m1/deadlines/rule-grant`),
      // The callables' writes behind semantic events.
      write('create', NOTE, { after: { pinned: false } }),
      write('create', PARTY, { after: { role: 'executor' } }),
      write('update', DEADLINE, { changedFields: ['override', 'dueDate'] }),
    ];
    for (const entry of skipped) {
      const { result } = await w.fire(entry);
      expect(result, JSON.stringify(entry['entity'])).toBe('skipped');
    }
    expect([...w.docs.keys()].filter((path) => path.includes('/activity/'))).toEqual([]);
    expect(ruleFor({ action: 'create', entity: { path: 'orgs/o/audit/x' } })).toBeUndefined();
  });

  it('is idempotent per audit entry and moves lastActivityAt forward', async () => {
    const w = world();
    const entry = semantic('note.created', NOTE);
    await w.fire(entry, 'same');
    await w.fire(entry, 'same');
    const lines = [...w.docs.keys()].filter((path) => path.startsWith(`${M}/m1/activity/`));
    expect(lines).toEqual([`${M}/m1/activity/audit-same`]);
    expect((w.docs.get(`${M}/m1`)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(AT);
  });

  it('refs name the audit entry, the record and a party’s contact', () => {
    const party = semantic('matter.party_added', PARTY, { contactId: 'c-exec', role: 'executor' });
    expect(activityRefs(party as unknown as AuditEntryLike, 'e1')).toEqual({
      auditId: 'e1',
      partyId: 'executor-c-exec',
      contactId: 'c-exec',
    });
    expect(activityRefs(semantic('note.edited', NOTE) as unknown as AuditEntryLike, 'e2')).toEqual({
      auditId: 'e2',
      noteId: 'n1',
    });
    expect(activityRefs(semantic('matter.restored', MATTER_PATH) as unknown as AuditEntryLike, 'e3')).toEqual({
      auditId: 'e3',
    });
  });

  it('names the actor, or the system', () => {
    expect(actorUid({ action: 'x.y', actor: { uid: 'user-a' }, entity: { path: 'p' } })).toBe('user-a');
    expect(actorUid({ action: 'x.y', actor: 'clerk', entity: { path: 'p' } })).toBe('clerk');
    expect(actorUid({ action: 'x.y', entity: { path: 'p' } })).toBe('system');
  });

  it('formats legal dates for the feed', () => {
    expect(formatDay('2026-03-12')).toBe('12 Mar 2026');
    expect(formatDay('12/03/2026')).toBeUndefined();
    expect(formatDay(undefined)).toBeUndefined();
  });
});

describe('activity-onAudit', () => {
  it('runs on new audit entries', () => {
    expect(onAuditDefinition).toMatchObject({
      name: 'activity-onAudit',
      document: 'orgs/{orgId}/audit/{entryId}',
      on: 'created',
    });
  });

  it('cannot loop: its writes are not audited', () => {
    // The feed lines are excluded from the audit log, and moving lastActivityAt alone is noise.
    expect(EXCLUDED_COLLECTIONS.has('activity')).toBe(true);
    expect(NOISE_FIELDS.has('lastActivityAt')).toBe(true);
  });
});
