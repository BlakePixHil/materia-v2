import {
  briefDay,
  briefHeadline,
  briefRefreshesLeft,
  briefToday,
  checkBrief,
  dayMonthsIn,
  MATTER_BRIEF_REFRESHES_PER_DAY,
  matterBriefFacts,
  matterBriefStale,
  MatterBriefInputSchema,
  templateBrief,
  type MatterBriefSources,
} from './matter-brief';
import { MatterBrief, MATTER_BRIEF_MAX_ITEMS } from './schemas/clerk';
import { dateOnly } from './values/date-only';

const TODAY = dateOnly('2026-10-07');
const NOW = new Date('2026-10-07T01:00:00.000Z'); // 12 pm in Melbourne
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function sources(overrides: Partial<MatterBriefSources> = {}): MatterBriefSources {
  return {
    today: TODAY,
    now: NOW,
    timeZone: 'Australia/Melbourne',
    matterPrivileged: false,
    deadlines: [
      { id: 'd-over', title: 'Advertise notice of intention', dueDate: '2026-10-05', status: 'upcoming' },
      { id: 'd-soon', title: 'Apply for probate', dueDate: '2026-10-16', status: 'upcoming', critical: true },
      { id: 'd-far', title: 'Distribute the estate', dueDate: '2027-01-04', status: 'upcoming' },
      { id: 'd-done', title: 'Locate the will', dueDate: '2026-09-01', status: 'done' },
      { id: 'd-blocked', title: 'File the inventory', status: 'blocked' },
    ],
    tasks: [
      { id: 't-over', title: 'Request death certificate', dueDate: '2026-10-01', status: 'todo' },
      { id: 't-soon', title: 'Call the executor', dueDate: '2026-10-08', status: 'in_progress' },
      { id: 't-undated', title: 'Open an estate bank account', status: 'todo' },
      { id: 't-done', title: 'Send the costs disclosure', dueDate: '2026-10-02', status: 'done' },
    ],
    activity: [
      { id: 'a-note', kind: 'note.created', summary: 'Added a note', at: daysAgo(1), refs: { noteId: 'n-1' } },
      { id: 'a-party', kind: 'party.added', summary: 'Added Sam Sample as executor', at: daysAgo(3), refs: {} },
      {
        id: 'a-doc',
        kind: 'document.uploaded',
        summary: 'Uploaded “Will of the late J. Citizen”',
        at: daysAgo(2),
        refs: { documentId: 'doc-will' },
      },
      { id: 'a-old', kind: 'note.created', summary: 'Added a note', at: daysAgo(30), refs: { noteId: 'n-0' } },
    ],
    documents: [
      {
        id: 'doc-will',
        name: 'Will of the late J. Citizen',
        category: 'will',
        createdAt: daysAgo(2),
        privileged: false,
      },
      {
        id: 'doc-advice',
        name: 'Counsel’s advice',
        category: 'correspondence',
        createdAt: daysAgo(1),
        privileged: true,
      },
      { id: 'doc-old', name: 'Old letter', category: 'correspondence', createdAt: daysAgo(40), privileged: false },
    ],
    suggestions: [
      {
        id: 's-1',
        kind: 'task',
        payload: { title: 'Request certified copies of the death certificate' },
        status: 'proposed',
        privileged: false,
      },
      { id: 's-priv', kind: 'task', payload: { title: 'Privileged step' }, status: 'proposed', privileged: true },
      { id: 's-done', kind: 'task', payload: { title: 'Accepted step' }, status: 'accepted', privileged: false },
    ],
    ...overrides,
  };
}

