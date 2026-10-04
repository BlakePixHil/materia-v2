import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtSelect, typeaheadIndex } from './select';
import type { MtOption, MtOptionGroup } from '../forms/options';

const MATTER_TYPES: (MtOption | MtOptionGroup)[] = [
  {
    label: 'Estates',
    options: [
      { value: 'probate', label: 'Probate' },
      { value: 'loa', label: 'Letters of administration' },
      { value: 'admin', label: 'Estate administration' },
    ],
  },
  { value: 'will', label: 'Will and enduring documents' },
  { value: 'fp', label: 'Family provision claim', disabled: true },
];

@Component({
  imports: [MtSelect, ReactiveFormsModule],
  template: `<mt-select
    label="Matter type"
    description="Sets the statutory deadlines Clerk tracks."
    [options]="types"
    [native]="native"
    [formControl]="type"
  />`,
})
class Host {
  native = false;
  readonly types = MATTER_TYPES;
  readonly type = new FormControl<string | null>(null, [Validators.required]);
}

describe('MtSelect', () => {
  it('is a labelled combobox showing the placeholder, then the selected label', async () => {
    const { fixture } = await render(Host);
    const trigger = screen.getByRole('combobox', { name: /Matter type/ });
    expect(trigger).toHaveClass('mt-input', 'mt-select');
    expect(trigger).toHaveTextContent('Choose…');
    expect(trigger).toHaveAccessibleDescription('Sets the statutory deadlines Clerk tracks.');

    fixture.componentInstance.type.setValue('loa');
    await fixture.whenStable();
    expect(trigger).toHaveTextContent('Letters of administration');
  });

  it('opens with the keyboard, lists grouped options and selects with Enter', async () => {
    const { fixture } = await render(Host);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveClass('mt-menu');
    expect(screen.getByRole('group', { name: 'Estates' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(5);

    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(fixture.componentInstance.type.value).toBe('loa');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('selects by type-ahead while closed', async () => {
    const { fixture } = await render(Host);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('w');
    expect(fixture.componentInstance.type.value).toBe('will');
    await userEvent.keyboard('e');
    // "we" doesn't match; a fresh "e" after the reset selects "Estate administration".
    await new Promise((r) => setTimeout(r, 550));
    await userEvent.keyboard('e');
    expect(fixture.componentInstance.type.value).toBe('admin');
  });

  it('shows the required error once touched and renders data-disabled when disabled', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.type.markAsTouched();
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = screen.getByRole('combobox');
    expect(screen.getByText('Fill in this field.')).toHaveClass('mt-error');
    expect(trigger).toHaveAttribute('data-invalid');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');

    fixture.componentInstance.type.disable();
    await fixture.whenStable();
    expect(trigger).toHaveAttribute('data-disabled');
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
  });

  it('uses a native select when asked (touch fallback), with optgroups', async () => {
    const { fixture } = await render(Host, { componentProperties: { native: true } });
    const select = screen.getByRole('combobox', { name: 'Matter type' });
    expect(select.tagName).toBe('SELECT');
    expect(select.querySelector('optgroup')).toHaveAttribute('label', 'Estates');
    // Option values are indexes into the flattened list; Probate is the first.
    await userEvent.selectOptions(select, '0');
    expect(fixture.componentInstance.type.value).toBe('probate');
  });
});

describe('typeaheadIndex', () => {
  const labels = ['Probate', 'Letters of administration', 'Estate administration', 'Executor change', 'Will'];

  it('finds the first match after the current option and cycles on a repeated letter', () => {
    expect(typeaheadIndex(labels, 'e', -1)).toBe(2);
    expect(typeaheadIndex(labels, 'ee', 2)).toBe(3);
    expect(typeaheadIndex(labels, 'ex', 2)).toBe(3);
    expect(typeaheadIndex(labels, 'w', 0)).toBe(4);
  });

  it('skips disabled options and returns -1 without a match', () => {
    expect(typeaheadIndex(labels, 'e', -1, [false, false, true])).toBe(3);
    expect(typeaheadIndex(labels, 'z', -1)).toBe(-1);
  });
});
