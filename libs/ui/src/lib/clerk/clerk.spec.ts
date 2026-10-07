import { Component, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { type CitationVm, MtCitation } from './citation';
import { MtClerkBrief } from './clerk-brief';
import { MtClerkMessage, MtUserMessage } from './clerk-message';
import { MtClerkWorking } from './clerk-working';
import { matchCommands, MtComposer } from './composer';
import { MtSuggestion } from './suggestion';

// Fictional sample data, as in the design system.
const CITATIONS: CitationVm[] = [
  { n: 1, documentId: 'd-will', label: 'Will · cl. 6', page: 3, quote: 'I leave nothing to my son.' },
  { n: 2, documentId: 'd-act', label: 'Succession Act s 57', kind: 'law' },
  { n: 3, documentId: 'd-super', label: 'Super statement', page: 2, state: 'restricted', quote: 'secret' },
  { n: 4, documentId: 'd-note', label: 'File note 14 Aug', state: 'removed', quote: 'Thomas asked for a copy.' },
];

const ANSWER = [
  '**Most likely Thomas Whitfield.** He is an eligible person[1, 2] and see <script>alert(1)</script>.',
  '',
  '- The super could be notional estate.[3]',
  '- The file note records a request.[4]',
  '',
  'Read [the Act](https://legislation.nsw.gov.au) or [this](javascript:alert(1)).',
].join('\n');

describe('Clerk components always show the Clerk mark', () => {
  it.each([
    ['ClerkMessage', () => render(MtClerkMessage, { inputs: { content: 'Hello' } })],
    ['ClerkBrief', () => render(MtClerkBrief, { inputs: { items: [] } })],
    ['ClerkWorking', () => render(MtClerkWorking, { inputs: { label: 'Reading' } })],
    ['Suggestion', () => render(MtSuggestion, { inputs: { suggestion: { id: 's', kind: 'Task', title: 'Do it' } } })],
  ])('%s', async (_name, setup) => {
    await setup();
    expect(screen.getByRole('img', { name: 'Clerk' })).toBeInTheDocument();
  });
});

describe('MtClerkMessage', () => {
  it('renders safe Markdown with citation markers and chips', async () => {
    const open = vi.fn();
    const { container } = await render(MtClerkMessage, {
      inputs: { content: ANSWER, citations: CITATIONS },
      on: { citationOpen: open },
    });
    expect(screen.getByRole('article', { name: 'Clerk' })).toHaveAttribute('aria-busy', 'false');
    expect(container.querySelector('b')).toHaveTextContent('Most likely Thomas Whitfield.');
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(container.querySelectorAll('sup')).toHaveLength(3);
    expect(container.querySelector('sup')).toHaveTextContent('Sources 1 2');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'the Act' })).toHaveAttribute('href', 'https://legislation.nsw.gov.au');
    expect(screen.queryByRole('link', { name: 'this' })).toBeNull();
    const sources = screen.getByRole('group', { name: 'Sources' });
    expect(within(sources).getAllByRole('button')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Source 1: Will · cl. 6 p 3' }));
    expect(open).toHaveBeenCalledWith({ documentId: 'd-will', n: 1, page: 3, quote: 'I leave nothing to my son.' });
  });

  it('drops unverified citations and marks a claim left with none as unverified (AI-05)', async () => {
    const citations: CitationVm[] = [
      { n: 1, documentId: 'd-will', label: 'Will', page: 1, quote: 'I appoint my daughter.', verified: false },
      { n: 2, documentId: 'd-will', label: 'Will', page: 2, quote: 'the residue of my estate' },
      { n: 3, documentId: 'd-note', label: 'File note', quote: 'Invented words.', verified: false },
    ];
    const { container } = await render(MtClerkMessage, {
      inputs: { content: 'Avery is the executor.[1] The residue is split.[1, 2] Thomas objected.[3]', citations },
    });
    const sups = [...container.querySelectorAll('sup')];
    expect(sups.map((sup) => sup.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Sources 2']);
    const unverified = container.querySelectorAll('.mt-msg-unverified');
    expect(unverified).toHaveLength(2);
    expect(unverified[0]).toHaveTextContent('unverified');
    expect(unverified[0]).toHaveAttribute('title', 'Clerk’s source for this couldn’t be found in the document');
    const sources = screen.getByRole('group', { name: 'Sources' });
    expect(
      within(sources)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Source 2: Will p 2']);
  });

  it('streams with a caret, hiding unfinished markers and unused citations', async () => {
    const { container } = await render(MtClerkMessage, {
      inputs: { content: 'He is **eligible[1', citations: CITATIONS, state: 'streaming' },
    });
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.mt-caret')).not.toBeNull();
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('[1');
    expect(screen.queryByRole('group', { name: 'Sources' })).toBeNull();
  });

  it('shows a caret before the first chunk, then the stopped state', async () => {
    const { container, rerender } = await render(MtClerkMessage, { inputs: { content: '', state: 'streaming' } });
    expect(container.querySelector('.mt-caret')).not.toBeNull();
    await rerender({ inputs: { content: 'Partial', state: 'stopped' }, partialUpdate: true });
    expect(screen.getByText(/Stopped/)).toBeInTheDocument();
    expect(container.querySelector('.mt-caret')).toBeNull();
  });

  it('shows the error with Retry', async () => {
    const retry = vi.fn();
    await render(MtClerkMessage, {
      inputs: { content: 'Partial', state: 'error', error: 'Clerk timed out.' },
      on: { retry },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Clerk timed out.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('renders headings, quotes, ordered lists and code blocks, and projects actions when done', async () => {
    const { container } = await render(
      `<mt-clerk-message [content]="content"><button type="button">Draft advice</button></mt-clerk-message>
       <mt-user-message>Who might claim?</mt-user-message>`,
      {
        imports: [MtClerkMessage, MtUserMessage],
        componentProperties: { content: '# Heading\n> quote\n\n1. one\n2. two\n\n```\ncode\n```' },
      },
    );
    expect(container.querySelector('blockquote')).toHaveTextContent('quote');
    expect(container.querySelector('ol')?.children).toHaveLength(2);
    expect(container.querySelector('pre')).toHaveTextContent('code');
    expect(screen.getByRole('button', { name: 'Draft advice' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent('Who might claim?');
  });
});

describe('MtCitation', () => {
  it('opens with Enter and Space, and shows the quote on focus', async () => {
    const open = vi.fn();
    await render(MtCitation, { inputs: { citation: CITATIONS[0] as CitationVm }, on: { open } });
    const chip = screen.getByRole('button', { name: 'Source 1: Will · cl. 6 p 3' });
    chip.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(open).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('I leave nothing to my son.');
  });

  it('shows restricted and removed sources without opening them', async () => {
    const open = vi.fn();
    await render(
      `<mt-citation [citation]="restricted" (open)="open($event)" /><mt-citation [citation]="removed" (open)="open($event)" /><mt-citation [citation]="plain" />`,
      {
        imports: [MtCitation],
        componentProperties: {
          restricted: CITATIONS[2] as CitationVm,
          removed: CITATIONS[3] as CitationVm,
          plain: { documentId: 'x', label: 'Email · K. Ho', kind: 'email' },
          open,
        },
      },
    );
    const restricted = screen.getByRole('button', { name: 'Source 3: Restricted source' });
    expect(restricted).toHaveAttribute('aria-disabled', 'true');
    expect(restricted).not.toHaveTextContent('Super statement');
    await userEvent.click(restricted);
    // A removed document still shows the quote it was cited for.
    const removed = screen.getByRole('button', { name: 'Source 4: Removed document: “Thomas asked for a copy.”' });
    expect(removed).toHaveTextContent('Removed document: “Thomas asked for a copy.”');
    await userEvent.click(removed);
    expect(open).not.toHaveBeenCalled();
    removed.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Thomas asked for a copy.');
    expect(screen.getByRole('button', { name: 'Source: Email · K. Ho' })).toBeInTheDocument();
  });
});

describe('MtClerkBrief', () => {
  it('lists items with sources and actions', async () => {
    const action = vi.fn();
    await render(MtClerkBrief, {
      inputs: {
        label: 'Morning brief',
        title: 'Three things need you today',
        items: [
          {
            id: 'b1',
            icon: 'alert',
            tone: 'danger',
            lead: 'Nguyen v Nguyen.',
            text: 'Service was due Wednesday.',
            citations: [CITATIONS[0] as CitationVm],
            actionLabel: 'Review draft',
          },
          { id: 'b2', icon: 'scale', text: 'Publish the notice.', citations: [] },
        ],
      },
      on: { action },
    });
    expect(screen.getByRole('region', { name: 'Morning brief' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Three things need you today' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Review draft' }));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
  });

  it('says when there is nothing to do', async () => {
    await render(MtClerkBrief, { inputs: { items: [] } });
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  it('shows a brief Clerk didn’t write as the plain card, without the Clerk mark', async () => {
    const { container } = await render(MtClerkBrief, { inputs: { label: 'Matter brief', items: [], plain: true } });
    const card = screen.getByRole('region', { name: 'Matter brief' });
    expect(card).toHaveAttribute('data-plain');
    expect(container.querySelector('mt-clerk-mark')).toBeNull();
  });
});

describe('MtClerkWorking', () => {
  it('announces the current step, lists steps and shows progress', async () => {
    const { fixture } = await render(MtClerkWorking, {
      inputs: {
        steps: ['Reading the will', 'Reading statements', 'Drafting'],
        current: 1,
        progress: 64,
        reducedMotion: true,
      },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reading statements');
    expect(fixture.nativeElement).toHaveAttribute('data-static');
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-state'))).toEqual(['done', 'current', null]);
    expect(screen.getByRole('progressbar', { name: 'Reading statements' })).toBeInTheDocument();
  });

  it('falls back to a generic label', async () => {
    await render(MtClerkWorking);
    expect(screen.getByRole('status')).toHaveTextContent('Working…');
  });
});

describe('MtSuggestion', () => {
  const suggestion = {
    id: 's1',
    kind: 'Task',
    title: 'Request date-of-death valuation for 14 Ashby St',
    rationale: 'From will cl. 4(b)',
    citations: [CITATIONS[0] as CitationVm],
    acceptLabel: 'Add task',
  };

  it('emits accept, edit and dismiss', async () => {
    const accept = vi.fn();
    const edit = vi.fn();
    const dismiss = vi.fn();
    await render(
      `<mt-suggestion [suggestion]="s" (accept)="accept()" (edit)="edit()" (dismiss)="dismiss()"><p>Preview</p></mt-suggestion>`,
      {
        imports: [MtSuggestion],
        componentProperties: { s: suggestion, accept, edit, dismiss },
      },
    );
    expect(screen.getByRole('group', { name: `Clerk suggestion: ${suggestion.title}` })).toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect([accept.mock.calls.length, edit.mock.calls.length, dismiss.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it('asks for a review when stale', async () => {
    const accept = vi.fn();
    const edit = vi.fn();
    await render(MtSuggestion, {
      inputs: { suggestion: { id: 's', kind: 'Deadline', title: 'File summons' }, stale: true },
      on: { accept, edit },
    });
    expect(screen.getByText(/Data changed since suggested/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(edit).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('hides the actions a person can’t take', async () => {
    await render(MtSuggestion, {
      inputs: { suggestion: { id: 's', kind: 'Task', title: 'Do it' }, canAccept: false, canDismiss: false },
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

@Component({
  imports: [MtComposer],
  template: `<mt-composer
    scope="WE-142"
    [(value)]="value"
    [streaming]="streaming()"
    [commands]="commands"
    (send)="events.push('send:' + $event)"
    (stop)="events.push('stop')"
    (attach)="events.push('attach')"
  />`,
})
class ComposerHost {
  readonly value = signal('');
  readonly streaming = signal(false);
  readonly commands = [
    { name: 'draft', description: 'Draft a document' },
    { name: 'deadlines', description: 'List deadlines' },
    { name: 'summarise', description: 'Summarise the matter' },
    { name: 'timeline', description: 'Timeline (coming soon)', disabled: true },
  ];
  readonly events: string[] = [];
}

describe('MtComposer', () => {
  it('matches commands after a leading slash', () => {
    const commands = [
      { name: 'draft', description: '' },
      { name: 'deadlines', description: '' },
    ];
    expect(matchCommands('/d', commands).map((c) => c.name)).toEqual(['draft', 'deadlines']);
    expect(matchCommands('/dr', commands).map((c) => c.name)).toEqual(['draft']);
    expect(matchCommands('/draft now', commands)).toEqual([]);
    expect(matchCommands('hello', commands)).toEqual([]);
  });

  it('shows the scope and sends with ⌘↵ or Ctrl+Enter, not with an empty message', async () => {
    const { fixture } = await render(ComposerHost);
    expect(screen.getByText('Asking about WE-142')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Ask Clerk' });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(fixture.componentInstance.events).toEqual([]);
    await userEvent.type(input, 'Who might claim?');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(fixture.componentInstance.events).toEqual(['send:Who might claim?']);
    expect(input).toHaveValue('');
    await userEvent.type(input, '  Next  ');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(fixture.componentInstance.events).toEqual(['send:Who might claim?', 'send:Next']);
    await userEvent.type(input, 'Plain enter{Enter}');
    expect(fixture.componentInstance.events).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(fixture.componentInstance.events.at(-1)).toBe('send:Plain enter');
    await userEvent.click(screen.getByRole('button', { name: 'Attach a file' }));
    expect(fixture.componentInstance.events.at(-1)).toBe('attach');
  });

  it('becomes Stop while streaming, and Escape stops', async () => {
    const { fixture } = await render(ComposerHost);
    fixture.componentInstance.streaming.set(true);
    fixture.detectChanges();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'More');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(fixture.componentInstance.events).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(fixture.componentInstance.events).toEqual(['stop']);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(fixture.componentInstance.events).toEqual(['stop', 'stop']);
  });

  it('lists / commands, moves with arrows and inserts with Enter or Tab', async () => {
    const { fixture } = await render(ComposerHost);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/d');
    const listbox = screen.getByRole('listbox', { name: 'Commands' });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['/draftDraft a document', '/deadlinesList deadlines']);
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-command-0$/));
    await userEvent.keyboard('{ArrowDown}');
    expect(within(listbox).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(within(listbox).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(fixture.componentInstance.value()).toBe('/deadlines ');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.clear(input);
    await userEvent.type(input, '/s');
    await userEvent.keyboard('{Tab}');
    expect(fixture.componentInstance.value()).toBe('/summarise ');
    await userEvent.clear(input);
    await userEvent.type(input, '/');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.type(input, 'dr');
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option'));
    expect(fixture.componentInstance.value()).toBe('/draft ');
  });

  it('lists a command that isn’t available yet without inserting it', async () => {
    const { fixture } = await render(ComposerHost);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/t');
    const option = within(screen.getByRole('listbox')).getByRole('option');
    expect(option).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(option);
    expect(fixture.componentInstance.value()).toBe('/t');
  });
});