describe('matterBriefFacts', () => {
  it('writes overdue and upcoming deadlines and tasks against today, with totals', () => {
    const { facts, read } = matterBriefFacts(sources());
    expect(facts.today).toBe('Wed 7 Oct 2026');
    expect(facts.overdueDeadlines).toEqual([
      { ref: 'deadline:d-over', title: 'Advertise notice of intention', due: 'Mon 5 Oct', inDays: -2 },
    ]);
    expect(facts.upcomingDeadlines).toEqual([
      { ref: 'deadline:d-soon', title: 'Apply for probate', due: 'Fri 16 Oct', inDays: 9, critical: true },
    ]);
    expect(facts.overdueTasks.map((t) => t.ref)).toEqual(['task:t-over']);
    expect(facts.upcomingTasks).toEqual([
      { ref: 'task:t-soon', title: 'Call the executor', due: 'Thu 8 Oct', inDays: 1 },
    ]);
    expect(facts.undatedTasks).toEqual([{ ref: 'task:t-undated', title: 'Open an estate bank account' }]);
    expect(facts.counts).toMatchObject({
      overdueDeadlines: 1,
      upcomingDeadlines: 1,
      overdueTasks: 1,
      upcomingTasks: 1,
      openTasks: 3,
      documentsAdded: 1,
      openSuggestions: 1,
    });
    expect(read).toEqual({ deadlines: 2, tasks: 3, changes: 2, documents: 1, suggestions: 1 });
  });

  it('lists recent changes newest first, without the documents it already lists, and maps refs to records', () => {
    const { facts } = matterBriefFacts(sources());
    expect(facts.changes).toEqual([
      { ref: 'note:n-1', on: 'Tue 6 Oct', text: 'Added a note' },
      { ref: 'activity:a-party', on: 'Sun 4 Oct', text: 'Added Sam Sample as executor' },
    ]);
    expect(facts.documentsAdded).toEqual([
      { ref: 'document:doc-will', name: 'Will of the late J. Citizen', type: 'Will', added: 'Mon 5 Oct' },
    ]);
  });

  it('leaves privileged documents and suggestions out unless the matter itself is privileged', () => {
    const shared = matterBriefFacts(sources());
    expect(shared.refs.has('document:doc-advice')).toBe(false);
    expect(shared.refs.has('suggestion:s-priv')).toBe(false);
    const privileged = matterBriefFacts(sources({ matterPrivileged: true }));
    expect(privileged.facts.documentsAdded.map((d) => d.ref)).toEqual(['document:doc-advice', 'document:doc-will']);
    expect(privileged.facts.suggestions.map((s) => s.ref)).toEqual(['suggestion:s-1', 'suggestion:s-priv']);
  });

  it('gives each ref its tone and newest change, and changes its hash when any fact or the day does', () => {
    const set = matterBriefFacts(sources());
    expect(set.refs.get('deadline:d-over')?.tone).toBe('danger');
    expect(set.refs.get('deadline:d-soon')?.tone).toBe('warning'); // critical
    expect(set.refs.get('task:t-soon')?.tone).toBe('warning'); // tomorrow
    expect(set.refs.get('document:doc-will')?.at).toEqual(daysAgo(2));
    expect(set.refs.get('suggestion:s-1')?.label).toBe('Task: Request certified copies of the death certificate');
    expect(matterBriefFacts(sources()).hash).toBe(set.hash);
    expect(matterBriefFacts(sources({ today: dateOnly('2026-10-08') })).hash).not.toBe(set.hash);
    expect(matterBriefFacts(sources({ tasks: [] })).hash).not.toBe(set.hash);
  });

  it('is quiet when nothing is due, open, changed or suggested', () => {
    const set = matterBriefFacts(sources({ deadlines: [], tasks: [], activity: [], documents: [], suggestions: [] }));
    expect(set.quiet).toBe(true);
    expect(templateBrief(set)).toEqual({
      headline: 'Nothing due in the next 14 days and no recent changes.',
      items: [],
    });
  });
});

describe('templateBrief', () => {
  it('builds at most five items, due first, every one citing a record', () => {
    const brief = templateBrief(matterBriefFacts(sources()));
    expect(brief.headline).toBe('2 items overdue and 2 due in the next 14 days.');
    expect(brief.items.length).toBe(MATTER_BRIEF_MAX_ITEMS);
    expect(brief.items.map((item) => item.kind)).toEqual(['due', 'due', 'due', 'changed', 'next']);
    expect(brief.items[0]).toEqual({
      kind: 'due',
      text: 'Deadline “Advertise notice of intention” was due Mon 5 Oct.',
      refs: ['deadline:d-over'],
    });
    expect(brief.items[2]?.text).toBe('Deadline “Apply for probate” is due Fri 16 Oct.');
    expect(brief.items[3]?.text).toBe('“Will of the late J. Citizen” (Will) was added on Mon 5 Oct.');
    expect(brief.items[4]?.text).toBe(
      'Review Clerk’s suggestion: task “Request certified copies of the death certificate”.',
    );
    for (const item of brief.items) expect(item.refs.length).toBeGreaterThan(0);
  });

  it('passes its own checks', () => {
    const set = matterBriefFacts(sources());
    const brief = templateBrief(set);
    const checked = checkBrief(brief, set);
    expect(checked.items.length).toBe(brief.items.length);
    expect(checked.headlineReplaced).toBe(false);
    expect(Object.values(checked.dropped).every((n) => n === 0)).toBe(true);
  });

  it('suggests the next undated task when nothing is suggested', () => {
    const brief = templateBrief(matterBriefFacts(sources({ suggestions: [], deadlines: [], documents: [] })));
    expect(brief.items.find((item) => item.kind === 'next')).toEqual({
      kind: 'next',
      text: 'Next on the task list: “Open an estate bank account”.',
      refs: ['task:t-undated'],
    });
  });

  it('counts several overdue deadlines in one item', () => {
    const brief = templateBrief(
      matterBriefFacts(
        sources({
          deadlines: [
            { id: 'd1', title: 'First', dueDate: '2026-10-01', status: 'upcoming' },
            { id: 'd2', title: 'Second', dueDate: '2026-10-03', status: 'upcoming' },
          ],
        }),
      ),
    );
    expect(brief.items[0]).toEqual({
      kind: 'due',
      text: '2 deadlines are overdue, the oldest “First” (due Thu 1 Oct).',
      refs: ['deadline:d1', 'deadline:d2'],
    });
  });
});

