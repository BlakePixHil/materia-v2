import { applicationConfig, type Meta, moduleMetadata, type StoryObj } from '@storybook/angular';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { dateOnly } from '@materia/domain';

import { MtButton } from '../lib/button/button';
import { MtDeadlineChip } from '../lib/deadline-chip/deadline-chip';
import { MtEmptyState } from '../lib/empty-state/empty-state';
import { MtAvatar, MtAvatarGroup, MtBadge, MtMatterTag, MtPriorityIcon, MtStatusIcon } from '../lib/markers/markers';
import { MtNote } from '../lib/note/note';
import { MT_TODAY } from '../lib/pipes/format';
import { MT_PIPES } from '../lib/pipes/pipes';
import { MtMeter, MtProgress } from '../lib/progress/progress';
import { MtDelta, MtSparkline, MtStat } from '../lib/stat/stat';
import { MtTable, MtTableCell, type MtTableColumn } from '../lib/table/table';

/** All dates in these stories are relative to this "today" (org timezone). Fictional data only. */
const TODAY = dateOnly('2026-10-03');

interface MatterRow {
  id: string;
  ref: string;
  name: string;
  type: 'probate' | 'fp' | 'will' | 'admin';
  stage: string;
  due: string;
  owner: string;
  wipCents: number;
}

const MATTERS: MatterRow[] = [
  {
    id: 'm1',
    ref: 'WE-142',
    name: 'Estate of Margaret Whitfield',
    type: 'probate',
    stage: 'Notice period',
    due: '2026-10-03',
    owner: 'Jordan Price',
    wipCents: 486000,
  },
  {
    id: 'm2',
    ref: 'WE-097',
    name: 'Nguyen v Nguyen',
    type: 'fp',
    stage: 'Evidence',
    due: '2026-10-01',
    owner: 'Daniel Kim',
    wipCents: 1892000,
  },
  {
    id: 'm3',
    ref: 'WE-151',
    name: 'Harriet and Paul Okafor',
    type: 'will',
    stage: 'Awaiting signing',
    due: '2026-10-08',
    owner: 'Jordan Price',
    wipCents: 220000,
  },
  {
    id: 'm4',
    ref: 'WE-160',
    name: 'Estate of Desmond Albert Featherstonehaugh-Whittington (deceased) and related trusts',
    type: 'admin',
    stage: 'Collecting assets',
    due: '2026-11-20',
    owner: 'Priya Shah',
    wipCents: 0,
  },
];

const TYPES = ['probate', 'fp', 'will', 'admin'] as const;
const OWNERS = ['Jordan Price', 'Daniel Kim', 'Priya Shah'];

