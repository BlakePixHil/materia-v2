import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtChoiceCards } from './choice-card';
import type { MtOption } from '../forms/options';

const OPTIONS: MtOption[] = [
  { value: 'materia', label: 'materia (current version)', description: '42 matters found', icon: 'matters' },
  { value: 'sheet', label: 'Spreadsheet', description: 'CSV or Excel', icon: 'document' },
  { value: 'other', label: 'Another system', disabled: true },
];

@Component({
  imports: [MtChoiceCards, ReactiveFormsModule],
  template: `<mt-choice-cards label="Where are your matters now?" [options]="options" [formControl]="source" />`,
})
class Host {
  readonly options = OPTIONS;
  readonly source = new FormControl<string | null>(null, Validators.required);
}

describe('MtChoiceCards', () => {
  it('is a labelled radio group of cards that selects with click and arrow keys', async () => {
    const { fixture } = await render(Host);
    const group = screen.getByRole('radiogroup', { name: 'Where are your matters now?' });
    expect(group).toBeInTheDocument();
    const first = screen.getByRole('radio', { name: 'materia (current version)' });
    expect(first).toHaveAccessibleDescription('42 matters found');
    await userEvent.click(first);
    expect(fixture.componentInstance.source.value).toBe('materia');
    expect(first).toHaveAttribute('data-selected');
    await userEvent.keyboard('{ArrowDown}');
    expect(fixture.componentInstance.source.value).toBe('sheet');
    expect(screen.getByRole('radio', { name: 'Another system' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('writes the form value in and shows a required error once touched', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.source.setValue('sheet');
    fixture.detectChanges();
    expect(screen.getByRole('radio', { name: 'Spreadsheet' })).toHaveAttribute('data-selected');
    fixture.componentInstance.source.setValue(null);
    fixture.componentInstance.source.markAsTouched();
    fixture.detectChanges();
    expect(await screen.findByText('Fill in this field.')).toBeInTheDocument();
  });
});
