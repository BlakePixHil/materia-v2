import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtCheckbox } from './checkbox';

describe('MtCheckbox', () => {
  @Component({
    imports: [MtCheckbox, ReactiveFormsModule],
    template: `<mt-checkbox
      label="Original will received"
      description="Held in safe custody since 2019"
      [formControl]="received"
    />`,
  })
  class Host {
    readonly received = new FormControl(false, { nonNullable: true, validators: [Validators.requiredTrue] });
  }

  it('is a labelled, described checkbox', async () => {
    await render(Host);
    const box = screen.getByRole('checkbox', { name: 'Original will received' });
    expect(box).toHaveClass('mt-check');
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(box).toHaveAccessibleDescription('Held in safe custody since 2019');
  });

  it('toggles with Space and by clicking the label, and round-trips the form value', async () => {
    const { fixture } = await render(Host);
    const box = screen.getByRole('checkbox');
    box.focus();
    await userEvent.keyboard(' ');
    expect(fixture.componentInstance.received.value).toBe(true);
    expect(box).toHaveAttribute('data-checked');

    await userEvent.click(screen.getByText('Original will received'));
    expect(fixture.componentInstance.received.value).toBe(false);

    fixture.componentInstance.received.setValue(true);
    await fixture.whenStable();
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the requiredTrue error once touched', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.received.markAsTouched();
    fixture.detectChanges();
    await fixture.whenStable();
    const box = screen.getByRole('checkbox');
    expect(screen.getByText('Tick this box to continue.')).toHaveClass('mt-error');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box.getAttribute('aria-describedby')).toContain(screen.getByText('Tick this box to continue.').id);
  });

  it('renders data-disabled when the form control is disabled', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.received.disable();
    await fixture.whenStable();
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-disabled');
    expect(screen.getByText('Original will received').closest('.mt-choice')).toHaveAttribute('data-disabled');
  });

  it('shows the mixed state and clears it when checked', async () => {
    await render(`<mt-checkbox label="All documents" [indeterminate]="true" />`, { imports: [MtCheckbox] });
    const box = screen.getByRole('checkbox', { name: 'All documents' });
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(box).toHaveAttribute('data-indeterminate');
    await userEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
  });
});
