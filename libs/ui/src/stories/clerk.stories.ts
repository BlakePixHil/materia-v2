import { Component, DestroyRef, inject, signal } from '@angular/core';
import { type Meta, moduleMetadata, type StoryObj } from '@storybook/angular';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { MtButton } from '../lib/button/button';
import { type CitationVm, MtCitation } from '../lib/clerk/citation';
import { type BriefItemVm, MtClerkBrief } from '../lib/clerk/clerk-brief';
import { type ClerkMessageState, MtClerkMessage, MtUserMessage } from '../lib/clerk/clerk-message';
import { MtClerkWorking } from '../lib/clerk/clerk-working';
import { MtComposer } from '../lib/clerk/composer';
import { MtSuggestion, type SuggestionVm } from '../lib/clerk/suggestion';

/** Fictional data only, as in the design system. */
const CITATIONS: CitationVm[] = [
  {
    n: 1,
    documentId: 'will',
    label: 'Will · cl. 6',
    page: 3,
    quote: 'I give nothing to my son Thomas, for reasons he understands.',
  },
  {
    n: 2,
    documentId: 'act',
    label: 'Succession Act s 57',
    kind: 'law',
    quote: 'An eligible person includes a child of the deceased person.',
  },
  { n: 3, documentId: 'super', label: 'Super statement p 2', quote: 'Binding nomination lapsed 14 March 2024.' },
  { n: 4, documentId: 'note', label: 'File note 14 Aug', quote: 'Thomas asked for a copy of the will.' },
];

const ANSWER = `**Most likely Thomas Whitfield, the son.** He is an eligible person under s 57(1)(c), and clause 6 of the will leaves him nothing.[1, 2]

- The $412k super could be designated notional estate because the binding nomination lapsed.[3]
- The file note of 14 Aug records Thomas asking for a copy of the will.[4]

A claim must be filed by **22 Jul 2027**.`;

/** Streams ANSWER in small chunks on an interval, as the gateway would. */
@Component({
  selector: 'mt-streaming-demo',
  imports: [MtClerkMessage, MtUserMessage, MtButton, MtComposer],
  template: `
    <div class="mt-col" style="gap: 16px; max-width: 480px">
      <mt-user-message>Is anyone likely to bring a family provision claim?</mt-user-message>
      <mt-clerk-message [content]="content()" [citations]="citations" [state]="state()" (retry)="start()">
        <button mtButton size="sm" iconStart="flag">Add risk flag</button>
        <button mtButton size="sm" variant="clerk" iconStart="compose">Draft advice</button>
      </mt-clerk-message>
      <mt-composer
        scope="WE-142 · Estate of Margaret Whitfield"
        [streaming]="state() === 'streaming'"
        (stop)="stop()"
        (send)="start()"
      />
    </div>
  `,
})
class StreamingDemo {
  protected readonly citations = CITATIONS;
  protected readonly content = signal('');
  protected readonly state = signal<ClerkMessageState>('streaming');
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.start();
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  start(): void {
    clearInterval(this.timer);
    this.content.set('');
    this.state.set('streaming');
    let i = 0;
    this.timer = setInterval(() => {
      i = Math.min(ANSWER.length, i + 7);
      this.content.set(ANSWER.slice(0, i));
      if (i >= ANSWER.length) {
        clearInterval(this.timer);
        this.state.set('done');
      }
    }, 40);
  }

  stop(): void {
    clearInterval(this.timer);
    this.state.set('stopped');
  }
}

const BRIEF: BriefItemVm[] = [
  {
    id: 'b1',
    icon: 'alert',
    tone: 'danger',
    lead: 'Nguyen v Nguyen.',
    text: 'Service of the plaintiff’s affidavit was due Wednesday. I’ve drafted a consent-extension letter to the other side.',
    citations: [
      { n: 1, documentId: 'orders', label: 'Orders 12 Sep' },
      { n: 2, documentId: 'email', label: 'Email · K. Ho', kind: 'email' },
    ],
    actionLabel: 'Review draft',
  },
  {
    id: 'b2',
    icon: 'scale',
    tone: 'brand',
    lead: 'Whitfield.',
    text: 'Publish the probate notice this morning and the summons can be filed from 16 Oct.',
    citations: [{ n: 3, documentId: 'ucpr', label: 'UCPR r 78.3', kind: 'law' }],
    actionLabel: 'Open matter',
  },
  {
    id: 'b3',
    icon: 'flag',
    tone: 'warning',
    lead: 'Okafor.',
    text: 'Thursday’s signing still needs a second witness for the enduring power of attorney.',
    citations: [{ n: 4, documentId: 'poa', label: 'POA Act 2003 (NSW) s 19', kind: 'law' }],
    actionLabel: 'Add task',
  },
];

