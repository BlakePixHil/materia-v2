import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { MtButton } from '../lib/button/button';
import { MtCheckbox } from '../lib/checkbox/checkbox';
import type { MtOption } from '../lib/forms/options';
import { MtRadioGroup } from '../lib/radio/radio-group';
import { MtSearchField } from '../lib/search-field/search-field';
import { MtSegmentedControl } from '../lib/segmented-control/segmented-control';
import { MtSelect } from '../lib/select/select';
import { MtSwitch } from '../lib/switch/switch';
import { MtTextField } from '../lib/text-field/text-field';
import { MtTextarea } from '../lib/textarea/textarea';

/**
 * Every FND-08 control in one Reactive Forms group. "Open matter" with empty fields marks the form
 * touched, so each control shows its validation error. Fictional data only.
 */
@Component({
  selector: 'mt-forms-demo',
  imports: [
    ReactiveFormsModule,
    MtButton,
    MtCheckbox,
    MtRadioGroup,
    MtSearchField,
    MtSegmentedControl,
    MtSelect,
    MtSwitch,
    MtTextField,
    MtTextarea,
  ],
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" class="mt-col" style="gap: 20px; max-width: 520px">
      <mt-search-field label="Find a contact" placeholder="Find a contact…" formControlName="search" />
      <mt-text-field
        label="Deceased's full name"
        description="As shown on the death certificate."
        formControlName="deceased"
        [errorMessages]="{ required: 'Enter the full name from the death certificate.' }"
      />
      <mt-text-field label="Executor's email" type="email" autocomplete="email" formControlName="email" />
      <mt-select label="Matter type" [options]="types" [native]="false" formControlName="type" />
      <mt-radio-group label="Who is applying?" [options]="applicants" formControlName="applicant" />
      <mt-segmented-control label="Fee arrangement" [options]="fees" formControlName="fee" />
      <mt-textarea label="Instructions" [maxLength]="300" formControlName="instructions" />
      <mt-checkbox label="Costs disclosure given" formControlName="disclosure" />
      <mt-switch label="Let Clerk suggest deadlines" formControlName="clerk" />
      <div class="mt-row">
        <button mtButton type="submit" variant="primary" [loading]="saving()">Open matter</button>
        <button mtButton variant="ghost" (click)="form.reset()">Reset</button>
      </div>
      <output class="body-s t-2">{{ status() }}</output>
    </form>
  `,
})
class FormsDemo {
  private readonly fb = inject(FormBuilder);
  protected readonly form = this.fb.group({
    search: [''],
    deceased: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    type: [null as string | null, Validators.required],
    applicant: [null as string | null, Validators.required],
    fee: ['fixed'],
    instructions: ['', [Validators.required, Validators.maxLength(300)]],
    disclosure: [false, Validators.requiredTrue],
    clerk: [true],
  });
  protected readonly saving = signal(false);
  protected readonly status = signal('');
  protected readonly types: MtOption[] = [
    { value: 'probate', label: 'Probate' },
    { value: 'loa', label: 'Letters of administration' },
    { value: 'will', label: 'Will and enduring documents' },
  ];
  protected readonly applicants: MtOption[] = [
    { value: 'sole', label: 'Sole executor' },
    { value: 'both', label: 'Both executors' },
  ];
  protected readonly fees: MtOption[] = [
    { value: 'fixed', label: 'Fixed' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'capped', label: 'Capped' },
  ];

  protected submit(): void {
    this.form.markAllAsTouched();
    this.status.set(this.form.valid ? 'Ready to open.' : 'Fix the highlighted fields.');
  }
}

const meta: Meta<FormsDemo> = {
  title: 'Components/Reactive forms demo',
  component: FormsDemo,
};
export default meta;
type Story = StoryObj<FormsDemo>;

export const Validation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open matter' }));
    await expect(await canvas.findByText('Enter the full name from the death certificate.')).toBeVisible();
    await expect(canvas.getAllByText('Fill in this field.').length).toBeGreaterThanOrEqual(3);
    await expect(canvas.getByText('Tick this box to continue.')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: "Deceased's full name" })).toHaveAttribute('aria-invalid', 'true');

    await userEvent.type(canvas.getByRole('textbox', { name: "Deceased's full name" }), 'Margaret Anne Whitfield');
    await expect(canvas.queryByText('Enter the full name from the death certificate.')).toBeNull();
  },
};

export const ValidationDark: Story = { ...Validation, globals: { theme: 'dark' } };
