import { deadlineMatchesFilters, type DeadlineLike } from './deadlines';
import { deadlineMatterCopy, matterCopyIsCurrent, recentMatterCopy, taskMatterCopy } from './matter-copies';
import { Deadline, DeadlineChange, Task } from './schemas/matter-records';
import { RecentMatter } from './schemas/views';

/** SEC-07c, SEC-07e: a matter's copies on the records other screens list. Fictional data only. */

const MATTER = {
  number: 'M-2026-0142',
  title: 'Estate of Margaret Whitfield',
  type: 'probate',
  jurisdiction: 'VIC',
  responsibleUid: 'u-priya',
  teamUids: ['u-priya', 'u-jordan'],
  status: 'active',
  privileged: false,
  deletedAt: null,
};

const row: DeadlineLike = {
  id: 't',
  title: 'Fictional deadline',
  dueDate: '2026-10-09',
  kind: 'internal',
  critical: false,
  status: 'upcoming',
};

describe('matter copies', () => {
  it('copies a matter onto its deadlines and proposals (SEC-07c)', () => {
    const copy = deadlineMatterCopy(MATTER);
    expect(copy).toEqual({
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      type: 'probate',
      jurisdiction: 'VIC',
      responsibleUid: 'u-priya',
      teamUids: ['u-priya', 'u-jordan'],
    });
    // The copy is what the filters need.
    expect(deadlineMatchesFilters(row, { team: true }, { uid: 'u-jordan', matter: copy ?? undefined })).toBe(true);
    expect(Deadline.schema.shape.matter.parse(copy)).toEqual(copy);
    expect(DeadlineChange.schema.shape.matter.parse(copy)).toEqual(copy);
    expect(
      deadlineMatterCopy({
        number: 'M-1',
        title: 'A matter',
        type: 'xx',
        jurisdiction: 'XX',
        teamUids: [1, '', 'u-a'],
      }),
    ).toEqual({ number: 'M-1', title: 'A matter', teamUids: ['u-a'] });
    expect(deadlineMatterCopy({ title: 'No number' })).toBeNull();
    expect(deadlineMatterCopy({ number: 'M-1', title: '  ' })).toBeNull();
    // A privileged matter's deadlines are only readable with privileged.view (CORE-10b): named too.
    expect(deadlineMatterCopy({ ...MATTER, privileged: true })?.title).toBe(MATTER.title);
  });

  it('marks a deleted matter, so Today leaves its records out (SEC-07e)', () => {
    const deleted = { ...MATTER, deletedAt: new Date('2026-10-01T00:00:00Z') };
    expect(deadlineMatterCopy(deleted)).toMatchObject({ number: MATTER.number, deleted: true });
    expect(taskMatterCopy(deleted)).toMatchObject({ number: MATTER.number, privileged: false, deleted: true });
    expect(recentMatterCopy(deleted)).toMatchObject({ number: MATTER.number, privileged: false, deleted: true });
    expect(taskMatterCopy({ ...deleted, privileged: true })).toEqual({ privileged: true, deleted: true });
    // Restored: no mark.
    expect(deadlineMatterCopy(MATTER)).not.toHaveProperty('deleted');
  });

  it('copies a matter onto its tasks, without a privileged matter’s name (SEC-07e, ADR-026)', () => {
    const copy = taskMatterCopy(MATTER);
    expect(copy).toEqual({ number: MATTER.number, title: MATTER.title, type: 'probate', privileged: false });
    expect(Task.schema.shape.matter.parse(copy)).toEqual(copy);
    // Its assignee may not read a privileged matter: the copy says only that it is privileged.
    const privileged = taskMatterCopy({ ...MATTER, privileged: true });
    expect(privileged).toEqual({ privileged: true });
    expect(Task.schema.shape.matter.parse(privileged)).toEqual(privileged);
    expect(Task.schema.shape.matter.parse({ privileged: true, title: MATTER.title })).toEqual({ privileged: true });
    expect(taskMatterCopy({ title: 'No number' })).toBeNull();
  });

  it('copies a matter onto a recent entry, with its flag (SEC-07e)', () => {
    const copy = recentMatterCopy(MATTER);
    expect(copy).toEqual({ number: MATTER.number, title: MATTER.title, type: 'probate', privileged: false });
    expect(recentMatterCopy({ ...MATTER, privileged: true })).toMatchObject({ title: MATTER.title, privileged: true });
    expect(RecentMatter.schema.shape.matter.parse(copy)).toEqual(copy);
    expect(recentMatterCopy({ number: 'M-1' })).toBeNull();
  });

  it('knows when a stored copy is current, field by field', () => {
    const copy = deadlineMatterCopy(MATTER);
    // Whatever order the stored map's keys come back in.
    const stored = {
      teamUids: ['u-priya', 'u-jordan'],
      type: 'probate',
      title: MATTER.title,
      number: MATTER.number,
      responsibleUid: 'u-priya',
      jurisdiction: 'VIC',
    };
    expect(matterCopyIsCurrent(stored, copy)).toBe(true);
    expect(matterCopyIsCurrent(undefined, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, title: 'Renamed' }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, teamUids: ['u-jordan', 'u-priya'] }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, responsibleUid: undefined }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, jurisdiction: null }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, deleted: true }, copy)).toBe(false);
    // A copy from before SEC-07e has no type: stale.
    expect(matterCopyIsCurrent({ ...stored, type: undefined }, copy)).toBe(false);
    expect(
      matterCopyIsCurrent(
        { number: 'M-1', title: 'A matter', teamUids: [], jurisdiction: null },
        deadlineMatterCopy({ number: 'M-1', title: 'A matter' }),
      ),
    ).toBe(true);
    expect(matterCopyIsCurrent({ privileged: true }, taskMatterCopy({ ...MATTER, privileged: true }))).toBe(true);
    expect(matterCopyIsCurrent(taskMatterCopy(MATTER), taskMatterCopy({ ...MATTER, privileged: true }))).toBe(false);
    // Nothing to copy: nothing to write.
    expect(matterCopyIsCurrent(undefined, null)).toBe(true);
  });
});
