import { signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { applicationConfig, type Meta, moduleMetadata, type StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { dateOnly } from '@materia/domain';

import { MtButton } from '../lib/button/button';
import { MtChoiceCards } from '../lib/choice-card/choice-card';
import { MtEstateStepper } from '../lib/estate-stepper/estate-stepper';
import { MtIconButton } from '../lib/icon-button/icon-button';
import { MtIntegrationCard } from '../lib/integration-card/integration-card';
import { type KeyFactVm, MtFactCitation, MtKeyFacts } from '../lib/key-facts/key-facts';
import { MtBadge } from '../lib/markers/markers';
import { type MatterCardVm, MtMatterCard } from '../lib/matter-card/matter-card';
import { MtPersonHeader } from '../lib/person-header/person-header';
import { MT_TODAY } from '../lib/pipes/format';
import { MtSettingsRow, MtSettingsSection } from '../lib/settings-row/settings-row';
import { MtStepList } from '../lib/step-list/step-list';
import { MtSwitch } from '../lib/switch/switch';
import { MtTaskRow, type TaskRowVm } from '../lib/task-row/task-row';
import { MtTimeEntry, type TimeEntryVm } from '../lib/time-entry/time-entry';
import { MtTimeline, type TimelineItemVm } from '../lib/timeline/timeline';

/** All dates are relative to this "today" (org timezone). Fictional data only, as in the design system. */
const TODAY = dateOnly('2026-10-03');

const TASKS: TaskRowVm[] = [
  {
    id: 't1',
    title: 'Publish notice of intended application',
    done: false,
    subtitle: 'WE-142 · Whitfield',
    matterType: 'probate',
    assignee: { id: 'u1', name: 'Jordan Price' },
    deadline: { due: dateOnly('2026-10-03'), critical: true, trace: 'UCPR r 78.3 · at least 14 days before filing' },
    priority: 'urgent',
  },
  {
    id: 't2',
    title: 'Serve the plaintiff’s affidavit on the other parties and file a notice of service with the registry',
    done: false,
    subtitle: 'WE-097 · Nguyen v Nguyen',
    matterType: 'fp',
    assignee: { id: 'u3', name: 'Daniel Kim' },
    deadline: { due: dateOnly('2026-10-01') },
    priority: 'high',
  },
  {
    id: 't3',
    title: 'Book will signing',
    done: false,
    subtitle: 'WE-151 · Okafor',
    matterType: 'will',
    deadline: { due: dateOnly('2026-10-05') },
    priority: 'medium',
  },
  {
    id: 't4',
    title: 'Caveat search',
    done: true,
    subtitle: 'WE-142 · Whitfield',
    deadline: { due: dateOnly('2026-10-02') },
  },
];

const MATTER_CARDS: MatterCardVm[] = [
  {
    id: 'm1',
    ref: 'WE-142',
    title: 'Estate of Margaret Whitfield',
    client: 'Catherine Whitfield',
    type: 'probate',
    status: 'active',
    stage: 'Notice period',
    priority: 'urgent',
    nextDeadline: { due: dateOnly('2026-10-03') },
    people: [
      { id: 'u1', name: 'Jordan Price' },
      { id: 'u2', name: 'Priya Shah' },
    ],
    clerkHint: 'The notice can be published today; filing opens 16 Oct.',
  },
  {
    id: 'm4',
    ref: 'WE-160',
    title: 'Estate of Desmond Albert Featherstonehaugh-Whittington (deceased) and related testamentary trusts',
    client:
      'Featherstonehaugh-Whittington Family Investments Pty Ltd as trustee for the Featherstonehaugh Family Trust',
    type: 'admin',
    status: 'review',
    stage: 'Collecting assets',
    priority: 'low',
    nextDeadline: { due: dateOnly('2026-11-20') },
    people: [
      { id: 'u1', name: 'Jordan Price' },
      { id: 'u2', name: 'Priya Shah' },
      { id: 'u3', name: 'Daniel Kim' },
      { id: 'u4', name: 'Jamie Park' },
    ],
  },
  { id: 'm5', ref: 'WE-031', title: 'Okafor wills', type: 'will', status: 'done', stage: 'Signed' },
  {
    id: 'm6',
    ref: 'WE-170',
    title: 'Estate of Ruth Ellis',
    type: 'contest',
    status: 'blocked',
    stage: 'Waiting on client',
    nextDeadline: { due: dateOnly('2026-09-28') },
  },
];

const FACTS: KeyFactVm[] = [
  { id: 'deceased', label: 'Deceased', value: 'Margaret Anne Whitfield' },
  { id: 'dod', label: 'Date of death', value: '22 Jul 2026 · aged 81', citation: { label: 'Death cert p1' } },
  { id: 'address', label: 'Last address', value: '14 Ashby St, Mosman NSW 2088' },
  { id: 'will', label: 'Will', value: '3 May 2019 · original held', citation: { label: 'Will p3' } },
  { id: 'executors', label: 'Executors', value: 'Catherine Whitfield, Peter Hale' },
  { id: 'grant', label: 'Grant', value: '' },
];

const STAGES = [
  { id: 'intake', title: 'Intake' },
  { id: 'searches', title: 'Searches' },
  { id: 'notice', title: 'Notice period' },
  { id: 'filing', title: 'Filing' },
  { id: 'grant', title: 'Grant' },
  { id: 'collect', title: 'Collect assets' },
  { id: 'debts', title: 'Pay debts' },
  { id: 'distribute', title: 'Distribute' },
  { id: 'close', title: 'Close' },
];

const TIMELINE: TimelineItemVm[] = [
  {
    id: 'e1',
    kind: 'email',
    title: 'Email from Catherine Whitfield',
    detail: 'Re: asset schedule',
    at: new Date('2026-10-02T23:42:00Z'),
  },
  {
    id: 'e2',
    kind: 'clerk',
    title: 'Clerk drafted the probate notice',
    detail: 'From the will and death certificate',
    at: new Date('2026-10-02T22:10:00Z'),
  },
  {
    id: 'e3',
    kind: 'note',
    title: 'File note: call with executor',
    detail: 'Jordan Price',
    at: new Date('2026-10-02T03:15:00Z'),
  },
  {
    id: 'e4',
    kind: 'document',
    title: 'Death certificate uploaded',
    detail: 'NSW BDM',
    at: new Date('2026-10-01T05:00:00Z'),
  },
  {
    id: 'e5',
    kind: 'activity',
    title: 'Stage moved to Notice period',
    detail: 'Jordan Price',
    at: new Date('2026-10-01T04:30:00Z'),
  },
];

const DEADLINES: TimelineItemVm[] = [
  {
    id: 'd1',
    kind: 'deadline',
    state: 'done',
    title: 'Caveat search: none lodged',
    detail: 'NSW Online Registry',
    at: '2026-10-02',
    deadline: { due: dateOnly('2026-10-02'), completed: true },
  },
  {
    id: 'd2',
    kind: 'deadline',
    state: 'next',
    title: 'Publish notice of intended application',
    code: 'UCPR r 78.3',
    detail: 'at least 14 days before filing',
    at: '2026-10-03',
    deadline: { due: dateOnly('2026-10-03') },
  },
  {
    id: 'd3',
    kind: 'deadline',
    state: 'overdue',
    title: 'Send costs disclosure update',
    code: 'LPUL s 174',
    at: '2026-10-01',
    deadline: { due: dateOnly('2026-10-01') },
  },
  {
    id: 'd4',
    kind: 'deadline',
    state: 'upcoming',
    title: 'Family provision claim period ends',
    code: 'Succession Act 2006 (NSW) s 58(2)',
    detail: '12 months from death',
    at: '2027-07-22',
    deadline: { due: dateOnly('2027-07-22'), critical: true },
  },
];

const ENTRIES: TimeEntryVm[] = [
  {
    id: 'te1',
    description: 'Drafted probate summons and affidavit',
    meta: 'WE-142 · Whitfield · 1 Oct',
    minutes: 108,
    amountCents: 79200,
    source: 'manual',
  },
  {
    id: 'te2',
    description: 'Emails with executor re: asset schedule',
    meta: '3 emails · 10:42–11:05 · WE-142',
    minutes: 23,
    amountCents: 17600,
    source: 'captured',
  },
  {
    id: 'te3',
    description: 'Conference with Ms Okafor re: attorneys',
    meta: 'Calendar · 25 min · WE-151',
    minutes: 25,
    fixedFee: true,
    source: 'captured',
  },
];

const meta: Meta = {
  title: 'Components/Domain',
  decorators: [
    applicationConfig({ providers: [{ provide: MT_TODAY, useValue: () => TODAY }] }),
    moduleMetadata({
      imports: [
        MtTaskRow,
        MtMatterCard,
        MtKeyFacts,
        MtFactCitation,
        MtEstateStepper,
        MtTimeline,
        MtTimeEntry,
        MtPersonHeader,
        MtSettingsSection,
        MtSettingsRow,
        MtIntegrationCard,
        MtStepList,
        MtChoiceCards,
        MtSwitch,
        MtBadge,
        MtButton,
        MtIconButton,
        ReactiveFormsModule,
      ],
    }),
  ],
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const TaskRows: Story = {
  render: () => {
    const tasks = signal(TASKS);
    return {
      props: {
        tasks,
        toggle: (id: string, done: boolean) =>
          tasks.update((list) => list.map((t) => (t.id === id ? { ...t, done } : t))),
        rename: (id: string, title: string) =>
          tasks.update((list) => list.map((t) => (t.id === id ? { ...t, title } : t))),
      },
      template: `
        <div class="mt-col" style="gap: 0; max-width: 720px">
          @for (task of tasks(); track task.id) {
            <mt-task-row [task]="task" [editable]="true" (done)="toggle(task.id, $event)" (titleChange)="rename(task.id, $event)" />
          }
        </div>
      `,
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: /Done: Book will signing/ });
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(canvas.getByRole('button', { name: /Edit title: Book will signing/ }));
    const input = await canvas.findByRole('textbox', { name: 'Task title' });
    await userEvent.type(input, ' (Thu){Enter}');
    await expect(await canvas.findByRole('button', { name: /Edit title: Book will signing \(Thu\)/ })).toHaveFocus();
  },
};
export const TaskRowsDark: Story = { ...TaskRows, globals: { theme: 'dark' } };

export const MatterCards: Story = {
  render: () => ({
    props: { cards: MATTER_CARDS },
    template: `
      <div style="display: grid; grid-template-columns: repeat(2, 280px); gap: 12px">
        @for (card of cards; track card.id) { <mt-matter-card [matter]="card" /> }
      </div>
    `,
  }),
};
export const MatterCardsDark: Story = { ...MatterCards, globals: { theme: 'dark' } };

export const KeyFactsAndStepper: Story = {
  render: () => ({
    props: { facts: FACTS, stages: STAGES },
    template: `
      <div class="mt-card" data-pad style="max-width: 440px">
        <div class="mt-card-h"><h3>Key facts</h3><span class="mt-ml"><button mtButton variant="ghost" size="sm">Edit</button></span></div>
        <mt-key-facts [facts]="facts">
          <ng-template mtFactCitation let-fact><a class="mt-cite" href="#source"><span class="n">1</span>{{ fact.citation?.label }}</a></ng-template>
        </mt-key-facts>
      </div>
      <div style="margin-top: 24px; max-width: 900px" class="mt-col">
        <mt-estate-stepper [stages]="stages" current="notice" />
        <mt-estate-stepper [stages]="stages" current="grant" [interactive]="true" label="Matter stages (interactive)" />
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('button', { name: /Copy/ }).length).toBeGreaterThan(0);
    await expect(canvas.getAllByText('Notice period')[0]?.closest('li')).toHaveAttribute('aria-current', 'step');
  },
};
export const KeyFactsAndStepperDark: Story = { ...KeyFactsAndStepper, globals: { theme: 'dark' } };

export const Timelines: Story = {
  render: () => ({
    props: { activity: TIMELINE, deadlines: DEADLINES },
    template: `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 32px; max-width: 1100px">
        <mt-timeline [items]="activity" [hasMore]="true" />
        <mt-timeline [items]="deadlines" [grouped]="false" />
      </div>
    `,
  }),
};
export const TimelinesDark: Story = { ...Timelines, globals: { theme: 'dark' } };

export const TimeEntries: Story = {
  render: () => ({
    props: { entries: ENTRIES },
    template: `
      <div class="mt-col" style="gap: 8px; max-width: 600px">
        @for (entry of entries; track entry.id) {
          <mt-time-entry [entry]="entry">
            <button mtIconButton icon="more" label="More actions" size="sm"></button>
          </mt-time-entry>
        }
      </div>
    `,
  }),
};
export const TimeEntriesDark: Story = { ...TimeEntries, globals: { theme: 'dark' } };

export const PeopleAndSettings: Story = {
  render: () => ({
    props: {
      on: new FormControl(true),
      roles: [
        { label: 'Executor', ref: 'WE-142' },
        { label: 'Beneficiary 50%', ref: 'WE-142' },
        { label: 'Will client', ref: 'WE-031' },
      ],
    },
    template: `
      <mt-person-header name="Catherine Whitfield" subtitle="Mosman NSW · client since 2019" colorKey="c1" [roles]="roles">
        <mt-badge tone="success">ID verified</mt-badge>
        <mt-badge tone="success">Conflict check clear</mt-badge>
      </mt-person-header>
      <div style="max-width: 640px; margin-top: 32px">
        <mt-settings-section [headingLevel]="2" title="What Clerk can read" description="Clerk only reads what is switched on here, and only within matters the person asking can open.">
          <mt-settings-row title="Matter documents" description="Wills, certificates, statements and correspondence filed to a matter.">
            <mt-switch label="Matter documents" [labelHidden]="true" [formControl]="on" />
          </mt-settings-row>
          <mt-settings-row title="Email" description="Only emails filed to a matter or exchanged with a matter’s contacts.">
            <mt-switch label="Email" [labelHidden]="true" [formControl]="on" />
          </mt-settings-row>
          <mt-settings-row title="Send email or file documents" description="Clerk never sends, files or bills anything. A person always does." [locked]="true">
            <mt-switch label="Send email or file documents" [labelHidden]="true" [disabled]="true" />
          </mt-settings-row>
        </mt-settings-section>
      </div>
      <div class="mt-col" style="gap: 8px; max-width: 560px; margin-top: 32px">
        <mt-integration-card name="Microsoft 365" description="Email filing, calendar sync and time capture" status="connected" meta="jordan.price@harbourvine.example · since 4 Aug">
          <button mtButton variant="ghost" size="sm">Manage</button>
        </mt-integration-card>
        <mt-integration-card name="Google Workspace" description="Gmail filing and Google Calendar" status="reconnect" meta="Signed out on 3 Oct when the password changed. Filing is paused; nothing is lost.">
          <button mtButton variant="secondary" size="sm">Reconnect</button>
        </mt-integration-card>
        <mt-integration-card name="Xero" description="Invoices and payments" status="error" error="Xero refused the connection: the organisation’s subscription has lapsed, or an adviser removed Materia’s access. Reconnect with a Xero user who has the Standard role or above.">
          <button mtButton variant="secondary" size="sm">Reconnect</button>
        </mt-integration-card>
        <mt-integration-card name="Inbound email" description="Forward or BCC mail to a matter’s address and it’s filed there">
          <button mtButton size="sm">Connect</button>
        </mt-integration-card>
        <mt-integration-card name="RedCrest" description="Probate applications and caveat searches with the Supreme Court of Victoria" status="unavailable" />
      </div>
    `,
  }),
};
export const PeopleAndSettingsDark: Story = { ...PeopleAndSettings, globals: { theme: 'dark' } };

export const StepsAndChoices: Story = {
  render: () => ({
    props: {
      steps: [
        { id: 'firm', title: 'Your firm', description: 'Name, ABN, trust account' },
        { id: 'email', title: 'Email and calendar', description: 'Outlook connected' },
        { id: 'import', title: 'Bring in your matters', description: 'From materia, a spreadsheet or another system' },
        { id: 'practice', title: 'Practice settings', description: 'Jurisdictions, rates, rule sets' },
        { id: 'team', title: 'Invite your team', description: 'Roles and supervision' },
      ],
      options: [
        {
          value: 'materia',
          label: 'materia (current version)',
          description: '42 matters, 318 contacts and 1,208 safe-custody wills found.',
          icon: 'matters',
        },
        {
          value: 'sheet',
          label: 'Spreadsheet',
          description: 'CSV or Excel. Clerk maps your columns.',
          icon: 'document',
        },
        {
          value: 'other',
          label: 'Another practice system',
          description: 'Coming soon',
          icon: 'upload',
          disabled: true,
        },
      ],
      source: new FormControl('materia'),
    },
    template: `
      <div class="mt-row" style="gap: 48px; align-items: flex-start; flex-wrap: wrap">
        <div style="width: 300px"><mt-step-list [steps]="steps" current="import" label="Set up your firm" /></div>
        <div style="width: 560px"><mt-choice-cards label="Where are your matters now?" [options]="options" [formControl]="source" /></div>
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'Spreadsheet' }));
    await expect(canvas.getByRole('radio', { name: 'Spreadsheet' })).toHaveAttribute('aria-checked', 'true');
  },
};
export const StepsAndChoicesDark: Story = { ...StepsAndChoices, globals: { theme: 'dark' } };
