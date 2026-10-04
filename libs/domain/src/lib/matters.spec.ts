import {
  canTransition,
  ChangeMatterStatusInput,
  CreateMatterInput,
  DEFAULT_MATTER_VIEWS,
  formatMatterNumber,
  initialMatterStatus,
  isMatterNumberFormat,
  MATTER_TRANSITIONS,
  matterCounterId,
  matterNumberYear,
  matterSearchTokens,
  transitionRequirements,
} from './matters';
import { Matter } from './schemas/contacts-matters';
import { MatterStatusSchema } from './schemas/enums';
import { SavedView } from './schemas/views';

describe('matter numbers', () => {
  it.each([
    ['M-{YYYY}-{seq:4}', 2026, 7, 'M-2026-0007'],
    ['M-{YYYY}-{seq:4}', 2026, 12345, 'M-2026-12345'],
    ['{YY}/{seq:3}', 2027, 42, '27/042'],
    ['HP{seq}', 2026, 3, 'HP3'],
    ['no sequence', 2026, 5, 'M-2026-0005'],
    ['{seq}-{bogus}', 2026, 5, 'M-2026-0005'],
  ])('%s, %i, %i → %s', (format, year, seq, expected) => {
    expect(formatMatterNumber(format, year, seq)).toBe(expected);
  });

  it('validates formats', () => {
    expect(isMatterNumberFormat('M-{YYYY}-{seq:4}')).toBe(true);
    expect(isMatterNumberFormat('M-{YYYY}')).toBe(false);
    expect(isMatterNumberFormat('{seq}{x}')).toBe(false);
  });

  it('rolls the year over at midnight in Melbourne, not UTC', () => {
    // 2026-12-31T13:00Z is 00:00 on 1 January 2027 in Melbourne (AEDT, UTC+11).
    expect(matterNumberYear(new Date('2026-12-31T12:59:59Z'))).toBe(2026);
    expect(matterNumberYear(new Date('2026-12-31T13:00:00Z'))).toBe(2027);
    expect(matterNumberYear(new Date('2026-12-31T13:00:00Z'), 'Australia/Perth')).toBe(2026);
    expect(matterCounterId(2027)).toBe('matter-2027');
  });
});

describe('status machine', () => {
  const statuses = MatterStatusSchema.options;
  const allowed = new Set([
    'lead→open',
    'open→on_hold',
    'on_hold→open',
    'open→closed',
    'closed→open',
    'closed→archived',
  ]);

  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(allowed.has(`${from}→${to}`));
  });

  it('lists exactly the six allowed transitions', () => {
    const count = Object.values(MATTER_TRANSITIONS).reduce((sum, targets) => sum + targets.length, 0);
    expect(count).toBe(allowed.size);
  });

  it('needs a clear conflict check to open a lead and a reason to reopen', () => {
    expect(transitionRequirements('lead', 'open')).toEqual(['conflict_clear']);
    expect(transitionRequirements('closed', 'open')).toEqual(['reason']);
    expect(transitionRequirements('open', 'closed')).toEqual([]);
    expect(initialMatterStatus('clear')).toBe('open');
    expect(initialMatterStatus('pending')).toBe('lead');
    expect(initialMatterStatus(undefined)).toBe('lead');
  });
});

describe('matter search tokens', () => {
  it('indexes the number with and without separators, title, names and external ref', () => {
    const tokens = matterSearchTokens({
      number: 'M-2026-0007',
      title: 'Estate of Nguyễn',
      clientNames: ["Patrick O'Brien"],
      deceasedName: 'Thi Mai Nguyễn',
      externalRef: 'LEG/481',
    });
    expect(tokens).toEqual(
      expect.arrayContaining(['m2026', 'm20260007', '2026', '0007', 'estate', 'nguyen', 'obrien', 'leg', 'leg481']),
    );
  });
});

describe('matter inputs and views', () => {
  it('lets clients edit only the whitelisted fields', () => {
    expect(Object.keys(Matter.update.shape).sort()).toEqual(
      ['estate', 'externalRef', 'labels', 'priority', 'responsibleUid', 'stageId', 'teamUids', 'title'].sort(),
    );
  });

  it('keeps number and status out of the create input', () => {
    expect(Object.keys(CreateMatterInput.shape.matter.shape)).not.toContain('status');
    expect(Object.keys(CreateMatterInput.shape.matter.shape)).not.toContain('number');
    expect(
      ChangeMatterStatusInput.safeParse({ requestId: crypto.randomUUID(), matterId: 'm1', to: 'paused' }).success,
    ).toBe(false);
  });

  it('defines the five default views, with My open matters first', () => {
    expect(DEFAULT_MATTER_VIEWS.map((view) => view.name)).toEqual([
      'My open matters',
      'All open',
      'Leads',
      'On hold',
      'Recently closed',
    ]);
    for (const view of DEFAULT_MATTER_VIEWS) {
      const { filters, sort, groupBy, name } = view;
      expect(SavedView.create.safeParse({ orgId: 'o1', list: 'matters', name, filters, sort, groupBy }).success).toBe(
        true,
      );
    }
  });
});
