import { Component } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { type KeyFactVm, MT_COPIED_MS, MtFactCitation, MtFactEditor, MtKeyFacts } from './key-facts';

// Fictional sample data, as in the design system.
const FACTS: KeyFactVm[] = [
  { id: 'deceased', label: 'Deceased', value: 'Margaret Anne Whitfield' },
  { id: 'dod', label: 'Date of death', value: '22 Jul 2026', citation: { label: 'Death cert p1' } },
  { id: 'will', label: 'Will', value: '', copyable: true },
  { id: 'notes', label: 'Notes', value: 'Original held', copyable: false },
];

@Component({
  imports: [MtKeyFacts],
  template: `<mt-key-facts [facts]="facts" (copied)="copied.push($event.id)" />`,
})
class Host {
  readonly facts = FACTS;
  readonly copied: string[] = [];
}

@Component({
  imports: [MtKeyFacts, MtFactCitation],
  template: `<mt-key-facts [facts]="facts">
    <ng-template mtFactCitation let-fact
      ><a href="#cite">{{ fact.citation?.label }} (source)</a></ng-template
    >
  </mt-key-facts>`,
})
class CustomCitationHost {
  readonly facts = FACTS;
}

@Component({
  imports: [MtKeyFacts, MtFactEditor],
  template: `<mt-key-facts [facts]="facts" [editing]="editing" (edit)="editing = $event.id">
    <ng-template mtFactEditor let-fact><input [attr.aria-label]="fact.label" /></ng-template>
  </mt-key-facts>`,
})
class EditableHost {
  readonly facts: KeyFactVm[] = [
    { id: 'grant', label: 'Grant date', value: '', editable: true },
    { id: 'dod', label: 'Date of death', value: '', editBlockedReason: 'Add the deceased first' },
  ];
  editing: string | null = null;
}

describe('MtKeyFacts', () => {
  afterEach(() => vi.useRealTimers());

  it('renders a definition list with an em dash for missing values and a citation chip', async () => {
    await render(Host);
    expect(screen.getByText('Deceased').tagName).toBe('DT');
    expect(screen.getByText('Margaret Anne Whitfield').closest('dd')).not.toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Death cert p1')).toHaveClass('mt-cite');
    // Copy buttons only for copyable facts with a value.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Copy Deceased',
      'Copy Date of death',
    ]);
  });

  it('copies a value to the clipboard, announces it, and shows a tick for a moment', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { fixture } = await render(Host);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: 'Copy Date of death' }));
    expect(writeText).toHaveBeenCalledWith('22 Jul 2026');
    expect(fixture.componentInstance.copied).toEqual(['dod']);
    expect(await screen.findByText('Date of death copied')).toBeInTheDocument();
    vi.advanceTimersByTime(MT_COPIED_MS);
    fixture.detectChanges();
    expect(screen.queryByText('Date of death copied')).not.toBeInTheDocument();
  });

  it('announces a failed copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const { fixture } = await render(Host);
    await user.click(screen.getByRole('button', { name: 'Copy Deceased' }));
    expect(await screen.findByText("Couldn't copy Deceased")).toBeInTheDocument();
    expect(fixture.componentInstance.copied).toEqual([]);
  });

  it('renders a custom citation template', async () => {
    await render(CustomCitationHost);
    expect(screen.getByRole('link', { name: 'Death cert p1 (source)' })).toBeInTheDocument();
  });

  it('offers Edit on editable facts and shows the editor in place of the value', async () => {
    const user = userEvent.setup();
    const { fixture } = await render(EditableHost);
    const blocked = screen.getByRole('img', { name: 'Add the deceased first' });
    await user.click(blocked);
    await user.hover(blocked);
    expect(
      await screen.findByText('Add the deceased first', { selector: '.mt-tooltip' }, { timeout: 2000 }),
    ).toBeTruthy();
    expect(fixture.componentInstance.editing).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit Grant date' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.editing).toBe('grant');
    expect(await screen.findByRole('textbox', { name: 'Grant date' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Grant date' })).toBeNull();
  });
});