describe('checkBrief', () => {
  const set = matterBriefFacts(sources());

  it('keeps items that cite facts, resolving refs to chips with tone and newest change', () => {
    const result = checkBrief(
      {
        headline: 'Probate is due Fri 16 Oct; 2 items are overdue.',
        items: [
          { kind: 'due', text: 'Apply for probate by Fri 16 Oct, in 9 days.', refs: ['deadline:d-soon'] },
          { kind: 'changed', text: 'The will was added on Mon 5 Oct.', refs: ['document:doc-will'] },
        ],
      },
      set,
    );
    expect(result.headline).toBe('Probate is due Fri 16 Oct; 2 items are overdue.');
    expect(result.items).toEqual([
      {
        kind: 'due',
        text: 'Apply for probate by Fri 16 Oct, in 9 days.',
        tone: 'warning',
        refs: [{ kind: 'deadline', id: 'd-soon', label: 'Apply for probate' }],
      },
      {
        kind: 'changed',
        text: 'The will was added on Mon 5 Oct.',
        refs: [{ kind: 'document', id: 'doc-will', label: 'Will of the late J. Citizen' }],
        at: daysAgo(2),
      },
    ]);
  });

  it('drops items citing nothing in the facts, invented numbers and dates, and unknown kinds', () => {
    const result = checkBrief(
      {
        headline: 'Probate is due on 20 Oct.',
        items: [
          { kind: 'due', text: 'Something made up.', refs: ['deadline:invented'] },
          { kind: 'due', text: 'Apply for probate in 3 days.', refs: ['deadline:d-soon'] },
          { kind: 'due', text: 'Apply for probate by 16 Nov.', refs: ['deadline:d-soon'] },
          { kind: 'advice', text: 'Sue them.', refs: ['deadline:d-soon'] },
          { kind: 'next', text: 'Call the executor tomorrow.', refs: ['task:t-soon', 'task:nope'] },
        ],
      },
      set,
    );
    expect(result.dropped).toMatchObject({ refs: 1, numbers: 1, dates: 1, kind: 1 });
    expect(result.items.map((item) => item.text)).toEqual(['Call the executor tomorrow.']);
    expect(result.items[0]?.refs).toEqual([{ kind: 'task', id: 't-soon', label: 'Call the executor' }]);
    expect(result.headlineReplaced).toBe(true);
    expect(result.headline).toBe(briefHeadline(set));
  });

  it('keeps at most five items', () => {
    const items = Array.from({ length: 8 }, () => ({
      kind: 'due',
      text: 'Apply for probate.',
      refs: ['deadline:d-soon'],
    }));
    const result = checkBrief({ headline: 'Busy.', items }, set);
    expect(result.items.length).toBe(MATTER_BRIEF_MAX_ITEMS);
    expect(result.dropped.extra).toBe(3);
  });
});

describe('the kept brief', () => {
  it('is stale when its facts changed or it is over a day old', () => {
    const kept = { factsHash: 'abc', generatedAt: new Date(NOW.getTime() - 60 * 60 * 1000) };
    expect(matterBriefStale(kept, 'abc', NOW)).toBe(false);
    expect(matterBriefStale(kept, 'def', NOW)).toBe(true);
    expect(matterBriefStale({ ...kept, generatedAt: daysAgo(1.1) }, 'abc', NOW)).toBe(true);
  });

  it('counts refreshes per day', () => {
    expect(briefRefreshesLeft(undefined, '2026-10-07')).toBe(MATTER_BRIEF_REFRESHES_PER_DAY);
    expect(briefRefreshesLeft({ day: '2026-10-07', count: 2 }, '2026-10-07')).toBe(1);
    expect(briefRefreshesLeft({ day: '2026-10-07', count: 5 }, '2026-10-07')).toBe(0);
    expect(briefRefreshesLeft({ day: '2026-10-06', count: 3 }, '2026-10-07')).toBe(3);
  });

  it('is shaped by the entity schema and takes no client updates', () => {
    expect(Object.keys(MatterBrief.update.shape)).toEqual([]);
    expect(MatterBrief.path).toBe('orgs/{orgId}/matters/{matterId}/briefs');
    expect(MatterBriefInputSchema.parse({ matterId: 'm-1' })).toEqual({ matterId: 'm-1', mode: 'open' });
    expect(MatterBriefInputSchema.safeParse({ matterId: 'm-1', mode: 'other' }).success).toBe(false);
  });
});

describe('dates', () => {
  it('writes days against today, with the year only when it differs', () => {
    expect(briefDay(dateOnly('2026-10-16'), TODAY)).toBe('Fri 16 Oct');
    expect(briefDay(dateOnly('2027-01-04'), TODAY)).toBe('Mon 4 Jan 2027');
    expect(briefToday(TODAY)).toBe('Wed 7 Oct 2026');
    expect(dayMonthsIn('Due 16th October and Fri 4 Jan 2027, not 32')).toEqual(['16 oct', '4 jan']);
  });
});