/** 10,000 generated rows for the virtual scrolling story. */
const MANY: MatterRow[] = Array.from({ length: 10_000 }, (_, i) => ({
  id: `g${i}`,
  ref: `WE-${String(1000 + i)}`,
  name: `Sample matter ${i + 1}`,
  type: TYPES[i % 4] ?? 'will',
  stage: 'Intake',
  due: `2026-${String((i % 3) + 10).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
  owner: OWNERS[i % 3] ?? 'Jordan Price',
  wipCents: (i * 7919) % 2_000_000,
}));

const COLUMNS: MtTableColumn<MatterRow>[] = [
  { id: 'ref', header: 'Ref', cellClass: 'ref', sortable: true },
  { id: 'name', header: 'Matter', cellClass: 'title', sortable: true },
  { id: 'type', header: 'Type' },
  { id: 'stage', header: 'Stage' },
  { id: 'due', header: 'Next deadline', sortable: true },
  { id: 'owner', header: 'Owner', headerHidden: true },
  { id: 'wipCents', header: 'WIP', numeric: true, sortable: true },
];

const meta: Meta = {
  title: 'Components/Data display',
  decorators: [
    applicationConfig({ providers: [{ provide: MT_TODAY, useValue: () => TODAY }] }),
    moduleMetadata({
      imports: [
        MtBadge,
        MtMatterTag,
        MtAvatar,
        MtAvatarGroup,
        MtStatusIcon,
        MtPriorityIcon,
        MtDeadlineChip,
        MtProgress,
        MtMeter,
        MtStat,
        MtSparkline,
        MtDelta,
        MtEmptyState,
        MtNote,
        MtButton,
        MtTable,
        MtTableCell,
        ...MT_PIPES,
      ],
    }),
  ],
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const Markers: Story = {
  render: () => ({
    props: {
      tones: ['neutral', 'brand', 'success', 'warning', 'danger', 'info', 'ai'],
      types: ['will', 'poa', 'probate', 'loa', 'admin', 'fp', 'contest', 'trust'],
      statuses: ['draft', 'active', 'review', 'done', 'blocked'],
      levels: ['none', 'low', 'medium', 'high', 'urgent'],
      team: [
        { id: 'u1', name: 'Jordan Price' },
        { id: 'u2', name: 'Priya Shah' },
        { id: 'u3', name: 'Daniel Kim' },
        { id: 'u4', name: 'Jamie Park' },
        { id: 'u5', name: 'Sam Lee' },
      ],
    },
    template: `
      <div class="mt-col" style="gap: 16px">
        <div class="mt-row mt-wrap">@for (tone of tones; track tone) { <mt-badge [tone]="tone">{{ tone }}</mt-badge> }</div>
        <div class="mt-row mt-wrap">@for (type of types; track type) { <mt-matter-tag [type]="type" /> }</div>
        <div class="mt-row mt-wrap">
          <mt-avatar name="Jordan Price" colorKey="u1" size="xs" />
          <mt-avatar name="Jordan Price" colorKey="u1" size="sm" />
          <mt-avatar name="Jordan Price" colorKey="u1" />
          <mt-avatar name="Jamie Park" colorKey="u4" size="lg" [tooltip]="true" />
          <mt-avatar name="Priya Shah" colorKey="u2" size="xl" />
          <mt-avatar name="Broken image" src="/missing-avatar.png" />
          <mt-avatar name="Flagged in conflict check" hue="risk" />
          <mt-avatar name="Clerk" kind="clerk" />
          <mt-avatar name="Whitfield Estates Law" kind="org" />
          <mt-avatar-group [people]="team" />
        </div>
        <div class="mt-row mt-wrap">@for (status of statuses; track status) { <mt-status-icon [status]="status" /> }</div>
        <div class="mt-row mt-wrap">@for (level of levels; track level) { <mt-priority-icon [level]="level" /> }</div>
      </div>
    `,
  }),
};
export const MarkersDark: Story = { ...Markers, globals: { theme: 'dark' } };

export const DeadlineChips: Story = {
  render: () => ({
    template: `
      <div class="mt-row mt-wrap">
        <mt-deadline-chip due="2026-10-01" />
        <mt-deadline-chip due="2026-10-03" trace="UCPR r 78.3 · 14 days after the notice is published" />
        <mt-deadline-chip due="2026-10-05" [critical]="true" />
        <mt-deadline-chip due="2026-10-08" />
        <mt-deadline-chip due="2026-10-28" />
        <mt-deadline-chip due="2027-10-22" />
        <mt-deadline-chip due="2026-10-01" [completed]="true" label="Filed 1 Oct" />
        <mt-deadline-chip [due]="null" />
      </div>
      <p class="mt-row mt-wrap" style="margin-top: 16px; font: 400 13px/18px var(--font-sans)">
        <span>{{ 123450 | aud }}</span><span>{{ -1200 | aud }}</span><span>{{ null | aud }}</span>
        <span>{{ 24 | units }} h</span><span>{{ 24 | units: 'hm' }}</span>
        <span>{{ '2026-10-03' | dateOnly }}</span><span>{{ '2026-10-06' | relativeDate }}</span>
      </p>
    `,
  }),
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByText('Today').closest('mt-deadline-chip') as HTMLElement;
    chip.focus();
    await expect(await within(document.body).findByRole('tooltip')).toHaveTextContent('UCPR r 78.3');
  },
};
export const DeadlineChipsDark: Story = { ...DeadlineChips, globals: { theme: 'dark' } };

export const ProgressAndStats: Story = {
  render: () => ({
    props: { wip: [32, 34, 31, 36, 38, 37, 41, 40, 42, 43, 42, 44] },
    template: `
      <div class="mt-col" style="gap: 14px; max-width: 320px">
        <div class="mt-row"><span class="mt-grow">Estate administration</span><span>3 / 9</span></div>
        <mt-progress [value]="3" [max]="9" label="Estate administration" valueLabel="3 of 9 stages" />
        <div class="mt-row"><span class="mt-grow">Costs estimate used</span><span>86%</span></div>
        <mt-progress [value]="86" tone="danger" label="Costs estimate used" />
        <mt-progress [value]="64" tone="ai" size="md" label="Clerk is reading statements" />
        <mt-progress [value]="100" tone="success" label="Import complete" />
      </div>
      <div class="mt-col" style="gap: 14px; max-width: 420px; margin-top: 24px">
        <div class="mt-row" style="gap: 12px"><span style="width: 110px">Priya Shah</span><mt-meter class="mt-grow" [value]="78" [target]="75" label="Priya Shah utilisation" /></div>
        <div class="mt-row" style="gap: 12px"><span style="width: 110px">Daniel Kim</span><mt-meter class="mt-grow" [value]="62" [target]="75" tone="warning" label="Daniel Kim utilisation" /></div>
      </div>
      <div class="mt-row" style="gap: 12px; align-items: stretch; margin-top: 24px">
        <mt-stat label="Billable this week" value="18.4" unit="h" icon="clock">
          <mt-progress [value]="74" label="Billable target" /><span>of 25 h</span>
        </mt-stat>
        <mt-stat label="Work in progress" value="$42,860"><mt-sparkline [values]="wip" label="Work in progress, last 12 weeks, rising" /></mt-stat>
        <mt-stat label="Unbilled 30+ days" value="$11,205" icon="alert">
          <mt-delta value="$2,140" direction="up" [good]="false" /> since last week
        </mt-stat>
      </div>
    `,
  }),
};
export const ProgressAndStatsDark: Story = { ...ProgressAndStats, globals: { theme: 'dark' } };

export const EmptyAndNotes: Story = {
  render: () => ({
    template: `
      <div class="mt-col" style="gap: 8px; max-width: 560px">
        <mt-note>Superannuation of $412k sits outside the estate.</mt-note>
        <mt-note tone="warning"><b>Nguyen v Nguyen</b> has used 86% of the disclosed costs estimate.</mt-note>
        <mt-note tone="danger">The caveat search failed. Search again before filing.</mt-note>
      </div>
      <div class="mt-card" style="margin-top: 24px">
        <mt-empty-state
          icon="calendar"
          title="No deadlines this week"
          description="Deadlines appear here when a matter’s type, jurisdiction and date of death are set."
        >
          <button mtButton iconStart="plus">Add a deadline</button>
          <button mtButton variant="clerk" iconStart="sparkle">Find missing deadlines</button>
        </mt-empty-state>
      </div>
    `,
  }),
};
export const EmptyAndNotesDark: Story = { ...EmptyAndNotes, globals: { theme: 'dark' } };

const tableTemplate = (rows: string, extra = '') => `
  <div style="border: 1px solid var(--border-default); border-radius: 10px; overflow: hidden">
    <mt-table label="Matters" [rows]="${rows}" [columns]="columns" [rowKey]="key" [rowLabel]="name" [selectable]="true" [(selection)]="selection" ${extra}>
      <ng-template mtCell="type" let-row><mt-matter-tag [type]="row.type" /></ng-template>
      <ng-template mtCell="due" let-row><mt-deadline-chip [due]="row.due" /></ng-template>
      <ng-template mtCell="owner" let-row><mt-avatar [name]="row.owner" [colorKey]="row.owner" size="sm" /></ng-template>
      <ng-template mtCell="wipCents" let-row>{{ row.wipCents | aud }}</ng-template>
      <mt-empty-state mtTableEmpty icon="matters" title="No matters match these filters" description="Clear a filter to see more." />
    </mt-table>
  </div>
`;

const tableProps = {
  columns: COLUMNS,
  key: (row: MatterRow) => row.id,
  name: (row: MatterRow) => row.name,
  selection: ['m1'],
};

export const Table: Story = {
  render: () => ({ props: { ...tableProps, rows: MATTERS }, template: tableTemplate('rows') }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Matter' }));
    await expect(canvas.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'ascending');
    const rows = canvas.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
    (rows[0] as HTMLElement).focus();
    await userEvent.keyboard('j');
    await expect(rows[1]).toHaveFocus();
  },
};
export const TableDark: Story = { ...Table, globals: { theme: 'dark' } };

export const TableCompactOneRow: Story = {
  render: () => ({
    props: { ...tableProps, rows: MATTERS.slice(0, 1) },
    template: tableTemplate('rows', 'density="compact"'),
  }),
};

export const TableEmpty: Story = {
  render: () => ({ props: { ...tableProps, rows: [], selection: [] }, template: tableTemplate('rows') }),
};
export const TableEmptyDark: Story = { ...TableEmpty, globals: { theme: 'dark' } };

export const Table10kRows: Story = {
  name: 'Table · 10,000 rows (virtual)',
  render: () => ({
    props: { ...tableProps, rows: MANY, selection: [] },
    template: tableTemplate('rows', 'maxHeight="520px"'),
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = canvas.getByRole('table');
    await expect(table).toHaveAttribute('aria-rowcount', '10001');
    const rendered = () => canvas.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
    await expect(rendered().length).toBeLessThan(60);
    (rendered()[0] as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-index', '9999'));
    await expect(rendered().length).toBeLessThan(60);
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-index', '0'));
  },
};
