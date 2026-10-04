import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtRadioGroup } from './radio-group';
import type { MtOption } from '../forms/options';

const APPLICANTS: MtOption[] = [
  { value: 'sole', label: 'Sole executor', description: 'Catherine Whitfield' },
  { value: 'both', label: 'Both executors' },
  { value: 'reserved', label: 'Executor with power reserved' },
  { value: 'admin', label: 'Administrator', disabled: true },
];

describe('MtRadioGroup', () => {
  @Component({
    imports: [MtRadioGroup, ReactiveFormsModule],
    template: `<mt-radio-group label="Who is applying?" [options]="options" [formControl]="applicant" />`,
  })
  class Host {
    readonly options = APPLICANTS;
    readonly applicant = new FormControl<string | null>(null, [Validators.required]);
  }

  it('is a labelled radiogroup with one radio per option', async () => {
    await render(Host);
    expect(screen.getByRole('radiogroup', { name: 'Who is applying?' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('radio', { name: /Sole executor/ })).toHaveClass('mt-radio');
  });

  it('selects with the arrow keys and round-trips the form value', async () => {
    const { fixture } = await render(Host);
    await userEvent.click(screen.getByRole('radio', { name: /Sole executor/ }));
    expect(fixture.componentInstance.applicant.value).toBe('sole');

    await userEvent.keyboard('{ArrowDown}');
    expect(fixture.componentInstance.applicant.value).toBe('both');
    expect(screen.getByRole('radio', { name: 'Both executors' })).toHaveAttribute('data-checked');

    fixture.componentInstance.applicant.setValue('reserved');
    await fixture.whenStable();
    expect(screen.getByRole('radio', { name: 'Executor with power reserved' })).toHaveAttribute('aria-checked', 'true');
  });

  it('skips disabled options and shows the required error once touched', async () => {
    const { fixture } = await render(Host);
    expect(screen.getByRole('radio', { name: 'Administrator' })).toHaveAttribute('data-disabled');
    fixture.componentInstance.applicant.markAsTouched();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(screen.getByText('Fill in this field.')).toHaveClass('mt-error');
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');
  });

  it('disables every radio when the form control is disabled', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.applicant.disable();
    await fixture.whenStable();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveAttribute('data-disabled');
  });
});
