import { Component } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtTextField } from './text-field';

describe('MtTextField', () => {
  @Component({
    imports: [MtTextField, ReactiveFormsModule],
    template: `<mt-text-field
      label="Deceased's full name"
      description="As shown on the death certificate."
      [formControl]="name"
      [errorMessages]="{ required: 'Enter the full name from the death certificate.' }"
    />`,
  })
  class ReactiveHost {
    readonly name = new FormControl('', { nonNullable: true, validators: [Validators.required] });
  }

  it('labels the input and links the helper text', async () => {
    await render(ReactiveHost);
    const input = screen.getByRole('textbox', { name: "Deceased's full name" });
    const help = screen.getByText('As shown on the death certificate.');
    expect(help).toHaveClass('mt-help');
    expect(input.getAttribute('aria-describedby')).toContain(help.id);
  });

  it('round-trips the value with a reactive form control', async () => {
    const { fixture } = await render(ReactiveHost);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'Margaret Anne Whitfield');
    expect(fixture.componentInstance.name.value).toBe('Margaret Anne Whitfield');

    fixture.componentInstance.name.setValue('Peter Hale');
    await fixture.whenStable();
    expect(input).toHaveValue('Peter Hale');
  });

  it('shows the validation error once touched, linked with aria-describedby and aria-invalid', async () => {
    const { fixture } = await render(ReactiveHost);
    const input = screen.getByRole('textbox');
    const control = () => input.closest('.mt-input');
    expect(control()).not.toHaveAttribute('data-invalid');
    expect(screen.queryByText('Enter the full name from the death certificate.')).toBeNull();

    await userEvent.click(input);
    await userEvent.tab();
    await fixture.whenStable();

    const error = screen.getByText('Enter the full name from the death certificate.');
    expect(error).toHaveClass('mt-error');
    expect(control()).toHaveAttribute('data-invalid');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    // The error replaces the helper text.
    expect(screen.queryByText('As shown on the death certificate.')).toBeNull();
  });

  it('shows the error after markAllAsTouched (submit) without a blur', async () => {
    const { fixture } = await render(ReactiveHost);
    fixture.componentInstance.name.markAsTouched();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(screen.getByText('Enter the full name from the death certificate.')).toBeInTheDocument();
  });

  it('renders data-disabled when the form control is disabled', async () => {
    const { fixture } = await render(ReactiveHost);
    fixture.componentInstance.name.disable();
    await fixture.whenStable();
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
    expect(input.closest('.mt-input')).toHaveAttribute('data-disabled');
  });

  it('uses the default copy for built-in validators', async () => {
    @Component({
      imports: [MtTextField, ReactiveFormsModule],
      template: `<mt-text-field label="Email" type="email" [formControl]="email" />`,
    })
    class EmailHost {
      readonly email = new FormControl('not-an-email', { validators: [Validators.email] });
    }
    const { fixture } = await render(EmailHost);
    fixture.componentInstance.email.markAsTouched();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(screen.getByText('Enter an email address, like name@example.com.')).toBeInTheDocument();
  });

  it('works with ngModel, shows the suffix and an explicit error', async () => {
    @Component({
      imports: [MtTextField, FormsModule],
      template: `<mt-text-field label="Estate value" suffix="AUD" error="Check the amount." [(ngModel)]="value" />`,
    })
    class ModelHost {
      value = '2840000';
    }
    const { fixture } = await render(ModelHost);
    await fixture.whenStable();
    const input = screen.getByRole('textbox', { name: 'Estate value' });
    expect(input).toHaveValue('2840000');
    expect(screen.getByText('AUD')).toHaveClass('suffix');
    expect(input.closest('.mt-input')).toHaveAttribute('data-invalid');
    await userEvent.clear(input);
    await userEvent.type(input, '12');
    expect(fixture.componentInstance.value).toBe('12');
  });

  it('marks the label optional and the input required', async () => {
    await render(`<mt-text-field label="Middle name" optional /><mt-text-field label="Surname" required />`, {
      imports: [MtTextField],
    });
    expect(screen.getByText('Optional')).toHaveClass('mt-opt');
    expect(screen.getByRole('textbox', { name: 'Surname' })).toHaveAttribute('aria-required', 'true');
  });
});
