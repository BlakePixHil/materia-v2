import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { MtTextField } from './text-field';
import { MtStoryState } from '../../stories/story-state';
import { MtSearchField } from '../search-field/search-field';
import { MtTextarea } from '../textarea/textarea';

@Component({
  selector: 'mt-text-field-states',
  imports: [MtTextField, MtTextarea, MtSearchField, MtStoryState, ReactiveFormsModule],
  template: `
    <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; align-items: start">
      <mt-text-field
        label="Deceased's full name"
        placeholder="e.g. Margaret Anne Whitfield"
        description="As shown on the death certificate."
      />
      <mt-text-field
        label="Deceased's full name"
        description="As shown on the death certificate."
        [formControl]="filled"
        mtStoryState="hover"
        target=".mt-input"
      />
      <mt-text-field
        label="Deceased's full name"
        description="As shown on the death certificate."
        [formControl]="filled"
        mtStoryState="focus"
        target=".mt-input"
      />
      <mt-text-field
        label="Date of death"
        iconStart="calendar"
        [formControl]="invalid"
        [errorMessages]="{ pattern: 'That date doesn’t exist. Check the death certificate.' }"
      />
      <mt-text-field label="Estate value" suffix="AUD" description="Gross, before liabilities." [formControl]="value" />
      <mt-text-field label="Matter ref" description="Assigned when the matter is created." [formControl]="disabled" />
      <mt-text-field label="Middle name" optional size="sm" />
      <mt-search-field label="Search or jump to" placeholder="Search or jump to…" variant="global" shortcut="mod+k" />
      <mt-search-field label="Filter matters" placeholder="Filter matters…" />
    </div>
    <div style="width: 520px; margin-top: 24px">
      <mt-textarea label="File note" [maxLength]="500" [formControl]="note" />
    </div>
  `,
})
class TextFieldStates {
  protected readonly filled = new FormControl('Margaret Anne Whitfield');
  protected readonly invalid = new FormControl('31/02/2026', [Validators.pattern(/^(?!31\/02)/)]);
  protected readonly value = new FormControl('2,840,000');
  protected readonly disabled = new FormControl({ value: 'WE-142', disabled: true });
  protected readonly note = new FormControl(
    'Called the executor. She has the original will and the bank statements and will drop them in on Friday.',
  );

  constructor() {
    this.invalid.markAsTouched();
  }
}

const meta: Meta<MtTextField> = {
  title: 'Components/TextField',
  component: MtTextField,
  args: { label: 'Date of death', description: 'As shown on the death certificate.', placeholder: 'DD/MM/YYYY' },
};
export default meta;
type Story = StoryObj<MtTextField>;

export const Playground: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox', { name: 'Date of death' });
    await userEvent.type(input, '22/07/2026');
    await expect(input).toHaveValue('22/07/2026');
  },
};

export const States: Story = {
  render: () => ({ moduleMetadata: { imports: [TextFieldStates] }, template: '<mt-text-field-states />' }),
};

export const StatesDark: Story = { ...States, globals: { theme: 'dark' } };