const SUGGESTIONS: SuggestionVm[] = [
  {
    id: 's1',
    kind: 'Task',
    title: 'Request date-of-death valuation for 14 Ashby St, Mosman',
    rationale: 'From will cl. 4(b) and the title search',
    citations: [CITATIONS[0] as CitationVm],
    acceptLabel: 'Add task',
  },
  {
    id: 's2',
    kind: 'Deadline',
    title: 'File probate summons from 16 Oct',
    rationale: 'UCPR r 78.3 · 14 days after the notice is published',
    acceptLabel: 'Add deadline',
  },
  {
    id: 's3',
    kind: 'Letter',
    title: 'Grant notification to beneficiaries: Megan Ashby, Paul Ashby · Tell them the grant issued on 14 April.',
    rationale: 'The grant has issued and the beneficiaries haven’t been told',
    acceptLabel: 'Draft letter',
  },
];

const meta: Meta = {
  title: 'Components/Clerk',
  decorators: [
    moduleMetadata({
      imports: [
        StreamingDemo,
        MtClerkMessage,
        MtUserMessage,
        MtClerkBrief,
        MtClerkWorking,
        MtSuggestion,
        MtCitation,
        MtComposer,
        MtButton,
      ],
    }),
  ],
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const Streaming: Story = {
  render: () => ({ template: `<mt-streaming-demo />` }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('article', { name: 'Clerk' })).toHaveAttribute('aria-busy', 'false'), {
      timeout: 5000,
    });
    await expect(canvas.getByRole('button', { name: 'Draft advice' })).toBeVisible();
  },
};
export const StreamingDark: Story = { ...Streaming, globals: { theme: 'dark' } };

export const MessageStates: Story = {
  render: () => ({
    props: {
      answer: ANSWER,
      citations: CITATIONS,
      partial: 'He is an eligible person under **s 57',
      short: 'The notice was published on 2 Oct.[1]',
    },
    template: `
      <div class="mt-col" style="gap: 24px; max-width: 480px">
        <mt-clerk-message [content]="partial" [citations]="citations" state="streaming" />
        <mt-clerk-message content="" state="streaming" />
        <mt-clerk-message [content]="short" [citations]="citations.slice(0, 1)" state="stopped" />
        <mt-clerk-message content="" state="error" error="Clerk couldn’t reach the documents service. Try again." />
      </div>
    `,
  }),
};
export const MessageStatesDark: Story = { ...MessageStates, globals: { theme: 'dark' } };

export const Brief: Story = {
  render: () => ({
    props: { items: BRIEF },
    template: `
      <div style="max-width: 720px">
        <mt-clerk-brief label="Morning brief" title="Three things need you today" [items]="items">
          <button mtBriefActions mtButton variant="ghost" size="sm" iconStart="document">Sources</button>
        </mt-clerk-brief>
      </div>
    `,
  }),
};
export const BriefDark: Story = { ...Brief, globals: { theme: 'dark' } };

/** A matter's brief on Overview (AI-06c): numbered record chips, Refresh and "Ask a follow-up". */
const MATTER_BRIEF: BriefItemVm[] = [
  {
    id: 'm1',
    icon: 'alert',
    tone: 'danger',
    lead: 'Overdue.',
    text: 'Advertising the notice of intention was due Mon 5 Oct.',
    citations: [{ n: 1, documentId: 'deadline:notice', label: 'Advertise notice of intention', kind: 'record' }],
  },
  {
    id: 'm2',
    icon: 'calendar',
    tone: 'warning',
    lead: 'Due soon.',
    text: 'The probate application is due Fri 16 Oct, in 9 days.',
    citations: [{ n: 2, documentId: 'deadline:probate', label: 'Apply for probate', kind: 'record' }],
  },
  {
    id: 'm3',
    icon: 'document',
    lead: 'New since your last visit.',
    text: 'The will was added on Mon 5 Oct.',
    citations: [{ n: 3, documentId: 'document:will', label: 'Will of the late J. Citizen', kind: 'record' }],
  },
  {
    id: 'm4',
    icon: 'arrow-right',
    tone: 'brand',
    lead: 'Next step.',
    text: 'Review Clerk’s suggestion to request certified copies of the death certificate.',
    citations: [{ n: 4, documentId: 'suggestion:copies', label: 'Task: Request certified copies', kind: 'record' }],
  },
];

export const MatterBrief: Story = {
  render: () => ({
    props: { items: MATTER_BRIEF },
    template: `
      <div style="max-width: 720px">
        <mt-clerk-brief title="The probate application is due Fri 16 Oct and one deadline is overdue." [items]="items">
          <button mtBriefActions mtButton variant="ghost" size="sm" iconStart="refresh">Refresh</button>
          <button mtBriefActions mtButton variant="clerk" size="sm" iconStart="sparkle">Ask a follow-up</button>
          <p class="mt-clerk-foot">Clerk read 2 deadlines, 1 task, 1 change, 1 document and 1 suggestion · 9:12 am. Clerk can be wrong; check the sources.</p>
        </mt-clerk-brief>
      </div>
    `,
  }),
};
export const MatterBriefDark: Story = { ...MatterBrief, globals: { theme: 'dark' } };

/** The template brief, when Clerk didn't write it: the same facts, the plain card. */
export const MatterBriefTemplate: Story = {
  render: () => ({
    props: { items: MATTER_BRIEF.slice(0, 3).map((item) => ({ ...item, lead: undefined })) },
    template: `
      <div style="max-width: 720px">
        <mt-clerk-brief plain label="Matter brief" title="1 item overdue and 1 due in the next 14 days." [items]="items">
          <p class="mt-clerk-foot">Built from the matter’s deadlines, tasks and activity, not by Clerk · 9:12 am</p>
        </mt-clerk-brief>
      </div>
    `,
  }),
};
export const MatterBriefTemplateDark: Story = { ...MatterBriefTemplate, globals: { theme: 'dark' } };

export const WorkingAndSuggestions: Story = {
  render: () => ({
    props: {
      suggestions: SUGGESTIONS,
      steps: ['Reading the will', 'Reading Westpac statement, page 3 of 6', 'Drafting the asset schedule'],
    },
    template: `
      <div class="mt-col" style="gap: 24px; max-width: 640px">
        <mt-clerk-working [steps]="steps" [current]="1" [progress]="64" />
        <mt-clerk-working label="Searching the NSW Online Registry" [reducedMotion]="true" />
        <mt-suggestion [suggestion]="suggestions[0]" />
        <mt-suggestion [suggestion]="suggestions[1]" [stale]="true" />
        <mt-suggestion [suggestion]="suggestions[2]" [canEdit]="false" />
        <mt-suggestion [suggestion]="suggestions[1]">
          <div class="mt-row" style="gap: 6px; font-size: 13px"><s style="color: var(--text-tertiary)">2 Oct</s> → <b>16 Oct</b></div>
        </mt-suggestion>
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole('img', { name: 'Clerk' }).length).toBeGreaterThanOrEqual(5);
    // A letter opens the draft start page to check: no Edit beside its accept verb.
    const letter = within(within(canvasElement).getByRole('group', { name: /Grant notification/ }));
    await expect(letter.getByRole('button', { name: 'Draft letter' })).toBeVisible();
    await expect(letter.queryByRole('button', { name: 'Edit' })).toBeNull();
  },
};
export const WorkingAndSuggestionsDark: Story = { ...WorkingAndSuggestions, globals: { theme: 'dark' } };

export const Citations: Story = {
  render: () => ({
    props: {
      items: [
        CITATIONS[0],
        { documentId: 'dc', label: 'Death certificate' },
        { documentId: 'act', label: 'Succession Act 2006 (NSW) s 58(2)', kind: 'law' },
        { documentId: 'email', label: 'Email · K. Ho 30 Sep', kind: 'email' },
        { documentId: 'stmt', label: 'Westpac statement', page: 3, kind: 'record' },
        { n: 5, documentId: 'priv', label: 'Counsel’s advice', state: 'restricted' },
        { n: 6, documentId: 'gone', label: 'Draft affidavit v2', state: 'removed' },
      ],
    },
    template: `<div class="mt-row mt-wrap" style="gap: 6px">@for (c of items; track c.documentId) { <mt-citation [citation]="c" /> }</div>`,
  }),
  play: async ({ canvasElement }) => {
    within(canvasElement)
      .getByRole('button', { name: /Source 1/ })
      .focus();
    await expect(await within(document.body).findByRole('tooltip')).toHaveTextContent('I give nothing');
  },
};
export const CitationsDark: Story = { ...Citations, globals: { theme: 'dark' } };

export const Composer: Story = {
  render: () => ({
    props: {
      commands: [
        { name: 'draft', description: 'Draft a letter or document (coming soon)', disabled: true },
        { name: 'deadlines', description: 'List this matter’s deadlines' },
        { name: 'summarise', description: 'Summarise the matter' },
      ],
    },
    template: `
      <div class="mt-col" style="gap: 24px; max-width: 480px">
        <mt-composer scope="WE-142 · Estate of Margaret Whitfield" [commands]="commands" />
        <mt-composer scope="WE-142" [streaming]="true" value="Draft the advice letter" />
        <mt-composer [disabled]="true" placeholder="Clerk is off for this matter" />
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getAllByRole('textbox')[0] as HTMLTextAreaElement;
    await userEvent.type(input, '/d');
    await expect(await within(canvasElement).findByRole('listbox', { name: 'Commands' })).toBeVisible();
  },
};
export const ComposerDark: Story = { ...Composer, globals: { theme: 'dark' } };
